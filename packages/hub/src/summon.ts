import { spawn } from 'node:child_process'
import { appendChat, readChat } from './chat.ts'
import { readEvents } from './events.ts'
import { getActiveBoard } from './state.ts'

/**
 * The handoff: the human presses "hand to agent" (or sends a chat message)
 * and the hub spawns one agent turn. Context continuity comes from FILES —
 * the board, the event log, the chat log — not from a chat window's history,
 * so a freshly spawned turn picks up exactly where things stand.
 *
 * The default command targets Claude Code headless mode; any CLI that
 * accepts a prompt works via --agent-cmd "mytool {prompt}".
 */

export const DEFAULT_AGENT_CMD = 'claude -p --mcp-config .mcp.json --allowedTools mcp__pairsketch {prompt}'

export interface Summoner {
  readonly running: boolean
  handoff(note?: string): Promise<void>
}

export function createSummoner(
  root: string,
  options: { agentCmd?: string; timeoutMs?: number; onStatus?: (status: 'started' | 'done' | 'error') => void } = {},
): Summoner {
  const agentCmd = options.agentCmd ?? DEFAULT_AGENT_CMD
  const timeoutMs = options.timeoutMs ?? 300_000
  let running = false

  return {
    get running() {
      return running
    },
    async handoff(note?: string): Promise<void> {
      if (running) throw new Error('an agent turn is already running')
      running = true
      options.onStatus?.('started')
      try {
        const prompt = await buildPrompt(root, note)
        const argv = agentCmd.split(/\s+/).filter((t) => t !== '')
        const promptIndex = argv.indexOf('{prompt}')
        if (promptIndex >= 0) argv[promptIndex] = prompt
        else argv.push(prompt)

        const output = await run(argv, root, timeoutMs)
        if (output.trim() !== '') {
          // whatever the agent printed is its reply — even without MCP access
          await appendChat(root, { from: 'agent', text: output.trim() })
        }
        options.onStatus?.('done')
      } catch (error) {
        await appendChat(root, {
          from: 'agent',
          text: `⚠ handoff failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        options.onStatus?.('error')
      } finally {
        running = false
      }
    },
  }
}

async function buildPrompt(root: string, note?: string): Promise<string> {
  const [active, chat, events] = await Promise.all([getActiveBoard(root), readChat(root), readEvents(root)])
  const chatTail = chat
    .slice(-8)
    .map((m) => `${m.from}: ${m.text.length > 300 ? m.text.slice(0, 300) + '…' : m.text}`)
    .join('\n')
  const cursor = events.at(-1)?.id

  return [
    'You are summoned to a pairsketch board session (the human pressed "hand to agent").',
    `Repo root: ${root}`,
    active ? `Active board: ${active}` : 'No active board set.',
    cursor ? `Latest event cursor: ${cursor}` : 'No events yet.',
    note ? `The human's note: ${note}` : '',
    chatTail ? `Recent chat:\n${chatTail}` : '',
    '',
    'Use the pairsketch MCP tools. Token discipline:',
    '- start from events_since (your cursor is in the recent chat, or use the one above) and read_board in "structure" mode — do NOT read full boards unless you truly need exact text;',
    '- reply with post_chat for prose, apply_ops for anything structural/spatial;',
    '- keep it to one focused turn: respond to what changed, then stop.',
    'If MCP tools are unavailable, read .pairsketch/events.jsonl and the .canvas files directly, and reply by printing text (it will be relayed to the chat panel).',
    "Respond in the human's language.",
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function run(argv: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    if (!cmd) return reject(new Error('empty agent command'))
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => reject(new Error(`could not run "${cmd}": ${e.message}`)))
    child.on('close', (code, signal) => {
      if (signal) return reject(new Error(`agent turn killed (${signal}) — timeout is ${timeoutMs / 1000}s`))
      if (code !== 0) return reject(new Error(`agent exited ${code}: ${err.slice(0, 400) || out.slice(0, 400)}`))
      resolve(out)
    })
  })
}
