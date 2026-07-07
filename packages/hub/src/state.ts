import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Hub-local state, kept out of the boards themselves: `.canvai/state.json`
 * under the root. Recommend gitignoring `.canvai/` — it is per-checkout
 * working state (active board, pinned nodes), not content.
 *
 * This file is also the IPC between hub processes: the MCP server (spawned by
 * an agent harness) and the serve process (started by the human) coordinate
 * through it rather than through sockets — consistent with "files are the
 * source of truth".
 */

interface HubState {
  activeBoard?: string
  updatedAt?: string
  /** board -> node ids a human has arranged by hand (auto-layout avoids them) */
  pinned?: Record<string, string[]>
}

export function stateFile(root: string): string {
  return path.join(root, '.canvai', 'state.json')
}

async function readState(root: string): Promise<HubState> {
  try {
    return JSON.parse(await readFile(stateFile(root), 'utf8')) as HubState
  } catch {
    return {}
  }
}

async function writeState(root: string, state: HubState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  await mkdir(path.dirname(stateFile(root)), { recursive: true })
  await writeFile(stateFile(root), JSON.stringify(state, null, 2) + '\n', 'utf8')
}

export async function getActiveBoard(root: string): Promise<string | undefined> {
  return (await readState(root)).activeBoard
}

export async function setActiveBoard(root: string, board: string): Promise<void> {
  const state = await readState(root)
  state.activeBoard = board
  await writeState(root, state)
}

export async function getPinned(root: string, board: string): Promise<Set<string>> {
  const state = await readState(root)
  return new Set(state.pinned?.[board] ?? [])
}

export async function addPinned(root: string, board: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const state = await readState(root)
  state.pinned ??= {}
  const current = new Set(state.pinned[board] ?? [])
  for (const id of ids) current.add(id)
  state.pinned[board] = [...current].sort()
  await writeState(root, state)
}

export async function removePinned(root: string, board: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const state = await readState(root)
  if (!state.pinned?.[board]) return
  const drop = new Set(ids)
  state.pinned[board] = state.pinned[board].filter((id) => !drop.has(id))
  await writeState(root, state)
}
