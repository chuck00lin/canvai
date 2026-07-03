import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Hub-local state, kept out of the boards themselves: `.pairsketch/state.json`
 * under the root. Recommend gitignoring `.pairsketch/` — it is per-checkout
 * working state (which board the human currently has active), not content.
 */

interface HubState {
  activeBoard?: string
  updatedAt?: string
}

function stateFile(root: string): string {
  return path.join(root, '.pairsketch', 'state.json')
}

async function readState(root: string): Promise<HubState> {
  try {
    return JSON.parse(await readFile(stateFile(root), 'utf8')) as HubState
  } catch {
    return {}
  }
}

export async function getActiveBoard(root: string): Promise<string | undefined> {
  return (await readState(root)).activeBoard
}

export async function setActiveBoard(root: string, board: string): Promise<void> {
  const state = await readState(root)
  state.activeBoard = board
  state.updatedAt = new Date().toISOString()
  await mkdir(path.dirname(stateFile(root)), { recursive: true })
  await writeFile(stateFile(root), JSON.stringify(state, null, 2) + '\n', 'utf8')
}
