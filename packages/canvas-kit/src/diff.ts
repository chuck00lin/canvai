import type { CanvasData } from './types.ts'
import { nodes, edges } from './types.ts'

/**
 * Structural diff between two board states. The hub's watcher uses this to
 * classify what a human (or Obsidian) just did to a file: moved nodes get
 * pinned, everything becomes an event agents can query via events_since.
 */
export interface BoardDiff {
  addedNodes: string[]
  removedNodes: string[]
  /** x/y changed */
  movedNodes: string[]
  /** width/height changed */
  resizedNodes: string[]
  /** text/color/label/file/url changed */
  editedNodes: string[]
  addedEdges: string[]
  removedEdges: string[]
}

export function diffBoards(before: CanvasData, after: CanvasData): BoardDiff {
  const prev = new Map(nodes(before).map((n) => [n.id, n]))
  const next = new Map(nodes(after).map((n) => [n.id, n]))
  const diff: BoardDiff = {
    addedNodes: [],
    removedNodes: [],
    movedNodes: [],
    resizedNodes: [],
    editedNodes: [],
    addedEdges: [],
    removedEdges: [],
  }

  for (const [id, node] of next) {
    const old = prev.get(id)
    if (!old) {
      diff.addedNodes.push(id)
      continue
    }
    if (old.x !== node.x || old.y !== node.y) diff.movedNodes.push(id)
    if (old.width !== node.width || old.height !== node.height) diff.resizedNodes.push(id)
    if (
      old.text !== node.text ||
      old.color !== node.color ||
      old.label !== node.label ||
      old.file !== node.file ||
      old.url !== node.url
    ) {
      diff.editedNodes.push(id)
    }
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) diff.removedNodes.push(id)
  }

  const prevEdges = new Set(edges(before).map((e) => e.id))
  const nextEdges = new Set(edges(after).map((e) => e.id))
  for (const id of nextEdges) if (!prevEdges.has(id)) diff.addedEdges.push(id)
  for (const id of prevEdges) if (!nextEdges.has(id)) diff.removedEdges.push(id)

  return diff
}

export function isEmptyDiff(diff: BoardDiff): boolean {
  return Object.values(diff).every((list) => list.length === 0)
}
