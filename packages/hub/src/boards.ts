import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  parseCanvas,
  serializeCanvas,
  nodes,
  edges,
  DEFAULT_STYLE,
  type CanvasData,
  type CanvasStyle,
} from '@canvai/canvas-kit'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage'])

export interface BoardInfo {
  /** repo-relative path, the board's id */
  path: string
  nodes: number
  edges: number
  mtimeMs: number
}

export async function listBoards(root: string): Promise<BoardInfo[]> {
  const found: string[] = []
  await walk(root, '', found)
  const infos: BoardInfo[] = []
  for (const rel of found.sort()) {
    try {
      const abs = path.join(root, rel)
      const [text, s] = await Promise.all([readFile(abs, 'utf8'), stat(abs)])
      const { data } = parseCanvas(text)
      infos.push({ path: rel, nodes: nodes(data).length, edges: edges(data).length, mtimeMs: s.mtimeMs })
    } catch {
      // unreadable or malformed board: skip rather than fail the listing
    }
  }
  return infos
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      await walk(root, path.join(rel, entry.name), out)
    } else if (entry.isFile() && entry.name.endsWith('.canvas')) {
      out.push(path.join(rel, entry.name))
    }
  }
}

/** Resolve a board reference safely inside the root; always returns an absolute path. */
export function boardAbsPath(root: string, rel: string): string {
  if (!rel.endsWith('.canvas')) throw new Error(`board paths end in .canvas (got "${rel}")`)
  const abs = path.resolve(root, rel)
  const rootAbs = path.resolve(root) + path.sep
  if (!abs.startsWith(rootAbs)) throw new Error(`board path escapes the root: "${rel}"`)
  return abs
}

export interface LoadedBoard {
  data: CanvasData
  style: CanvasStyle
}

export async function readBoard(root: string, rel: string): Promise<LoadedBoard> {
  const text = await readFile(boardAbsPath(root, rel), 'utf8')
  return parseCanvas(text)
}

export async function readBoardRaw(root: string, rel: string): Promise<string> {
  return readFile(boardAbsPath(root, rel), 'utf8')
}

/** Atomic write (temp file + rename) so Obsidian never sees a torn board. */
export async function writeBoard(root: string, rel: string, data: CanvasData, style: CanvasStyle): Promise<void> {
  const abs = boardAbsPath(root, rel)
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`)
  await writeFile(tmp, serializeCanvas(data, style), 'utf8')
  await rename(tmp, abs)
}

export async function createBoard(root: string, rel: string): Promise<void> {
  const abs = boardAbsPath(root, rel)
  try {
    await stat(abs)
    throw new Error(`board already exists: "${rel}"`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await mkdir(path.dirname(abs), { recursive: true })
  await writeBoard(root, rel, { nodes: [], edges: [] }, DEFAULT_STYLE)
}
