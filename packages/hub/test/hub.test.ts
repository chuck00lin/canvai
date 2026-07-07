import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHubServer } from '../src/server.ts'

// old-dialect fixture: tabs, unspaced colons — style must survive agent edits
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
  '\t\t\t"height":60,',
  '\t\t\t"shape":"pill"',
  '\t\t}',
  '\t],',
  '\t"edges":[]',
  '}',
].join('\n') + '\n'

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'canvai-'))
  await mkdir(path.join(root, 'discuss'), { recursive: true })
  await writeFile(path.join(root, 'discuss', 'demo.canvas'), FIXTURE, 'utf8')
  const server = createHubServer(root)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-agent', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { root, client }
}

function textOf(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] }
  return (r.content ?? []).map((c) => c.text ?? '').join('\n')
}

describe('canvai hub over MCP', () => {
  it('drives the full agent loop: discover, focus, read, edit, verify', async () => {
    const { root, client } = await setup()

    // discover
    const list = await client.callTool({ name: 'list_boards', arguments: {} })
    expect(textOf(list)).toContain('discuss/demo.canvas — 1 nodes, 0 edges')

    // focus
    await client.callTool({ name: 'set_active_board', arguments: { board: 'discuss/demo.canvas' } })
    await stat(path.join(root, '.canvai', 'state.json')) // persisted
    const active = await client.callTool({ name: 'get_active_board', arguments: {} })
    expect(textOf(active)).toContain('board: discuss/demo.canvas')
    expect(textOf(active)).toContain('seed idea')

    // edit semantically, anchored — no coordinates anywhere
    const applied = await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { op: 'add_node', text: 'agent thought', anchor: 'cafe', ref: 'a' },
          { op: 'add_node', text: 'follow-up', anchor: '$a', dir: 'below', ref: 'b' },
          { op: 'connect', from: '$a', to: '$b', label: 'flows' },
        ],
      },
    })
    expect(textOf(applied)).toContain('added text node')
    expect(textOf(applied)).toContain('$a =')

    // dialect + unknown fields survived the agent's edit
    const raw = await readFile(path.join(root, 'discuss', 'demo.canvas'), 'utf8')
    expect(raw).toContain('"shape":"pill"')
    expect(raw).toContain('"text":"agent thought"')
    expect(raw.includes('": ')).toBe(false)
    expect(raw.startsWith('{\n\t"nodes":[')).toBe(true)

    // structure view reflects the edit
    const readBack = await client.callTool({ name: 'read_board', arguments: { mode: 'structure' } })
    expect(textOf(readBack)).toContain('3 nodes, 0 groups, 1 edges')
    expect(textOf(readBack)).toContain('"flows"')

    // full view is the raw board
    const full = await client.callTool({ name: 'read_board', arguments: { mode: 'full' } })
    expect(textOf(full)).toBe(raw)

    // layout runs and keeps the board parseable
    const layout = await client.callTool({ name: 'auto_layout', arguments: {} })
    expect(textOf(layout)).toContain('re-laid out')

    // new boards can be spun up for new topics
    await client.callTool({ name: 'create_board', arguments: { path: 'discuss/next-topic.canvas' } })
    const list2 = await client.callTool({ name: 'list_boards', arguments: {} })
    expect(textOf(list2)).toContain('discuss/next-topic.canvas — 0 nodes, 0 edges')
    expect(textOf(list2)).toContain('● discuss/demo.canvas')
  })

  it('surfaces correctable errors instead of corrupting boards', async () => {
    const { root, client } = await setup()
    await client.callTool({ name: 'set_active_board', arguments: { board: 'discuss/demo.canvas' } })
    const before = await readFile(path.join(root, 'discuss', 'demo.canvas'), 'utf8')
    const result = await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { op: 'add_node', text: 'will be rolled back' },
          { op: 'delete_node', id: 'zzzz' },
        ],
      },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('unknown node id')
    // batch is atomic: nothing was written
    expect(await readFile(path.join(root, 'discuss', 'demo.canvas'), 'utf8')).toBe(before)
  })

  it('refuses paths that escape the root', async () => {
    const { client } = await setup()
    const result = await client.callTool({ name: 'read_board', arguments: { board: '../outside.canvas' } })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('escapes the root')
  })
})
