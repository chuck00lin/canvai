import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { diffBoards, isEmptyDiff, type CanvasData } from '@pairsketch/canvas-kit'
import { createBoard, listBoards, readBoard, readBoardRaw, writeBoard } from './boards.ts'
import { addPinned, getActiveBoard, getPinned, removePinned, setActiveBoard } from './state.ts'
import { appendEvent, readEventsSince, recentAgentWrite } from './events.ts'
import { appendChat, readChatSince } from './chat.ts'
import { createSummoner } from './summon.ts'
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
  /** command template for the handoff button, e.g. 'claude -p {prompt}' */
  agentCmd?: string
  /** kill a spawned handoff turn after this long (default 300 000 ms) */
  handoffTimeoutMs?: number
  /**
   * 'spawn' (default): the handoff button spawns a fresh agent turn.
   * 'signal': only broadcast handoff_requested over the WebSocket — for when
   * a long-running main session is attached (e.g. via a ws monitor) and
   * should answer with its full context instead of a stateless turn.
   */
  handoffMode?: 'spawn' | 'signal'
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
}

/** Any repo file (for file-node rendering): jailed to the root, no dot segments. */
function repoFilePath(root: string, rel: string): string {
  if (rel.split('/').some((segment) => segment.startsWith('.'))) {
    throw new Error('paths with dot segments are not served')
  }
  const abs = path.resolve(root, rel)
  const rootAbs = path.resolve(root) + path.sep
  if (!abs.startsWith(rootAbs)) throw new Error(`path escapes the root: "${rel}"`)
  return abs
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

  // state.json also carries pins, so it rewrites on every human geometry edit —
  // only broadcast active_changed when the active board actually changed,
  // or every pin rewrite yanks connected clients to the active board
  let lastActive: string | null | undefined
  void getActiveBoard(root).then((active) => {
    if (lastActive === undefined) lastActive = active ?? null
  })

  const watcher = watchRoot(root, (signal) => {
    if (signal.type === 'state') {
      void getActiveBoard(root).then((active) => {
        const value = active ?? null
        if (value === lastActive) return
        lastActive = value
        broadcast({ type: 'active_changed', active: value })
      })
      return
    }
    if (signal.type === 'chat') {
      broadcast({ type: 'chat_changed' })
      return
    }
    if (signal.board) void onCanvasChange(signal.board)
  })

  const summoner = createSummoner(root, {
    agentCmd: options.agentCmd,
    timeoutMs: options.handoffTimeoutMs,
    onStatus: (status) => broadcast({ type: 'handoff', status }),
  })

  // signal mode: the resident session (via its bridge) reports busy through
  // /api/agent-status — the summoner never runs, so it can't drive the
  // indicator. TTL guards against a crashed session pinning 思考中 forever.
  let signalBusy = false
  let signalBusyTimer: ReturnType<typeof setTimeout> | undefined
  const setSignalBusy = (busy: boolean) => {
    signalBusy = busy
    clearTimeout(signalBusyTimer)
    if (busy) signalBusyTimer = setTimeout(() => setSignalBusy(false), 20 * 60_000)
    broadcast({ type: 'handoff', status: busy ? 'started' : 'done' })
  }
  const agentBusy = () => summoner.running || signalBusy

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
      lastActive = body.board
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
      if (outcome.deletedIds.length > 0) await removePinned(root, body.board, outcome.deletedIds)
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
    if (pathname === '/api/chat' && req.method === 'GET') {
      const since = url.searchParams.get('since') ?? undefined
      return sendJson(res, 200, await readChatSince(root, since))
    }
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = (await readJson(req)) as { text?: string; board?: string }
      if (!body.text || body.text.trim() === '') return sendJson(res, 400, { error: 'missing "text"' })
      const message = await appendChat(root, { from: 'human', text: body.text.trim(), board: body.board })
      broadcast({ type: 'chat_changed' })
      return sendJson(res, 200, { ok: true, id: message.id })
    }
    if (pathname === '/api/agent-status' && req.method === 'POST') {
      const body = (await readJson(req)) as { busy?: boolean }
      if (typeof body.busy !== 'boolean') return sendJson(res, 400, { error: 'missing boolean "busy"' })
      setSignalBusy(body.busy)
      return sendJson(res, 200, { ok: true })
    }
    if (pathname === '/api/handoff' && req.method === 'POST') {
      const body = (await readJson(req)) as { note?: string }
      let note = body.note
      if (!note) {
        const { messages } = await readChatSince(root)
        note = messages.filter((m) => m.from === 'human').at(-1)?.text
      }
      broadcast({ type: 'handoff_requested', note: note ?? null })
      if ((options.handoffMode ?? 'spawn') === 'signal') {
        return sendJson(res, 202, { ok: true, mode: 'signal' })
      }
      if (summoner.running) return sendJson(res, 409, { error: 'an agent turn is already running' })
      void summoner.handoff(body.note)
      return sendJson(res, 202, { ok: true, mode: 'spawn' })
    }
    if (pathname === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('path')
      if (!rel) return sendJson(res, 400, { error: 'missing "path"' })
      let abs: string
      try {
        abs = repoFilePath(root, rel)
      } catch (e) {
        return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
      }
      let buffer: Buffer
      try {
        buffer = await readFile(abs)
      } catch {
        return sendJson(res, 404, { error: `not found: ${rel}` })
      }
      if (url.searchParams.get('raw') === '1') {
        res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' })
        return void res.end(buffer)
      }
      if (buffer.length > 512 * 1024) return sendJson(res, 413, { error: 'file too large to inline' })
      return sendJson(res, 200, { path: rel, text: buffer.toString('utf8') })
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
      const ext = path.extname(abs)
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        // hashed assets can cache forever; the shell must revalidate so new builds land on reload
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      })
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
      // busy: reconnecting clients missed handoff broadcasts while away —
      // without this a stale 思考中 indicator survives forever
      socket.send(JSON.stringify({ type: 'hello', active: active ?? null, busy: agentBusy() }))
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
