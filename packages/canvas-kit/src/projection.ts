import type { CanvasData, CanvasNode } from './types.ts'
import { nodes, edges } from './types.ts'
import { aliasMap } from './ids.ts'
import { rectOf, contains, area } from './geometry.ts'

/**
 * The coordinate-free view agents read by default. Costs roughly a third of
 * the raw JSON: no coordinates, no sizes, truncated card text, prefix ids.
 */
export interface Projection {
  text: string
  /** alias (short id prefix) -> full id */
  aliases: Record<string, string>
}

const TEXT_PREVIEW = 90

export function structuralProjection(data: CanvasData, boardName = 'canvas'): Projection {
  const ns = nodes(data)
  const es = edges(data)
  const groups = ns.filter((n) => n.type === 'group')
  const cards = ns.filter((n) => n.type !== 'group')
  const alias = aliasMap(ns.map((n) => n.id))
  const a = (id: string) => alias.get(id) ?? id

  const lines: string[] = []
  lines.push(`board: ${boardName} — ${cards.length} nodes, ${groups.length} groups, ${es.length} edges`)
  lines.push('(ids in [brackets] are unique prefixes; use them directly in apply_ops)')

  if (groups.length > 0) {
    lines.push('', 'groups:')
    for (const g of groups) {
      const members = ns.filter((n) => n.id !== g.id && contains(rectOf(g), rectOf(n)))
      lines.push(`[${a(g.id)}] "${g.label ?? ''}" — ${members.length} members`)
    }
  }

  if (cards.length > 0) {
    lines.push('', 'nodes:')
    for (const n of cards) {
      const home = smallestContainingGroup(n, groups)
      const where = home ? ` (in ${a(home.id)})` : ''
      lines.push(`[${a(n.id)}] ${n.type}${where}: ${describe(n)}`)
    }
  }

  if (es.length > 0) {
    lines.push('', 'edges:')
    for (const e of es) {
      const label = e.label ? ` "${e.label}"` : ''
      lines.push(`[${a(e.fromNode)}] -> [${a(e.toNode)}]${label}`)
    }
  }

  const aliases: Record<string, string> = {}
  for (const [id, short] of alias) aliases[short] = id
  return { text: lines.join('\n'), aliases }
}

export function smallestContainingGroup(node: CanvasNode, groups: CanvasNode[]): CanvasNode | undefined {
  let best: CanvasNode | undefined
  for (const g of groups) {
    if (g.id === node.id) continue
    if (!contains(rectOf(g), rectOf(node))) continue
    if (!best || area(rectOf(g)) < area(rectOf(best))) best = g
  }
  return best
}

function describe(n: CanvasNode): string {
  if (n.type === 'text') return oneLine(n.text ?? '')
  if (n.type === 'file') return (n.file ?? '') + (n.subpath ?? '')
  if (n.type === 'link') return n.url ?? ''
  return oneLine(String(n.text ?? n.label ?? ''))
}

function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return flat.length > TEXT_PREVIEW ? flat.slice(0, TEXT_PREVIEW) + '…' : flat
}
