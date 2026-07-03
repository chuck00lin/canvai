import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { parseCanvas, serializeCanvas } from '@pairsketch/canvas-kit'
import { startServe, type RunningServer } from '../src/serve.ts'

const FIXTURE = [
  '{',
  '\t"nodes":[',
  '\t\t{',
  '\t\t\t"id":"cafe000011112222",',
  '\t\t\t"type":"text",',
  '\t\t\t"text":"seed idea",',
  '\t\t\t"x":0,',
  '\t\t\t"y":0,',
  '\t\t\t"width":300,',
  '\t\t\t"height":60',
  '\t\t}',
  '\t],',
  '\t"edges":[]',
  '}',
].join('\n') + '\n'

let running: RunningServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'pairsketch-serve-'))
  await mkdir(path.join(root, 'discuss'), { recursive: true })
  await writeFile(path.join(root, 'discuss', 'demo.canvas'), FIXTURE, 'utf8')
  running = await startServe(root, { port: 0 })
  return { root, base: `http://127.0.0.1:${running.port}`, port: running.port }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await sleep(100)
  }
}

describe('pairsketch hub serve mode', () => {
  it('serves boards over REST and applies human mutations with pinning', async () => {
    const { root, base } = await setup()

    const list = (await (await fetch(`${base}/api/boards`)).json()) as {
      boards: { path: string }[]
      active: string | null
    }
    expect(list.boards.map((b) => b.path)).toEqual(['discuss/demo.canvas'])

    await fetch(`${base}/api/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board: 'discuss/demo.canvas' }),
    })

    // a human drag: absolute coordinates are allowed on this path
    const mutate = await fetch(`${base}/api/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        board: 'discuss/demo.canvas',
        changes: [{ kind: 'set_geometry', id: 'cafe000011112222', x: 400, y: 200 }],
      }),
    })
    expect(mutate.ok).toBe(true)

    const raw = await readFile(path.join(root, 'discuss', 'demo.canvas'), 'utf8')
    expect(raw).toContain('"x":400')
    expect(raw.includes('": ')).toBe(false) // dialect preserved through the human path too

    const board = (await (await fetch(`${base}/api/board?path=${encodeURIComponent('discuss/demo.canvas')}`)).json()) as {
      pinned: string[]
    }
    expect(board.pinned).toContain('cafe000011112222')
  })

  it('watcher turns external (Obsidian) edits into broadcasts, pins, and events', async () => {
    const { root, base, port } = await setup()

    const messages: { type: string; board?: string }[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    socket.on('message', (data) => messages.push(JSON.parse(String(data))))
    await new Promise<void>((resolve) => socket.once('open', () => resolve()))

    // simulate a human dragging a card in Obsidian: rewrite the file externally
    const file = path.join(root, 'discuss', 'demo.canvas')
    const { data, style } = parseCanvas(await readFile(file, 'utf8'))
    data.nodes![0]!.x = 999
    await writeFile(file, serializeCanvas(data, style), 'utf8')

    await until(() => messages.some((m) => m.type === 'board_changed' && m.board === 'discuss/demo.canvas'))

    const board = (await (await fetch(`${base}/api/board?path=${encodeURIComponent('discuss/demo.canvas')}`)).json()) as {
      pinned: string[]
    }
    expect(board.pinned).toContain('cafe000011112222')

    const events = (await (await fetch(`${base}/api/events`)).json()) as {
      events: { origin: string; kind: string }[]
    }
    expect(events.events.some((e) => e.origin === 'external' && e.kind === 'board_changed')).toBe(true)

    socket.close()
  })
})
