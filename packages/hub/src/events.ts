import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/**
 * Append-only event log at `.pairsketch/events.jsonl`. Both hub processes
 * write to it: the serve process logs what humans did (web edits, Obsidian
 * edits spotted by the watcher), the MCP process logs what agents did.
 * Agents replay it through the `events_since` tool; the watcher reads the
 * tail to tell agent-caused file changes from human ones.
 */

export type EventOrigin = 'agent' | 'human' | 'external'

export interface HubEvent {
  id: string
  ts: string
  origin: EventOrigin
  kind: string
  board?: string
  detail?: Record<string, unknown>
}

let seq = 0

function eventsFile(root: string): string {
  return path.join(root, '.pairsketch', 'events.jsonl')
}

export async function appendEvent(
  root: string,
  event: { origin: EventOrigin; kind: string; board?: string; detail?: Record<string, unknown> },
): Promise<HubEvent> {
  seq += 1
  const full: HubEvent = {
    id: `${Date.now()}-${process.pid}-${seq}`,
    ts: new Date().toISOString(),
    ...event,
  }
  await mkdir(path.dirname(eventsFile(root)), { recursive: true })
  await appendFile(eventsFile(root), JSON.stringify(full) + '\n', 'utf8')
  return full
}

export async function readEvents(root: string): Promise<HubEvent[]> {
  try {
    const text = await readFile(eventsFile(root), 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as HubEvent)
  } catch {
    return []
  }
}

export async function readEventsSince(
  root: string,
  cursor?: string,
  limit = 100,
): Promise<{ events: HubEvent[]; cursor?: string }> {
  const all = await readEvents(root)
  let start = 0
  if (cursor) {
    const index = all.findIndex((e) => e.id === cursor)
    start = index >= 0 ? index + 1 : 0
  }
  const events = all.slice(start).slice(-limit)
  return { events, cursor: events.at(-1)?.id ?? cursor }
}

/** Did an agent write this board within the window? (watcher heuristic) */
export async function recentAgentWrite(root: string, board: string, windowMs = 3000): Promise<boolean> {
  const all = await readEvents(root)
  const now = Date.now()
  for (const event of all.slice(-50)) {
    if (event.origin !== 'agent' || event.board !== board) continue
    if (now - Date.parse(event.ts) <= windowMs) return true
  }
  return false
}
