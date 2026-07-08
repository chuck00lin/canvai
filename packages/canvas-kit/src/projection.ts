import type { CanvasData, CanvasNode } from './types.ts'
import { nodes, edges } from './types.ts'
import { aliasMap } from './ids.ts'
import { rectOf, contains, area } from './geometry.ts'
import { findRails, railLabel } from './rail.ts'

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
  const rails = findRails(data)
  const railGroupIds = new Set(rails.map((r) => r.group.id))
  const jointIds = new Set(rails.flatMap((r) => r.joints.map((j) => j.id)))
  const attachedIds = new Set(rails.flatMap((r) => [...r.cards.values()].flat().map((c) => c.id)))
  const groups = ns.filter((n) => n.type === 'group' && !railGroupIds.has(n.id))
  const cards = ns.filter((n) => n.type !== 'group' && !jointIds.has(n.id) && !attachedIds.has(n.id))
  // shaft and attach edges are rail internals — the rails section carries that information
  const visibleEdges = es.filter((e) => !jointIds.has(e.fromNode) && !jointIds.has(e.toNode))
  const alias = aliasMap(ns.map((n) => n.id))
  const a = (id: string) => alias.get(id) ?? id

  const lines: string[] = []
  const railCount = rails.length > 0 ? `, ${rails.length} rails` : ''
  lines.push(
    `board: ${boardName} — ${cards.length + attachedIds.size} nodes, ${groups.length} groups, ${visibleEdges.length} edges${railCount}`,
  )
  lines.push('(ids in [brackets] are unique prefixes; use them directly in apply_ops)')
  if (ns.some((n) => n.discuss === false)) {
    lines.push(
      '(⏸ marks cards opted OUT of the discussion — they still exist on the board, NOT deleted; read for context, do not act on or comment about them)',
    )
  }

  if (rails.length > 0) {
    lines.push('', 'rails: (ordered slots; attach/insert/reorder with rail ops, not coordinates)')
    for (const r of rails) {
      lines.push(`[${a(r.group.id)}] "${railLabel(r.group)}" (${r.orient}, ${r.joints.length} slots)`)
      r.joints.forEach((_, slot) => {
        const slotCards = r.cards.get(slot)
        const entry = slotCards ? slotCards.map((c) => `[${a(c.id)}] ${describe(c)}`).join(' | ') : '(empty)'
        lines.push(`  ${slot + 1}: ${entry}`)
      })
    }
  }

  if (groups.length > 0) {
    lines.push('', 'groups:')
    for (const g of groups) {
      const members = ns.filter((n) => n.id !== g.id && !jointIds.has(n.id) && contains(rectOf(g), rectOf(n)))
      lines.push(`[${a(g.id)}] "${g.label ?? ''}" — ${members.length} members`)
    }
  }

  if (cards.length > 0) {
    lines.push('', 'nodes:')
    for (const n of cards) {
      const home = smallestContainingGroup(n, groups)
      const where = home ? ` (in ${a(home.id)})` : ''
      const off = n.discuss === false ? ' ⏸' : ''
      lines.push(`[${a(n.id)}] ${n.type}${off}${where}: ${describe(n)}`)
    }
  }

  if (visibleEdges.length > 0) {
    lines.push('', 'edges:')
    for (const e of visibleEdges) {
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
