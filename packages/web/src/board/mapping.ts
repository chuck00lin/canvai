import { MarkerType, type Edge as FlowEdge, type Node as FlowNode } from '@xyflow/react'
import type { CanvasData, CanvasNode } from '../api'

export interface PSData extends Record<string, unknown> {
  node: CanvasNode
  pinned: boolean
  /** railJoint only: a card is attached at this slot */
  occupied?: boolean
  /** railJoint only: highlighted as the live snap target during a drag */
  snap?: boolean
}

export type PSFlowNode = FlowNode<PSData>

/** Obsidian-flavored preset palette (spec leaves exact values to the app). */
export const CANVAS_COLORS: Record<string, string> = {
  '1': '#e93147',
  '2': '#ec7500',
  '3': '#e0ac00',
  '4': '#08b94e',
  '5': '#00bfbc',
  '6': '#7852ee',
}

export function colorOf(color?: string): string | undefined {
  if (!color) return undefined
  return CANVAS_COLORS[color] ?? color
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/**
 * Rail detection, mirroring canvas-kit/rail (which cannot be imported here —
 * see api.ts). A rail is a group whose label starts with RAIL_MARK holding
 * tiny empty "joint" text nodes; edges between a joint and a card (either
 * direction) are attachments.
 */
export const RAIL_MARK = '⇥'
const JOINT_MAX = 14

export interface RailView {
  id: string
  orient: 'h' | 'v'
  pitch: number
  /** slot order */
  joints: CanvasNode[]
  /** joint id -> card ids attached there */
  attached: Map<string, string[]>
}

export function isRailGroupNode(n: CanvasNode): boolean {
  return n.type === 'group' && (n.label ?? '').startsWith(RAIL_MARK)
}

function isJointNode(n: CanvasNode): boolean {
  return n.type === 'text' && n.width <= JOINT_MAX && n.height <= JOINT_MAX && !(n.text ?? '').trim()
}

export function detectRails(data: CanvasData): RailView[] {
  const all = data.nodes ?? []
  const byId = new Map(all.map((n) => [n.id, n]))
  const rails: RailView[] = []
  for (const g of all) {
    if (!isRailGroupNode(g)) continue
    const joints = all.filter((n) => n.id !== g.id && isJointNode(n) && contains(g, n))
    if (joints.length === 0) continue
    const dx = Math.max(...joints.map((j) => j.x)) - Math.min(...joints.map((j) => j.x))
    const dy = Math.max(...joints.map((j) => j.y)) - Math.min(...joints.map((j) => j.y))
    const orient: 'h' | 'v' = dx >= dy ? 'h' : 'v'
    joints.sort((a, b) => (orient === 'h' ? a.x - b.x : a.y - b.y))
    const gaps = joints.slice(1).map((j, i) => (orient === 'h' ? j.x - joints[i]!.x : j.y - joints[i]!.y))
    const pitch = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 160
    const jointIds = new Set(joints.map((j) => j.id))
    const attached = new Map<string, string[]>()
    for (const e of data.edges ?? []) {
      let jointId: string
      let cardId: string
      if (jointIds.has(e.toNode) && !jointIds.has(e.fromNode)) {
        jointId = e.toNode
        cardId = e.fromNode
      } else if (jointIds.has(e.fromNode) && !jointIds.has(e.toNode)) {
        jointId = e.fromNode
        cardId = e.toNode
      } else continue
      if (byId.get(cardId)?.type === 'group') continue
      attached.set(jointId, [...(attached.get(jointId) ?? []), cardId])
    }
    rails.push({ id: g.id, orient, pitch, joints, attached })
  }
  return rails
}

/**
 * JSON Canvas -> React Flow. Groups become parent nodes (top-level only) so
 * dragging a group carries its members, matching Obsidian's behavior; member
 * positions turn relative and are converted back on write.
 */
type Side = 'top' | 'right' | 'bottom' | 'left'
const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

function sideMid(n: Rect, s: Side): [number, number] {
  const { x, y, width: w, height: h } = n
  if (s === 'top') return [x + w / 2, y]
  if (s === 'right') return [x + w, y + h / 2]
  if (s === 'bottom') return [x + w / 2, y + h]
  return [x, y + h / 2] // left
}

// Agent-drawn edges (add_edge with no explicit sides) used to always exit
// right → enter left, which detours badly whenever cards aren't left-of-right.
// Instead pick the pair of sides whose midpoints are closest, so the edge
// takes the shortest natural route. Recomputed each render, so it stays
// optimal as cards are dragged. Human-drawn edges keep their handle sides.
function closestSides(a: Rect, b: Rect): { from: Side; to: Side } {
  let best: { from: Side; to: Side } = { from: 'right', to: 'left' }
  let min = Infinity
  for (const fs of SIDES) {
    const [ax, ay] = sideMid(a, fs)
    for (const ts of SIDES) {
      const [bx, by] = sideMid(b, ts)
      const d = (ax - bx) ** 2 + (ay - by) ** 2
      if (d < min) {
        min = d
        best = { from: fs, to: ts }
      }
    }
  }
  return best
}

export function toFlow(data: CanvasData, pinned: ReadonlySet<string>): { nodes: PSFlowNode[]; edges: FlowEdge[] } {
  const all = data.nodes ?? []
  const groups = all.filter((n) => n.type === 'group')
  const rails = detectRails(data)
  const railGroupIds = new Set(rails.map((r) => r.id))
  const jointIds = new Set(rails.flatMap((r) => r.joints.map((j) => j.id)))
  const occupiedJoints = new Set(rails.flatMap((r) => [...r.attached.keys()]))

  const containerOf = (node: CanvasNode): CanvasNode | undefined => {
    let best: CanvasNode | undefined
    for (const g of groups) {
      if (g.id === node.id) continue
      if (!contains(g, node)) continue
      if (!best || g.width * g.height < best.width * best.height) best = g
    }
    return best
  }

  const flowNodes: PSFlowNode[] = []
  for (const g of groups) {
    flowNodes.push({
      id: g.id,
      type: railGroupIds.has(g.id) ? 'railGroup' : 'group',
      position: { x: g.x, y: g.y },
      style: { width: g.width, height: g.height },
      zIndex: -10,
      data: { node: g, pinned: pinned.has(g.id) },
    })
  }
  for (const n of all) {
    if (n.type === 'group') continue
    const parent = containerOf(n)
    const joint = jointIds.has(n.id)
    flowNodes.push({
      id: n.id,
      type: joint ? 'railJoint' : n.type === 'file' || n.type === 'link' ? n.type : 'text',
      position: parent ? { x: n.x - parent.x, y: n.y - parent.y } : { x: n.x, y: n.y },
      ...(parent ? { parentId: parent.id } : {}),
      // the slot grid belongs to the rail: joints are not individually
      // draggable or selectable — drag the rail group instead
      ...(joint ? { draggable: false, selectable: false } : {}),
      style: { width: n.width, height: n.height },
      data: { node: n, pinned: pinned.has(n.id), ...(joint ? { occupied: occupiedJoints.has(n.id) } : {}) },
    })
  }

  const byId = new Map(all.map((n) => [n.id, n]))
  const flowEdges: FlowEdge[] = (data.edges ?? []).map((e) => {
    const shaft = jointIds.has(e.fromNode) && jointIds.has(e.toNode)
    const attach = !shaft && (jointIds.has(e.fromNode) || jointIds.has(e.toNode))
    const stroke = colorOf(e.color) ?? (shaft ? '#7a8194' : '#9aa0a6')
    let sourceHandle = e.fromSide as string | undefined
    let targetHandle = e.toSide as string | undefined
    // route by shortest sides when no side is declared (agent edges) — and
    // ALWAYS for attach edges: the card's hang position is the human's to
    // change, so stored sides go stale the moment they drag it
    if ((!sourceHandle && !targetHandle) || attach) {
      const s = byId.get(e.fromNode)
      const t = byId.get(e.toNode)
      if (s && t) {
        const cs = closestSides(s, t)
        sourceHandle = cs.from
        targetHandle = cs.to
      }
    }
    const ends = e as { fromEnd?: string; toEnd?: string }
    return {
      id: e.id,
      source: e.fromNode,
      target: e.toNode,
      sourceHandle: sourceHandle ?? 'right',
      targetHandle: targetHandle ?? 'left',
      ...(e.label ? { label: e.label } : {}),
      // rail plumbing draws as straight segments: a bezier S-curve into a
      // point-sized joint reads as noise
      ...(shaft || attach ? { type: 'straight' } : {}),
      // a short thin dashed line is a hopeless click target — fatten the
      // interactive band so the attach line can actually be selected/deleted
      ...(attach ? { interactionWidth: 28 } : {}),
      // spec defaults: arrowhead at the target unless toEnd says otherwise
      ...(ends.toEnd === 'none' ? {} : { markerEnd: { type: MarkerType.ArrowClosed, color: stroke } }),
      ...(ends.fromEnd === 'arrow' ? { markerStart: { type: MarkerType.ArrowClosed, color: stroke } } : {}),
      style: shaft
        ? { stroke, strokeWidth: 3.5 }
        : attach
          ? { stroke, strokeWidth: 1.4, strokeDasharray: '5 4', opacity: 0.85 }
          : { stroke, strokeWidth: 1.6 },
    }
  })

  return { nodes: flowNodes, edges: flowEdges }
}

/**
 * Live rail geometry from the CURRENT flow state (positions may differ from
 * the last-loaded board mid-drag) — what the snap logic measures against.
 */
export interface RailLookup {
  rails: { id: string; orient: 'h' | 'v'; pitch: number; joints: { id: string; cx: number; cy: number }[] }[]
  /** card id -> where it is attached */
  cardRail: Map<string, { railId: string; slot: number; jointId: string }>
}

export function buildRailLookup(flowNodes: PSFlowNode[], flowEdges: FlowEdge[]): RailLookup {
  const byId = new Map(flowNodes.map((n) => [n.id, n]))
  const byRail = new Map<string, PSFlowNode[]>()
  for (const n of flowNodes) {
    if (n.type !== 'railJoint' || !n.parentId) continue
    byRail.set(n.parentId, [...(byRail.get(n.parentId) ?? []), n])
  }
  const rails: RailLookup['rails'] = []
  const jointSlot = new Map<string, { railId: string; slot: number }>()
  for (const [railId, js] of byRail) {
    const pts = js.map((j) => {
      const a = absolutePosition(j, byId)
      return { id: j.id, cx: a.x + j.data.node.width / 2, cy: a.y + j.data.node.height / 2 }
    })
    const dx = Math.max(...pts.map((p) => p.cx)) - Math.min(...pts.map((p) => p.cx))
    const dy = Math.max(...pts.map((p) => p.cy)) - Math.min(...pts.map((p) => p.cy))
    const orient: 'h' | 'v' = dx >= dy ? 'h' : 'v'
    pts.sort((a, b) => (orient === 'h' ? a.cx - b.cx : a.cy - b.cy))
    const gaps = pts.slice(1).map((p, i) => (orient === 'h' ? p.cx - pts[i]!.cx : p.cy - pts[i]!.cy))
    const pitch = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 160
    rails.push({ id: railId, orient, pitch, joints: pts })
    pts.forEach((p, slot) => jointSlot.set(p.id, { railId, slot }))
  }
  const cardRail: RailLookup['cardRail'] = new Map()
  for (const e of flowEdges) {
    let jointId: string
    let cardId: string
    if (jointSlot.has(e.target) && !jointSlot.has(e.source)) {
      jointId = e.target
      cardId = e.source
    } else if (jointSlot.has(e.source) && !jointSlot.has(e.target)) {
      jointId = e.source
      cardId = e.target
    } else continue
    if (byId.get(cardId)?.type === 'railGroup' || byId.get(cardId)?.type === 'group') continue
    const js = jointSlot.get(jointId)!
    if (!cardRail.has(cardId)) cardRail.set(cardId, { railId: js.railId, slot: js.slot, jointId })
  }
  return { rails, cardRail }
}

/** Snap radii (flow px): attach within SNAP_IN of the shaft, release beyond SNAP_OUT. */
export const SNAP_IN = 60
export const SNAP_OUT = 120

export interface SnapTarget {
  railId: string
  /** 0-based; may equal joints.length = append past the end (the rail grows) */
  slot: number
  /** undefined for the virtual append slot */
  jointId?: string
}

/** Nearest slot a card center would attach to, or undefined when out of range. */
export function nearestSlot(lookup: RailLookup, cx: number, cy: number): SnapTarget | undefined {
  let best: (SnapTarget & { d: number }) | undefined
  for (const r of lookup.rails) {
    const first = r.joints[0]!
    const last = r.joints[r.joints.length - 1]!
    const along = r.orient === 'h' ? cx : cy
    const perp = r.orient === 'h' ? Math.abs(cy - first.cy) : Math.abs(cx - first.cx)
    if (perp > SNAP_IN) continue
    const start = r.orient === 'h' ? first.cx : first.cy
    const end = r.orient === 'h' ? last.cx : last.cy
    const slot = Math.min(Math.max(Math.round((along - start) / r.pitch), 0), r.joints.length)
    const slotCenter = start + slot * r.pitch
    if (Math.abs(along - slotCenter) > r.pitch * 0.75) continue
    if (along < start - r.pitch * 0.75 || along > end + r.pitch * 1.25) continue
    const d = perp + Math.abs(along - slotCenter)
    if (!best || d < best.d) {
      best = { railId: r.id, slot, jointId: r.joints[slot]?.id, d }
    }
  }
  return best
}

/** React Flow position (possibly parent-relative) -> absolute board coordinates. */
export function absolutePosition(
  node: Pick<PSFlowNode, 'position' | 'parentId'>,
  byId: Map<string, PSFlowNode>,
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  for (let i = 0; parentId && i < 10; i++) {
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}
