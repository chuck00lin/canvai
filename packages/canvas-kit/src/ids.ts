import { randomBytes } from 'node:crypto'
import type { CanvasData } from './types.ts'
import { nodes, edges } from './types.ts'

/** Obsidian-style canvas id: 16 lowercase hex chars. */
export function genId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Resolve a node/edge reference that may be a full id or an unambiguous
 * prefix (the structural projection shows 4-char prefixes). Throws on
 * unknown or ambiguous references so agents get a correctable error.
 */
export function resolveNodeId(data: CanvasData, ref: string): string {
  return resolveId(nodes(data).map((n) => n.id), ref, 'node')
}

export function resolveEdgeId(data: CanvasData, ref: string): string {
  return resolveId(edges(data).map((e) => e.id), ref, 'edge')
}

function resolveId(ids: string[], ref: string, kind: string): string {
  if (ids.includes(ref)) return ref
  const matches = ids.filter((id) => id.startsWith(ref))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new Error(`unknown ${kind} id: "${ref}"`)
  throw new Error(`ambiguous ${kind} id "${ref}" (matches ${matches.join(', ')})`)
}

/**
 * Shortest-unique-prefix aliases (min 4 chars) for display in projections.
 * Deterministic for a given board state, so agents can reuse them in ops.
 */
export function aliasMap(ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const id of ids) {
    let len = 4
    while (len < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, len)))) {
      len += 2
    }
    out.set(id, id.slice(0, len))
  }
  return out
}
