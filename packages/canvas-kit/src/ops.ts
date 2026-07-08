import type { CanvasData, CanvasNode, CanvasEdge, Side } from './types.ts'
import { nodes, edges } from './types.ts'
import { genId, resolveNodeId } from './ids.ts'
import { rectOf, overlaps, contains, bbox, type Rect } from './geometry.ts'
import { smallestContainingGroup } from './projection.ts'
import {
  attachCard,
  createRail,
  defaultPitch,
  detachCard,
  extendRail,
  isRailGroup,
  railInfo,
  railJointIds,
  railLabel,
  reorderCard,
  setRailPitch,
  shiftRailCards,
  JOINT_SIZE,
  type RailAttach,
  type RailOrient,
} from './rail.ts'

/**
 * Semantic operations — the only write path agents get. Nothing here takes
 * absolute coordinates (design D4): placement is anchor-relative and the
 * hub's auto_layout does the rest.
 */

export const GAP = 60
const STACK_GAP = 24
const COLLISION_MARGIN = 12
/** vertical/horizontal room a rail reserves per attach side for its cards */
const CARD_ZONE = 220

export type Dir = 'right' | 'below' | 'left' | 'above'

export interface AddNodeOp {
  op: 'add_node'
  /** default "text" */
  type?: 'text' | 'file' | 'link'
  text?: string
  file?: string
  url?: string
  color?: string
  width?: number
  height?: number
  /** place next to this node (id/prefix, or "$ref" from an earlier op in this batch) */
  anchor?: string
  /** which side of the anchor; default "right" */
  dir?: Dir
  /** place inside this group (expands the group when needed) */
  in_group?: string
  /** name the new node so later ops in this batch can reference it as "$<ref>" */
  ref?: string
}

export interface AddGroupOp {
  op: 'add_group'
  label: string
  /** wrap these existing nodes; the group is sized to fit them */
  around?: string[]
  color?: string
  ref?: string
}

export interface UpdateNodeOp {
  op: 'update_node'
  id: string
  text?: string
  color?: string
  width?: number
  height?: number
  file?: string
  url?: string
  label?: string
}

export interface DeleteNodeOp {
  op: 'delete_node'
  id: string
}

export interface ConnectOp {
  op: 'connect'
  from: string
  to: string
  label?: string
  color?: string
  /** arrowhead placement; default "to" (JSON Canvas default) */
  arrows?: 'to' | 'none' | 'from' | 'both'
}

export interface DisconnectOp {
  op: 'disconnect'
  from: string
  to: string
}

export interface MoveOp {
  op: 'move'
  id: string
  dx?: number
  dy?: number
  /** alternative to dx/dy: re-place next to another node */
  anchor?: string
  dir?: Dir
}

export interface AddRailOp {
  op: 'add_rail'
  /** default "h" */
  orient?: RailOrient
  /** default 5 */
  slots?: number
  /** default 160 for attach "both", 340 for a single side */
  pitch?: number
  /** which side(s) of the shaft cards attach to; default "both" (alternating) */
  attach?: RailAttach
  label?: string
  anchor?: string
  dir?: Dir
  ref?: string
}

export interface AttachToRailOp {
  op: 'attach_to_rail'
  rail: string
  /** attach this existing card... */
  card?: string
  /** ...or create a new text card and attach it */
  text?: string
  color?: string
  width?: number
  height?: number
  /** 1-based; an occupied slot means "insert here" (later cards shift toward the tail); omit for first free slot */
  slot?: number
  ref?: string
}

export interface RailDetachOp {
  op: 'rail_detach'
  rail: string
  card: string
}

export interface RailReorderOp {
  op: 'rail_reorder'
  rail: string
  card: string
  /** 1-based destination (insert semantics) */
  slot: number
}

export interface ExtendRailOp {
  op: 'extend_rail'
  rail: string
  /** default 1 */
  add?: number
}

export interface SetRailOp {
  op: 'set_rail'
  rail: string
  pitch: number
}

export interface PinOp {
  op: 'pin'
  id: string
}

export interface UnpinOp {
  op: 'unpin'
  id: string
}

export type Op =
  | AddNodeOp
  | AddGroupOp
  | UpdateNodeOp
  | DeleteNodeOp
  | ConnectOp
  | DisconnectOp
  | MoveOp
  | AddRailOp
  | AttachToRailOp
  | RailDetachOp
  | RailReorderOp
  | ExtendRailOp
  | SetRailOp
  | PinOp
  | UnpinOp

export interface OpsResult {
  summary: string[]
  /** "$ref" and "$<n>" names -> full ids of nodes created in this batch */
  created: Record<string, string>
  /** node ids removed by delete_node — callers should prune pins etc. */
  deleted: string[]
  /** node ids pinned/unpinned by pin/unpin ops — callers persist these */
  pins: string[]
  unpins: string[]
}

/** Applies ops in order, mutating `data`. Throws on the first invalid op. */
export function applyOps(data: CanvasData, ops: Op[]): OpsResult {
  if (!data.nodes) data.nodes = []
  if (!data.edges) data.edges = []
  const created: Record<string, string> = {}
  const summary: string[] = []
  const deleted: string[] = []
  const pins: string[] = []
  const unpins: string[] = []
  let counter = 0

  const resolve = (ref: string): string => {
    if (ref.startsWith('$')) {
      const id = created[ref]
      if (!id) throw new Error(`unknown batch reference "${ref}"`)
      return id
    }
    return resolveNodeId(data, ref)
  }
  const remember = (id: string, ref?: string) => {
    counter += 1
    created[`$${counter}`] = id
    if (ref) created[`$${ref}`] = id
  }

  for (const op of ops) {
    switch (op.op) {
      case 'add_node': {
        const type = op.type ?? 'text'
        if (type === 'text' && op.text === undefined) throw new Error('add_node: text nodes need "text"')
        if (type === 'file' && !op.file) throw new Error('add_node: file nodes need "file"')
        if (type === 'link' && !op.url) throw new Error('add_node: link nodes need "url"')
        const size = {
          width: op.width ?? defaultSize(type, op.text).width,
          height: op.height ?? defaultSize(type, op.text).height,
        }
        const group = op.in_group ? mustBeGroup(data, resolve(op.in_group)) : undefined
        const anchorRect = op.anchor ? rectOf(mustGet(data, resolve(op.anchor))) : undefined
        const pos = place(data, size, { anchorRect, dir: op.dir ?? 'right', group })
        const node: CanvasNode = {
          id: genId(),
          type,
          ...(op.text !== undefined ? { text: op.text } : {}),
          ...(op.file !== undefined ? { file: op.file } : {}),
          ...(op.url !== undefined ? { url: op.url } : {}),
          x: pos.x,
          y: pos.y,
          width: size.width,
          height: size.height,
          ...(op.color ? { color: op.color } : {}),
        }
        data.nodes.push(node)
        if (group) expandGroupToFit(group, rectOf(node))
        remember(node.id, op.ref)
        summary.push(`added ${type} node ${node.id}`)
        break
      }
      case 'add_group': {
        const memberIds = (op.around ?? []).map(resolve)
        const members = memberIds.map((id) => mustGet(data, id))
        let rect: Rect
        if (members.length > 0) {
          const inner = bbox(members.map(rectOf))
          rect = { x: inner.x - 40, y: inner.y - 70, width: inner.width + 80, height: inner.height + 110 }
        } else {
          const size = { width: 480, height: 320 }
          rect = { ...place(data, size, {}), ...size }
        }
        const node: CanvasNode = {
          id: genId(),
          type: 'group',
          label: op.label,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          ...(op.color ? { color: op.color } : {}),
        }
        data.nodes.push(node)
        remember(node.id, op.ref)
        summary.push(`added group ${node.id} "${op.label}" around ${members.length} nodes`)
        break
      }
      case 'update_node': {
        const node = mustGet(data, resolve(op.id))
        const patch: Record<string, unknown> = {}
        for (const key of ['text', 'color', 'width', 'height', 'file', 'url', 'label'] as const) {
          if (op[key] !== undefined) patch[key] = op[key]
        }
        Object.assign(node, patch)
        summary.push(`updated ${node.id}`)
        break
      }
      case 'delete_node': {
        const id = resolve(op.id)
        const node = mustGet(data, id)
        // deleting a rail takes its joints along — orphaned dots are junk
        const drop = new Set([id, ...railJointIds(data, node)])
        data.nodes = data.nodes.filter((n) => !drop.has(n.id))
        const before = data.edges.length
        data.edges = data.edges.filter((e) => !drop.has(e.fromNode) && !drop.has(e.toNode))
        deleted.push(...drop)
        summary.push(`deleted ${id} (+${before - data.edges.length} edges)`)
        break
      }
      case 'connect': {
        const from = mustGet(data, resolve(op.from))
        const to = mustGet(data, resolve(op.to))
        const sides = autoSides(rectOf(from), rectOf(to))
        const arrows = op.arrows ?? 'to'
        const edge: CanvasEdge = {
          id: genId(),
          fromNode: from.id,
          fromSide: sides.fromSide,
          toNode: to.id,
          toSide: sides.toSide,
          ...(arrows === 'none' || arrows === 'from' ? { toEnd: 'none' as const } : {}),
          ...(arrows === 'from' || arrows === 'both' ? { fromEnd: 'arrow' as const } : {}),
          ...(op.color ? { color: op.color } : {}),
          ...(op.label ? { label: op.label } : {}),
        }
        data.edges.push(edge)
        summary.push(`connected ${from.id} -> ${to.id}`)
        break
      }
      case 'disconnect': {
        const from = resolve(op.from)
        const to = resolve(op.to)
        const before = data.edges.length
        data.edges = data.edges.filter((e) => !(e.fromNode === from && e.toNode === to))
        if (data.edges.length === before) throw new Error(`no edge ${op.from} -> ${op.to}`)
        summary.push(`disconnected ${from} -> ${to} (${before - data.edges.length} edges)`)
        break
      }
      case 'move': {
        const node = mustGet(data, resolve(op.id))
        let dx: number
        let dy: number
        if (op.anchor) {
          const anchorRect = rectOf(mustGet(data, resolve(op.anchor)))
          const pos = place(data, rectOf(node), { anchorRect, dir: op.dir ?? 'right', ignore: node.id })
          dx = pos.x - node.x
          dy = pos.y - node.y
        } else {
          dx = op.dx ?? 0
          dy = op.dy ?? 0
        }
        const moved = shiftWithMembers(data, node, dx, dy)
        if (isRailGroup(node)) shiftRailCards(data, railInfo(data, node), dx, dy, moved)
        summary.push(`moved ${node.id} by (${dx}, ${dy})`)
        break
      }
      case 'add_rail': {
        const attach = op.attach ?? 'both'
        const orient = op.orient ?? 'h'
        const slots = op.slots ?? 5
        const pitch = op.pitch ?? defaultPitch(attach)
        // footprint reserves the card zones so later attachments don't land on existing nodes
        const zone = CARD_ZONE
        const shaftW = orient === 'h' ? (slots - 1) * pitch + JOINT_SIZE : JOINT_SIZE
        const shaftH = orient === 'v' ? (slots - 1) * pitch + JOINT_SIZE : JOINT_SIZE
        const before = attach === 'both' || attach === 'above' || attach === 'left'
        const after = attach === 'both' || attach === 'below' || attach === 'right'
        const size =
          orient === 'h'
            ? { width: shaftW, height: shaftH + (before ? zone : 0) + (after ? zone : 0) }
            : { width: shaftW + (before ? zone : 0) + (after ? zone : 0), height: shaftH }
        const anchorRect = op.anchor ? rectOf(mustGet(data, resolve(op.anchor))) : undefined
        const pos = place(data, size, { anchorRect, dir: op.dir ?? 'below' })
        const origin =
          orient === 'h' ? { x: pos.x, y: pos.y + (before ? zone : 0) } : { x: pos.x + (before ? zone : 0), y: pos.y }
        const rail = createRail(data, { orient, slots, pitch, attach, label: op.label ?? '', origin })
        remember(rail.group.id, op.ref)
        summary.push(`added rail ${rail.group.id} "${railLabel(rail.group)}" (${orient}, ${slots} slots)`)
        break
      }
      case 'attach_to_rail': {
        const rail = mustBeRail(data, resolve(op.rail))
        if ((op.card === undefined) === (op.text === undefined))
          throw new Error('attach_to_rail: pass exactly one of "card" (existing) or "text" (new card)')
        let card: CanvasNode
        if (op.card !== undefined) {
          card = mustGet(data, resolve(op.card))
          if (card.type === 'group') throw new Error('attach_to_rail: groups cannot attach to a rail')
        } else {
          const size = {
            width: op.width ?? defaultSize('text', op.text).width,
            height: op.height ?? defaultSize('text', op.text).height,
          }
          card = { id: genId(), type: 'text', text: op.text!, x: 0, y: 0, ...size, ...(op.color ? { color: op.color } : {}) }
          data.nodes.push(card)
          remember(card.id, op.ref)
        }
        if (op.slot !== undefined && op.slot < 1) throw new Error('attach_to_rail: "slot" is 1-based')
        const slot = attachCard(data, rail, card, op.slot === undefined ? undefined : op.slot - 1)
        summary.push(`attached ${card.id} to rail ${rail.group.id} slot ${slot + 1}`)
        break
      }
      case 'rail_detach': {
        const rail = mustBeRail(data, resolve(op.rail))
        const card = mustGet(data, resolve(op.card))
        detachCard(data, rail, card)
        summary.push(`detached ${card.id} from rail ${rail.group.id}`)
        break
      }
      case 'rail_reorder': {
        const rail = mustBeRail(data, resolve(op.rail))
        const card = mustGet(data, resolve(op.card))
        if (op.slot < 1) throw new Error('rail_reorder: "slot" is 1-based')
        reorderCard(data, rail, card, op.slot - 1)
        summary.push(`moved ${card.id} to rail ${rail.group.id} slot ${op.slot}`)
        break
      }
      case 'extend_rail': {
        const rail = mustBeRail(data, resolve(op.rail))
        const add = op.add ?? 1
        extendRail(data, rail, add)
        summary.push(`extended rail ${rail.group.id} to ${rail.joints.length} slots`)
        break
      }
      case 'set_rail': {
        const rail = mustBeRail(data, resolve(op.rail))
        setRailPitch(data, rail, op.pitch)
        summary.push(`rail ${rail.group.id} pitch -> ${op.pitch}`)
        break
      }
      case 'pin': {
        const id = resolve(op.id)
        mustGet(data, id)
        pins.push(id)
        summary.push(`pinned ${id}`)
        break
      }
      case 'unpin': {
        const id = resolve(op.id)
        unpins.push(id)
        summary.push(`unpinned ${id}`)
        break
      }
      default:
        throw new Error(`unknown op: ${JSON.stringify(op satisfies never)}`)
    }
  }
  return { summary, created, deleted, pins, unpins }
}

function mustGet(data: CanvasData, id: string): CanvasNode {
  const node = nodes(data).find((n) => n.id === id)
  if (!node) throw new Error(`unknown node id: "${id}"`)
  return node
}

function mustBeGroup(data: CanvasData, id: string): CanvasNode {
  const node = mustGet(data, id)
  if (node.type !== 'group') throw new Error(`node ${id} is not a group`)
  return node
}

function mustBeRail(data: CanvasData, id: string) {
  const node = mustGet(data, id)
  if (!isRailGroup(node)) throw new Error(`node ${id} is not a rail (add one with add_rail)`)
  return railInfo(data, node)
}

function defaultSize(type: string, text?: string): { width: number; height: number } {
  if (type === 'file') return { width: 360, height: 160 }
  if (type === 'link') return { width: 360, height: 120 }
  const width = 300
  let lines = 0
  for (const raw of (text ?? '').split('\n')) lines += Math.max(1, Math.ceil(raw.length / 24))
  return { width, height: Math.min(Math.max(40 + lines * 26, 60), 560) }
}

interface PlaceOpts {
  anchorRect?: Rect
  dir?: Dir
  group?: CanvasNode
  ignore?: string
}

/** Find a free spot: next to the anchor, inside the group, or below the board. */
function place(data: CanvasData, size: { width: number; height: number }, opts: PlaceOpts): { x: number; y: number } {
  const obstacles = nodes(data)
    .filter((n) => n.type !== 'group' && n.id !== opts.ignore)
    .map(rectOf)
  const dir = opts.dir ?? 'right'

  let candidate: Rect
  if (opts.anchorRect) {
    candidate = besides(opts.anchorRect, dir, size)
  } else if (opts.group) {
    const g = rectOf(opts.group)
    const members = nodes(data).filter(
      (n) => n.id !== opts.group!.id && n.id !== opts.ignore && contains(g, rectOf(n)),
    )
    const startY = members.length > 0 ? Math.max(...members.map((m) => m.y + m.height)) + STACK_GAP : g.y + 70
    candidate = { x: g.x + 40, y: startY, ...size }
  } else if (obstacles.length > 0) {
    const board = bbox(obstacles)
    candidate = { x: board.x, y: board.y + board.height + GAP, ...size }
  } else {
    candidate = { x: 0, y: 0, ...size }
  }

  // stack away from collisions: vertically for left/right placement, horizontally for above/below
  const stackVertical = dir === 'right' || dir === 'left' || !opts.anchorRect
  for (let i = 0; i < 200; i++) {
    const hit = obstacles.some((r) => overlaps(candidate, r, COLLISION_MARGIN))
    if (!hit) break
    if (stackVertical) candidate = { ...candidate, y: candidate.y + size.height + STACK_GAP }
    else candidate = { ...candidate, x: candidate.x + size.width + STACK_GAP }
  }
  return { x: Math.round(candidate.x), y: Math.round(candidate.y) }
}

function besides(anchor: Rect, dir: Dir, size: { width: number; height: number }): Rect {
  switch (dir) {
    case 'right':
      return { x: anchor.x + anchor.width + GAP, y: anchor.y, ...size }
    case 'left':
      return { x: anchor.x - GAP - size.width, y: anchor.y, ...size }
    case 'below':
      return { x: anchor.x, y: anchor.y + anchor.height + GAP, ...size }
    case 'above':
      return { x: anchor.x, y: anchor.y - GAP - size.height, ...size }
  }
}

function expandGroupToFit(group: CanvasNode, inner: Rect): void {
  const pad = 40
  const right = Math.max(group.x + group.width, inner.x + inner.width + pad)
  const bottom = Math.max(group.y + group.height, inner.y + inner.height + pad)
  group.width = right - group.x
  group.height = bottom - group.y
}

/** Moving a group takes its geometric members along, like Obsidian does. Returns the moved ids. */
function shiftWithMembers(data: CanvasData, node: CanvasNode, dx: number, dy: number): Set<string> {
  const targets = new Set<string>([node.id])
  if (node.type === 'group') {
    const g = rectOf(node)
    for (const n of nodes(data)) {
      if (n.id !== node.id && contains(g, rectOf(n))) targets.add(n.id)
    }
  }
  for (const n of nodes(data)) {
    if (targets.has(n.id)) {
      n.x += dx
      n.y += dy
    }
  }
  return targets
}

function autoSides(a: Rect, b: Rect): { fromSide: Side; toSide: Side } {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2)
  const dy = b.y + b.height / 2 - (a.y + a.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
}
