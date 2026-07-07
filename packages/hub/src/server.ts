import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  applyOps,
  autoLayout,
  structuralProjection,
  type CanvasData,
  type Op,
} from '@canvai/canvas-kit'
import { createBoard, listBoards, readBoard, readBoardRaw, writeBoard } from './boards.ts'
import { getActiveBoard, getPinned, removePinned, setActiveBoard } from './state.ts'
import { appendEvent, readEventsSince, type HubEvent } from './events.ts'
import { appendChat, readChatSince } from './chat.ts'

const dirEnum = z.enum(['right', 'below', 'left', 'above'])

const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_node'),
    type: z.enum(['text', 'file', 'link']).optional().describe('default: text'),
    text: z.string().optional().describe('markdown; ```mermaid fences render in clients'),
    file: z.string().optional().describe('repo-relative path, for type=file'),
    url: z.string().optional().describe('for type=link'),
    color: z.string().optional().describe('canvas color: preset "1"-"6" or "#RRGGBB"'),
    width: z.number().optional(),
    height: z.number().optional(),
    anchor: z.string().optional().describe('place next to this node (id/prefix or "$ref")'),
    dir: dirEnum.optional().describe('side of the anchor, default right'),
    in_group: z.string().optional().describe('place inside this group node'),
    ref: z.string().optional().describe('name the node; later ops may reference "$<ref>"'),
  }),
  z.object({
    op: z.literal('add_group'),
    label: z.string(),
    around: z.array(z.string()).optional().describe('existing nodes to wrap'),
    color: z.string().optional(),
    ref: z.string().optional(),
  }),
  z.object({
    op: z.literal('update_node'),
    id: z.string(),
    text: z.string().optional(),
    color: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    file: z.string().optional(),
    url: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({ op: z.literal('delete_node'), id: z.string() }),
  z.object({
    op: z.literal('connect'),
    from: z.string(),
    to: z.string(),
    label: z.string().optional(),
    color: z.string().optional(),
  }),
  z.object({ op: z.literal('disconnect'), from: z.string(), to: z.string() }),
  z.object({
    op: z.literal('move'),
    id: z.string(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    anchor: z.string().optional(),
    dir: dirEnum.optional(),
  }),
])

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] })
const fail = (e: unknown): ToolResult => ({
  content: [{ type: 'text', text: `error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
})

/**
 * A human dragging one card produces a burst of near-identical events;
 * collapse consecutive runs (same origin/board/first summary word + node)
 * into one line with a ×count — pure token savings for agents.
 */
function coalesceEvents(events: HubEvent[]): { event: HubEvent; count: number }[] {
  const out: { event: HubEvent; count: number; key: string }[] = []
  for (const event of events) {
    const summary = Array.isArray(event.detail?.summary) ? (event.detail.summary as string[]) : []
    const key =
      summary.length === 1 ? `${event.origin}|${event.board}|${event.kind}|${summary[0]}` : `unique|${event.id}`
    const last = out.at(-1)
    if (last && last.key === key) last.count += 1
    else out.push({ event, count: 1, key })
  }
  return out
}

function formatEvent(event: HubEvent): string {
  const time = event.ts.slice(11, 19)
  const board = event.board ? ` ${event.board}` : ''
  let detail = ''
  if (event.detail) {
    const parts = Object.entries(event.detail).map(([key, value]) =>
      Array.isArray(value) ? `${key}: ${value.length <= 4 ? value.join(', ') : value.length}` : `${key}: ${String(value)}`,
    )
    if (parts.length > 0) detail = ` — ${parts.join('; ')}`
  }
  return `[${event.origin}] ${time} ${event.kind}${board}${detail}`
}

export function createHubServer(root: string): McpServer {
  const server = new McpServer({ name: 'canvai-hub', version: '0.1.0' })

  const resolveBoard = async (board?: string): Promise<string> => {
    if (board) return board
    const active = await getActiveBoard(root)
    if (active) return active
    throw new Error('no active board — pass "board" or call set_active_board first (list_boards shows candidates)')
  }

  server.registerTool(
    'list_boards',
    {
      title: 'List boards',
      description:
        'List every .canvas discussion board under the root (repo), with node/edge counts and which board is active.',
      inputSchema: {},
    },
    async () => {
      try {
        const [boards, active] = await Promise.all([listBoards(root), getActiveBoard(root)])
        if (boards.length === 0) return text('no boards found — create one with create_board (e.g. "discuss/topic.canvas")')
        const lines = boards.map(
          (b) => `${b.path === active ? '● ' : '  '}${b.path} — ${b.nodes} nodes, ${b.edges} edges`,
        )
        lines.push('', active ? `active: ${active}` : 'active: (none set)')
        return text(lines.join('\n'))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'create_board',
    {
      title: 'Create board',
      description: 'Create a new empty .canvas board at a repo-relative path (directories are created as needed).',
      inputSchema: { path: z.string().describe('e.g. "discuss/architecture.canvas"') },
    },
    async ({ path: rel }) => {
      try {
        await createBoard(root, rel)
        await appendEvent(root, { origin: 'agent', kind: 'board_created', board: rel })
        return text(`created ${rel}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'set_active_board',
    {
      title: 'Set active board',
      description: 'Mark a board as the active discussion focus for this repo (humans and agents share this pointer).',
      inputSchema: { board: z.string() },
    },
    async ({ board }) => {
      try {
        await readBoardRaw(root, board) // verify it exists
        await setActiveBoard(root, board)
        await appendEvent(root, { origin: 'agent', kind: 'active_changed', board })
        return text(`active board: ${board}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'get_active_board',
    {
      title: 'Get active board',
      description:
        'The board the human currently has in focus, with its structural projection (coordinate-free view). Start here.',
      inputSchema: {},
    },
    async () => {
      try {
        const active = await getActiveBoard(root)
        if (!active) {
          const boards = await listBoards(root)
          if (boards.length === 0) return text('no boards yet — create_board to start one')
          const fallback = boards.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
          const { data } = await readBoard(root, fallback.path)
          return text(
            `no active board set; showing most recently modified as fallback\n\n${structuralProjection(data, fallback.path).text}`,
          )
        }
        const { data } = await readBoard(root, active)
        return text(structuralProjection(data, active).text)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'read_board',
    {
      title: 'Read board',
      description:
        'Read a board. mode "structure" (default) is the token-cheap coordinate-free view; "full" is the raw JSON Canvas.',
      inputSchema: {
        board: z.string().optional().describe('defaults to the active board'),
        mode: z.enum(['structure', 'full']).optional(),
      },
    },
    async ({ board, mode }) => {
      try {
        const rel = await resolveBoard(board)
        if (mode === 'full') return text(await readBoardRaw(root, rel))
        const { data } = await readBoard(root, rel)
        return text(structuralProjection(data, rel).text)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'apply_ops',
    {
      title: 'Apply semantic operations',
      description:
        'Edit a board with semantic ops (add_node/add_group/update_node/delete_node/connect/disconnect/move). ' +
        'Positions are computed for you — anchor new nodes to existing ones instead of thinking in pixels. ' +
        'The batch is atomic: all ops apply or none do.',
      inputSchema: {
        board: z.string().optional().describe('defaults to the active board'),
        ops: z.array(opSchema).min(1),
      },
    },
    async ({ board, ops }) => {
      try {
        const rel = await resolveBoard(board)
        const { data, style } = await readBoard(root, rel)
        const working = structuredClone(data) as CanvasData
        const result = applyOps(working, ops as Op[])
        await writeBoard(root, rel, working, style)
        if (result.deleted.length > 0) await removePinned(root, rel, result.deleted)
        await appendEvent(root, { origin: 'agent', kind: 'ops_applied', board: rel, detail: { summary: result.summary } })
        const created = Object.entries(result.created)
          .filter(([k]) => !/^\$\d+$/.test(k))
          .map(([k, v]) => `${k} = ${v}`)
        const lines = [...result.summary]
        if (created.length > 0) lines.push('refs: ' + created.join(', '))
        return text(lines.join('\n'))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'auto_layout',
    {
      title: 'Auto-layout board',
      description:
        'Run ELK layered layout over the board. Human-arranged (pinned) nodes do not move — the rest flows around ' +
        'them; groups move as blocks. Use after larger edits; prefer anchors for small additions.',
      inputSchema: {
        board: z.string().optional(),
        direction: z.enum(['RIGHT', 'DOWN', 'LEFT', 'UP']).optional(),
      },
    },
    async ({ board, direction }) => {
      try {
        const rel = await resolveBoard(board)
        const { data, style } = await readBoard(root, rel)
        const working = structuredClone(data) as CanvasData
        const pinned = await getPinned(root, rel)
        await autoLayout(working, { direction, pinned })
        await writeBoard(root, rel, working, style)
        await appendEvent(root, { origin: 'agent', kind: 'layout', board: rel })
        return text(`re-laid out ${rel}${pinned.size > 0 ? ` (respected ${pinned.size} pinned nodes)` : ''}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'events_since',
    {
      title: 'Events since cursor',
      description:
        'What happened on the boards since your last sync: human edits from the web client, Obsidian edits spotted ' +
        'by the watcher, and other agents. Pass the cursor from your previous call; omit it for the recent history.',
      inputSchema: { cursor: z.string().optional() },
    },
    async ({ cursor }) => {
      try {
        const { events, cursor: next } = await readEventsSince(root, cursor)
        if (events.length === 0) return text(cursor ? `no new events\ncursor: ${cursor}` : 'no events yet')
        const lines = coalesceEvents(events).map(({ event, count }) => formatEvent(event) + (count > 1 ? ` ×${count}` : ''))
        lines.push(`cursor: ${next}`)
        return text(lines.join('\n'))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'post_chat',
    {
      title: 'Post to chat',
      description:
        'Reply in the text side-channel (the chat panel next to the board). Use this for prose — not every reply ' +
        'deserves a card. Use apply_ops when the reply is structural or spatial.',
      inputSchema: { text: z.string().min(1), board: z.string().optional() },
    },
    async ({ text: message, board }) => {
      try {
        await appendChat(root, { from: 'agent', text: message, board })
        return text('posted')
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'read_chat',
    {
      title: 'Read chat',
      description: 'Read the text side-channel. Pass the cursor from your previous call to get only new messages.',
      inputSchema: { since: z.string().optional() },
    },
    async ({ since }) => {
      try {
        const { messages, cursor } = await readChatSince(root, since)
        if (messages.length === 0) return text(since ? `no new messages\ncursor: ${since}` : 'no messages yet')
        const lines = messages.map((m) => `${m.from} (${m.ts.slice(11, 16)}): ${m.text}`)
        lines.push(`cursor: ${cursor}`)
        return text(lines.join('\n'))
      } catch (e) {
        return fail(e)
      }
    },
  )

  return server
}
