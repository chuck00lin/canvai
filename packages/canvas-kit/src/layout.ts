import ELK from 'elkjs/lib/elk.bundled.js'
import type { CanvasData, CanvasNode } from './types.ts'
import { nodes, edges } from './types.ts'
import { rectOf, contains, bbox, overlaps } from './geometry.ts'

export interface LayoutOptions {
  direction?: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP'
  spacing?: number
  /**
   * Node ids a human has arranged by hand. Pinned blocks (and groups
   * containing a pinned member) do not move; the laid-out remainder is
   * shifted until it clears them.
   */
  pinned?: ReadonlySet<string>
}

/**
 * Full-board ELK layered layout. Groups are treated as opaque blocks: the
 * group moves, its members ride along with the same delta, so arrangements
 * humans made inside a group survive. Pinned blocks are excluded from the
 * layout entirely and the laid-out region slides until it clears them.
 */
export async function autoLayout(data: CanvasData, options: LayoutOptions = {}): Promise<void> {
  const ns = nodes(data)
  if (ns.length === 0) return
  const direction = options.direction ?? 'RIGHT'
  const spacing = options.spacing ?? 60

  const groups = ns.filter((n) => n.type === 'group')
  // top-level blocks: groups not nested in another group + nodes not inside any group
  const containerOf = (n: CanvasNode): CanvasNode | undefined => {
    let best: CanvasNode | undefined
    for (const g of groups) {
      if (g.id === n.id) continue
      if (!contains(rectOf(g), rectOf(n))) continue
      if (!best || g.width * g.height < best.width * best.height) best = g
    }
    return best
  }
  const blocks = ns.filter((n) => containerOf(n) === undefined)
  const blockOf = new Map<string, string>()
  for (const n of ns) {
    let current: CanvasNode = n
    const visited = new Set<string>([n.id])
    for (let next = containerOf(current); next && !visited.has(next.id); next = containerOf(current)) {
      visited.add(next.id)
      current = next
    }
    blockOf.set(n.id, current.id)
  }

  // a block is pinned when the human arranged it (or anything inside it) by hand
  const pinned = options.pinned ?? new Set<string>()
  const isPinnedBlock = (block: CanvasNode): boolean => {
    if (pinned.has(block.id)) return true
    if (block.type !== 'group') return false
    return ns.some((n) => n.id !== block.id && pinned.has(n.id) && contains(rectOf(block), rectOf(n)))
  }
  const freeBlocks = blocks.filter((b) => !isPinnedBlock(b))
  const pinnedRects = blocks.filter((b) => isPinnedBlock(b)).map(rectOf)
  if (freeBlocks.length === 0) return
  const freeIds = new Set(freeBlocks.map((b) => b.id))

  const elkEdges = []
  const seen = new Set<string>()
  for (const e of edges(data)) {
    const source = blockOf.get(e.fromNode)
    const target = blockOf.get(e.toNode)
    if (!source || !target || source === target) continue
    if (!freeIds.has(source) || !freeIds.has(target)) continue
    const key = `${source}->${target}`
    if (seen.has(key)) continue
    seen.add(key)
    elkEdges.push({ id: `e_${key}`, sources: [source], targets: [target] })
  }

  const elk = new ELK()
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.spacing.nodeNode': String(spacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing + 40),
    },
    children: freeBlocks.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: elkEdges,
  })

  // keep the board anchored where it was, so viewports don't jump
  const before = bbox(freeBlocks.map(rectOf))
  const placed = result.children ?? []
  const placedRect = (c: (typeof placed)[number]) => ({
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width ?? 0,
    height: c.height ?? 0,
  })
  const after = bbox(placed.map(placedRect))
  let offsetX = before.x - after.x
  let offsetY = before.y - after.y

  // slide the laid-out region down until it clears every pinned block
  for (let i = 0; i < 200; i++) {
    const collides = placed.some((c) =>
      pinnedRects.some((p) => overlaps({ ...placedRect(c), x: (c.x ?? 0) + offsetX, y: (c.y ?? 0) + offsetY }, p, spacing / 2)),
    )
    if (!collides) break
    offsetY += 48
  }

  for (const child of placed) {
    const block = ns.find((n) => n.id === child.id)
    if (!block) continue
    const dx = Math.round((child.x ?? 0) + offsetX - block.x)
    const dy = Math.round((child.y ?? 0) + offsetY - block.y)
    if (dx === 0 && dy === 0) continue
    // shift the block and everything geometrically inside it
    const inside = block.type === 'group' ? ns.filter((n) => n.id !== block.id && contains(rectOf(block), rectOf(n))) : []
    for (const n of [block, ...inside]) {
      n.x += dx
      n.y += dy
    }
  }
}
