import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import WebSocket from 'ws'
import { startServe, type RunningServer } from '../src/serve.ts'
import { createHubServer } from '../src/server.ts'

const FIXTURE = '{\n\t"nodes":[],\n\t"edges":[]\n}\n'

let running: RunningServer | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

async function setup(agentCmd?: string, handoffMode?: 'spawn' | 'signal') {
  const root = await mkdtemp(path.join(tmpdir(), 'canvai-chat-'))
  await mkdir(path.join(root, 'discuss'), { recursive: true })
  await writeFile(path.join(root, 'discuss', 'demo.canvas'), FIXTURE, 'utf8')
  running = await startServe(root, { port: 0, agentCmd, handoffMode })
  return { root, base: `http://127.0.0.1:${running.port}`, port: running.port }
}

async function until(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await sleep(100)
  }
}

describe('chat side-channel', () => {
  it('round-trips between the human REST path and the agent MCP path', async () => {
    const { root, base } = await setup()

    await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '哈囉，看得到嗎' }),
    })

    // the agent lives in a different process; same files, own MCP server
    const mcp = createHubServer(root)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-agent', version: '0.0.0' })
    await Promise.all([client.connect(ct), mcp.connect(st)])

    const read = await client.callTool({ name: 'read_chat', arguments: {} })
    const readText = (read as { content: { text?: string }[] }).content[0]?.text ?? ''
    expect(readText).toContain('哈囉，看得到嗎')
    expect(readText).toContain('cursor:')

    await client.callTool({ name: 'post_chat', arguments: { text: '看得到，這是 agent 的回覆' } })

    const list = (await (await fetch(`${base}/api/chat`)).json()) as { messages: { from: string; text: string }[] }
    expect(list.messages).toHaveLength(2)
    expect(list.messages[1]).toMatchObject({ from: 'agent', text: '看得到，這是 agent 的回覆' })
  })

  it('handoff spawns the agent command, passes a context prompt, and relays stdout to chat', async () => {
    const probeRoot = await mkdtemp(path.join(tmpdir(), 'canvai-probe-'))
    const script = path.join(probeRoot, 'fake-agent.mjs')
    await writeFile(
      script,
      "import { writeFileSync } from 'node:fs'\nwriteFileSync('received-prompt.txt', process.argv[2] ?? '')\nconsole.log('agent-reply-ok')\n",
      'utf8',
    )

    const { root, base } = await setup(`node ${script} {prompt}`)

    await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '請看一下板子' }),
    })
    const response = await fetch(`${base}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: '重點在右上角' }),
    })
    expect(response.status).toBe(202)

    await until(async () => {
      const list = (await (await fetch(`${base}/api/chat`)).json()) as { messages: { from: string; text: string }[] }
      return list.messages.some((m) => m.from === 'agent' && m.text === 'agent-reply-ok')
    })

    // the spawned turn got a real context prompt (cwd = root)
    const prompt = await readFile(path.join(root, 'received-prompt.txt'), 'utf8')
    expect(prompt).toContain('summoned')
    expect(prompt).toContain('請看一下板子')
    expect(prompt).toContain('重點在右上角')
    expect(prompt).toContain('events_since')
  })

  it('default mode (no {prompt} placeholder) pipes the prompt via stdin', async () => {
    const probeRoot = await mkdtemp(path.join(tmpdir(), 'canvai-probe-'))
    const script = path.join(probeRoot, 'stdin-agent.mjs')
    await writeFile(
      script,
      [
        "import { writeFileSync } from 'node:fs'",
        "let input = ''",
        "process.stdin.setEncoding('utf8')",
        'for await (const chunk of process.stdin) input += chunk',
        "writeFileSync('received-stdin.txt', input)",
        "console.log('stdin-agent-ok')",
        '',
      ].join('\n'),
      'utf8',
    )

    const { root, base } = await setup(`node ${script}`)
    await fetch(`${base}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    await until(async () => {
      const list = (await (await fetch(`${base}/api/chat`)).json()) as { messages: { text: string }[] }
      return list.messages.some((m) => m.text === 'stdin-agent-ok')
    })
    const prompt = await readFile(path.join(root, 'received-stdin.txt'), 'utf8')
    expect(prompt).toContain('summoned')
    expect(prompt).toContain('Token discipline')
  })

  it('signal mode broadcasts handoff_requested to the main session instead of spawning', async () => {
    const { base, port } = await setup(undefined, 'signal')

    const frames: { type: string; note?: string | null }[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    socket.on('message', (data) => frames.push(JSON.parse(String(data))))
    await new Promise<void>((resolve) => socket.once('open', () => resolve()))

    await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '我在板上改了東西，來看看' }),
    })
    const response = await fetch(`${base}/api/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(((await response.json()) as { mode: string }).mode).toBe('signal')

    await until(async () => frames.some((f) => f.type === 'handoff_requested'))
    const signal = frames.find((f) => f.type === 'handoff_requested')!
    expect(signal.note).toContain('我在板上改了東西')

    // no agent was spawned: chat still only has the human message
    await sleep(300)
    const list = (await (await fetch(`${base}/api/chat`)).json()) as { messages: { from: string }[] }
    expect(list.messages.every((m) => m.from === 'human')).toBe(true)

    socket.close()
  })
})
