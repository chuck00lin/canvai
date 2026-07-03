import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { diffBoards, isEmptyDiff, type CanvasData } from '@pairsketch/canvas-kit'
import { createBoard, listBoards, readBoard, readBoardRaw, writeBoard } from './boards.ts'
import { addPinned, getActiveBoard, getPinned, setActiveBoard } from './state.ts'
import { appendEvent, readEventsSince, recentAgentWrite } from './events.ts'
import { applyMutations, type Mutation } from './mutate.ts'
import { watchRoot } from './watch.ts'

/**
 * The serve process: what a human runs (`pairsketch-hub serve`). Serves the
 * web client, a small REST API, and a WebSocket that pushes "something
 * changed" signals. Agents connect through the separate MCP stdio process;
 * the two processes coordinate purely through files (.canvas, state.json,
 * events.jsonl) — if either is down, the other still works.
 */

export interface ServeOptions {
  port?: number
  /** default 127.0.0.1; set 0.0.0.0 (with a token!) to reach it over a VPN/LAN */
  host?: string
  /** when set, /api/* and /ws require `Authorization: Bearer <token>` or `?token=` */
  token?: string
  webDist?: string
}

export interface RunningServer {
  port: number
  close(): Promise<void>
}

const SELF_WRITE_WINDOW_MS = 2000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
}

export async function startServe(root: string, options: ServeOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1'
  const webDist = path.resolve(
    options.webDist ?? path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web', 'dist'),
  )

  const snapshots = new Map<string, CanvasData>()
  const selfWrites = new Map<string, number>()
  const markSelfWrite = (board: string) => selfWrites.set(board, Date.now())
  const wasSelfWrite = (board: string) => Date.now() - (selfWrites.get(board) ?? 0) <= SELF_WRITE_WINDOW_MS

  for (const board of await listBoards(root)) {
    try {
      snapshots.set(board.path, (await readBoard(root, board.path)).data)
    } catch {
      // unreadable board: watcher will retry on next change
    }
  }

  const wssClients = new Set<WebSocket>()
  const broadcast = (message: unknown) => {
    const payload = JSON.stringify(message)
    for (const client of wssClients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  const onCanvasChange = async (board: string) => {
    let data: CanvasData | undefined
    try {
      data = (await readBoard(root, board)).data
    } catch {
      data = undefined
    }
    if (!data) {
      if (snapshots.delete(board)) {
        await appendEvent(root, { origin: 'external', kind: 'board_removed', board })
        broadcast({ type: 'boards_changed' })
      }
      return
    }
    const before = snapshots.get(board)
    snapshots.set(board, data)
    if (wasSelfWrite(board)) {
      broadcast({ type: 'board_changed', board })
      return
    }
    if (!before) {
      await appendEvent(root, { origin: 'external', kind: 'board_created', board })
      broadcast({ type: 'boards_changed' })
      broadcast({ type: 'board_changed', board })
      return
    }
    const diff = diffBoards(before, data)
    if (isEmptyDiff(diff)) return
    if (await recentAgentWrite(root, board)) {
      // the agent already logged its own event; just push the signal
      broadcast({ type: 'board_changed', board })
      return
    }
    // a human edited outside the web client (Obsidian, editor): moved nodes get pinned
    if (diff.movedNodes.length > 0) await addPinned(root, board, diff.movedNodes)
    await appendEvent(root, {
      origin: 'external',
      kind: 'board_changed',
      board,
      detail: Object.fromEntries(Object.entries(diff).filter(([, ids]) => (ids as string[]).length > 0)),
    })
    broadcast({ type: 'board_changed', board })
  }

  const watcher = watchRoot(root, (signal) => {
    if (signal.type === 'state') {
      void getActiveBoard(root).then((active) => broadcast({ type: 'active_changed', active: active ?? null }))
      return
    }
    if (signal.board) void onCanvasChange(signal.board)
  })

  const server: Server = createServer((req, res) => {
    void route(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!options.token) return true
    if (req.headers.authorization === `Bearer ${options.token}`) return true
    return url.searchParams.get('token') === options.token
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const { pathname } = url

    if (pathname.startsWith('/api') && !authorized(req, url)) {
      return sendJson(res, 401, { error: 'unauthorized — pass ?token= or an Authorization: Bearer header' })
    }

    if (pathname === '/api/boards' && req.method === 'GET') {
      const [boards, active] = await Promise.all([listBoards(root), getActiveBoard(root)])
      return sendJson(res, 200, { boards, active: active ?? null })
    }
    if (pathname === '/api/boards' && req.method === 'POST') {
      const body = (await readJson(req)) as { path?: string }
      if (!body.path) return sendJson(res, 400, { error: 'missing "path"' })
      await createBoard(root, body.path)
      snapshots.set(body.path, (await readBoard(root, body.path)).data)
      markSelfWrite(body.path)
      await appendEvent(root, { origin: 'human', kind: 'board_created', board: body.path })
      broadcast({ type: 'boards_changed' })
      return sendJson(res, 200, { ok: true })
    }
    if (pathname === '/api/board' && req.method === 'GET') {
      const board = url.searchParams.get('path')
      if (!board) return sendJson(res, 400, { error: 'missing "path"' })
      const { data } = await readBoard(root, board)
      const pinned = await getPinned(root, board)
      return sendJson(res, 200, { path: board, data, pinned: [...pinned] })
    }
    if (pathname === '/api/active' && req.method === 'POST') {
      const body = (await readJson(req)) as { board?: string }
      if (!body.board) return sendJson(res, 400, { error: 'missing "board"' })
      await readBoardRaw(root, body.board) // must exist
      await setActiveBoard(root, body.board)
      await appendEvent(root, { origin: 'human', kind: 'active_changed', board: body.board })
      broadcast({ type: 'active_changed', active: body.board })
      return sendJson(res, 200, { ok: true })
    }
    if (pathname === '/api/mutate' && req.method === 'POST') {
      const body = (await readJson(req)) as { board?: string; changes?: Mutation[] }
      if (!body.board || !Array.isArray(body.changes) || body.changes.length === 0) {
        return sendJson(res, 400, { error: 'need "board" and non-empty "changes"' })
      }
      const { data, style } = await readBoard(root, body.board)
      const working = structuredClone(data) as CanvasData
      const outcome = applyMutations(working, body.changes)
      markSelfWrite(body.board)
      await writeBoard(root, body.board, working, style)
      snapshots.set(body.board, working)
      if (outcome.movedIds.length > 0) await addPinned(root, body.board, outcome.movedIds)
      await appendEvent(root, {
        origin: 'human',
        kind: 'mutate',
        board: body.board,
        detail: { summary: outcome.summary },
      })
      broadcast({ type: 'board_changed', board: body.board })
      return sendJson(res, 200, { ok: true, summary: outcome.summary })
    }
    if (pathname === '/api/events' && req.method === 'GET') {
      const since = url.searchParams.get('since') ?? undefined
      return sendJson(res, 200, await readEventsSince(root, since))
    }

    if (req.method === 'GET') return serveStatic(pathname, res)
    sendJson(res, 404, { error: 'not found' })
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const abs = path.resolve(webDist, rel)
    if (abs !== webDist && !abs.startsWith(webDist + path.sep)) {
      return sendJson(res, 404, { error: 'not found' })
    }
    try {
      const file = await readFile(abs)
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream' })
      res.end(file)
    } catch {
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<!doctype html><meta charset="utf-8"><title>pairsketch</title>' +
            '<body style="font-family:system-ui;padding:3rem;max-width:40rem">' +
            '<h1>pairsketch hub is running</h1>' +
            '<p>The web client is not built yet. Run <code>npm run web:build</code> in the pairsketch repo, then reload.</p>' +
            '<p>The API is live: <a href="/api/boards">/api/boards</a></p>',
        )
        return
      }
      sendJson(res, 404, { error: 'not found' })
    }
  }

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (socket, req) => {
    if (!authorized(req, new URL(req.url ?? '/', 'http://localhost'))) {
      socket.close(4401, 'unauthorized')
      return
    }
    wssClients.add(socket)
    socket.on('close', () => wssClients.delete(socket))
    void (async () => {
      const active = await getActiveBoard(root)
      socket.send(JSON.stringify({ type: 'hello', active: active ?? null }))
    })()
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 5199, host, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 5199)

  return {
    port,
    async close() {
      watcher.close()
      for (const client of wssClients) client.terminate()
      wss.close()
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    },
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 5 * 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}
