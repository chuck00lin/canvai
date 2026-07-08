import type { CanvasData, CanvasNode, CanvasEdge, Side } from './types.ts'
import { nodes, edges } from './types.ts'
import { genId } from './ids.ts'
import { rectOf, contains } from './geometry.ts'

/**
 * Rails: direction-constrained arrows (horizontal or vertical) carrying
 * evenly spaced slots that cards attach to. A rail is an ordered list with a
 * spatial projection — order lives in the structure, coordinates are derived.
 *
 * On disk a rail is plain JSON Canvas (design D3, nothing bespoke):
 *   - a group node whose label starts with RAIL_MARK
 *   - tiny "joint" text nodes inside it, one per slot
 *   - shaft edges joint→joint (arrowhead only on the last segment)
 *   - attach edges card→joint (no arrowhead)
 * The `canvai.rail` field on the group is a cache; everything is rebuilt
 * from geometry + edges when it is missing or stale, so clients that strip
 * unknown fields degrade the rail to an ordinary group, never corrupt it.
 */

export const RAIL_MARK = '⇥'
export const JOINT_SIZE = 10
const JOINT_MAX = 14
const GROUP_PAD = 30
const CARD_GAP = 50
const PITCH_BOTH = 160
const PITCH_SINGLE = 340

export type RailOrient = 'h' | 'v'
export type RailAttach = 'both' | 'above' | 'below' | 'left' | 'right'

export interface RailInfo {
  group: CanvasNode
  orient: RailOrient
  pitch: number
  attach: RailAttach
  /** slot order; index 0 = first slot (exposed 1-based to agents) */
  joints: CanvasNode[]
  /** slot index -> cards attached there (usually one) */
  cards: Map<number, CanvasNode[]>
}

export function defaultPitch(attach: RailAttach): number {
  return attach === 'both' ? PITCH_BOTH : PITCH_SINGLE
}

export function isRailGroup(n: CanvasNode): boolean {
  return n.type === 'group' && typeof n.label === 'string' && n.label.startsWith(RAIL_MARK)
}

export function railLabel(group: CanvasNode): string {
  return (group.label ?? '').slice(RAIL_MARK.length).trim()
}

function isJoint(n: CanvasNode): boolean {
  return n.type === 'text' && n.width <= JOINT_MAX && n.height <= JOINT_MAX && !(n.text ?? '').trim()
}

interface RailCache {
  v: number
  orient: RailOrient
  pitch: number
  attach: RailAttach
}

function readCache(group: CanvasNode): Partial<RailCache> {
  const canvai = group.canvai
  if (canvai && typeof canvai === 'object' && 'rail' in canvai) {
    const rail = (canvai as { rail?: unknown }).rail
    if (rail && typeof rail === 'object') return rail as Partial<RailCache>
  }
  return {}
}

/**
 * Rebuild a rail from geometry and edges — the cache only supplies parameters
 * (orient/pitch/attach) that geometry cannot answer unambiguously.
 */
export function railInfo(data: CanvasData, group: CanvasNode): RailInfo {
  const cache = readCache(group)
  const g = rectOf(group)
  const joints = nodes(data).filter((n) => n.id !== group.id && isJoint(n) && contains(g, rectOf(n)))

  let orient: RailOrient
  if (joints.length >= 2) {
    const dx = Math.max(...joints.map((j) => j.x)) - Math.min(...joints.map((j) => j.x))
    const dy = Math.max(...joints.map((j) => j.y)) - Math.min(...joints.map((j) => j.y))
    orient = dx >= dy ? 'h' : 'v'
  } else {
    orient = cache.orient ?? (group.width >= group.height ? 'h' : 'v')
  }
  joints.sort((a, b) => (orient === 'h' ? a.x - b.x : a.y - b.y))

  let pitch = cache.pitch
  if (!pitch && joints.length >= 2) {
    const gaps = joints.slice(1).map((j, i) => (orient === 'h' ? j.x - joints[i]!.x : j.y - joints[i]!.y))
    pitch = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
  }
  const attach = cache.attach ?? 'both'

  const jointIds = new Set(joints.map((j) => j.id))
  const slotOf = new Map(joints.map((j, i) => [j.id, i]))
  const cards = new Map<number, CanvasNode[]>()
  for (const e of edges(data)) {
    if (!jointIds.has(e.toNode) || jointIds.has(e.fromNode)) continue
    const card = nodes(data).find((n) => n.id === e.fromNode)
    if (!card) continue
    const slot = slotOf.get(e.toNode)!
    cards.set(slot, [...(cards.get(slot) ?? []), card])
  }

  return { group, orient, pitch: pitch ?? defaultPitch(attach), attach, joints, cards }
}

export function findRails(data: CanvasData): RailInfo[] {
  return nodes(data).filter(isRailGroup).map((g) => railInfo(data, g))
}

/** Everything auto_layout must treat as one rigid, hand-arranged block. */
export function railMemberIds(data: CanvasData): Set<string> {
  const out = new Set<string>()
  for (const rail of findRails(data)) {
    out.add(rail.group.id)
    for (const j of rail.joints) out.add(j.id)
    for (const slotCards of rail.cards.values()) for (const c of slotCards) out.add(c.id)
  }
  return out
}

export function writeCache(rail: RailInfo): void {
  const canvai = (rail.group.canvai && typeof rail.group.canvai === 'object' ? rail.group.canvai : {}) as Record<
    string,
    unknown
  >
  canvai.rail = { v: 1, orient: rail.orient, pitch: rail.pitch, attach: rail.attach }
  rail.group.canvai = canvai
}

function jointPos(rail: RailInfo, slot: number): { x: number; y: number } {
  const first = rail.joints[0]!
  return rail.orient === 'h' ? { x: first.x + slot * rail.pitch, y: first.y } : { x: first.x, y: first.y + slot * rail.pitch }
}

function slotSide(rail: RailInfo, slot: number): 'above' | 'below' | 'left' | 'right' {
  if (rail.attach !== 'both') return rail.attach
  if (rail.orient === 'h') return slot % 2 === 0 ? 'above' : 'below'
  return slot % 2 === 0 ? 'left' : 'right'
}

const ATTACH_SIDES: Record<'above' | 'below' | 'left' | 'right', { fromSide: Side; toSide: Side }> = {
  above: { fromSide: 'bottom', toSide: 'top' },
  below: { fromSide: 'top', toSide: 'bottom' },
  left: { fromSide: 'right', toSide: 'left' },
  right: { fromSide: 'left', toSide: 'right' },
}

/** Standard card position for a slot: centred on the joint, offset off the shaft. */
function placeCard(rail: RailInfo, slot: number, card: CanvasNode): void {
  const j = jointPos(rail, slot)
  const side = slotSide(rail, slot)
  if (rail.orient === 'h') {
    card.x = Math.round(j.x + JOINT_SIZE / 2 - card.width / 2)
    card.y = side === 'above' ? j.y - CARD_GAP - card.height : j.y + JOINT_SIZE + CARD_GAP
  } else {
    card.y = Math.round(j.y + JOINT_SIZE / 2 - card.height / 2)
    card.x = side === 'left' ? j.x - CARD_GAP - card.width : j.x + JOINT_SIZE + CARD_GAP
  }
}

function fitGroup(rail: RailInfo): void {
  const first = rail.joints[0]!
  const last = rail.joints[rail.joints.length - 1]!
  rail.group.x = first.x - GROUP_PAD
  rail.group.y = first.y - GROUP_PAD
  rail.group.width = last.x + JOINT_SIZE + GROUP_PAD - rail.group.x
  rail.group.height = last.y + JOINT_SIZE + GROUP_PAD - rail.group.y
}

function shaftEdge(rail: RailInfo, from: CanvasNode, to: CanvasNode, arrowhead: boolean): CanvasEdge {
  const sides: { fromSide: Side; toSide: Side } =
    rail.orient === 'h' ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'bottom', toSide: 'top' }
  return { id: genId(), fromNode: from.id, toNode: to.id, ...sides, toEnd: arrowhead ? 'arrow' : 'none' }
}

/** The shaft edges of a rail, in slot order. */
function shaftEdges(data: CanvasData, rail: RailInfo): CanvasEdge[] {
  const jointIds = new Set(rail.joints.map((j) => j.id))
  return edges(data).filter((e) => jointIds.has(e.fromNode) && jointIds.has(e.toNode))
}

/** Attach edges from a specific card into this rail. */
function attachEdges(data: CanvasData, rail: RailInfo, cardId: string): CanvasEdge[] {
  const jointIds = new Set(rail.joints.map((j) => j.id))
  return edges(data).filter((e) => e.fromNode === cardId && jointIds.has(e.toNode))
}

export interface CreateRailOpts {
  orient: RailOrient
  slots: number
  pitch: number
  attach: RailAttach
  label: string
  origin: { x: number; y: number }
}

export function createRail(data: CanvasData, opts: CreateRailOpts): RailInfo {
  if (opts.slots < 2) throw new Error('add_rail: needs at least 2 slots')
  const joints: CanvasNode[] = []
  for (let i = 0; i < opts.slots; i++) {
    const pos =
      opts.orient === 'h'
        ? { x: opts.origin.x + i * opts.pitch, y: opts.origin.y }
        : { x: opts.origin.x, y: opts.origin.y + i * opts.pitch }
    joints.push({ id: genId(), type: 'text', text: '', ...pos, width: JOINT_SIZE, height: JOINT_SIZE })
  }
  const group: CanvasNode = {
    id: genId(),
    type: 'group',
    label: `${RAIL_MARK} ${opts.label}`.trimEnd(),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }
  data.nodes!.push(group, ...joints)
  const rail: RailInfo = { group, orient: opts.orient, pitch: opts.pitch, attach: opts.attach, joints, cards: new Map() }
  fitGroup(rail)
  for (let i = 1; i < joints.length; i++) {
    data.edges!.push(shaftEdge(rail, joints[i - 1]!, joints[i]!, i === joints.length - 1))
  }
  writeCache(rail)
  return rail
}

/** Append slots to the end of a rail, moving the arrowhead to the new last segment. */
export function extendRail(data: CanvasData, rail: RailInfo, add: number): void {
  if (add < 1) throw new Error('extend_rail: "add" must be >= 1')
  const lastEdge = shaftEdges(data, rail).find((e) => e.toNode === rail.joints[rail.joints.length - 1]!.id)
  if (lastEdge) lastEdge.toEnd = 'none'
  for (let i = 0; i < add; i++) {
    const slot = rail.joints.length
    const pos = jointPos(rail, slot)
    const joint: CanvasNode = { id: genId(), type: 'text', text: '', ...pos, width: JOINT_SIZE, height: JOINT_SIZE }
    data.nodes!.push(joint)
    data.edges!.push(shaftEdge(rail, rail.joints[slot - 1]!, joint, i === add - 1))
    rail.joints.push(joint)
  }
  fitGroup(rail)
  writeCache(rail)
}

/**
 * Attach a card at a slot (0-based). An occupied target means "insert here":
 * that card and everything after it shift one slot toward the tail, the rail
 * growing as needed — the same semantics a human gets dropping a card on a
 * full slot.
 */
export function attachCard(data: CanvasData, rail: RailInfo, card: CanvasNode, slot?: number): number {
  if (rail.cards.get(slot ?? -1)?.some((c) => c.id === card.id)) return slot!
  for (const [s, cs] of rail.cards) {
    if (cs.some((c) => c.id === card.id)) throw new Error(`card ${card.id} is already attached at slot ${s + 1}`)
  }
  let target = slot
  if (target === undefined) {
    target = 0
    while (rail.cards.has(target)) target++
  }
  if (target >= rail.joints.length) extendRail(data, rail, target - rail.joints.length + 1)
  if (rail.cards.has(target)) shiftTail(data, rail, target)

  const joint = rail.joints[target]!
  placeCard(rail, target, card)
  const side = slotSide(rail, target)
  data.edges!.push({ id: genId(), fromNode: card.id, toNode: joint.id, ...ATTACH_SIDES[side], toEnd: 'none' })
  rail.cards.set(target, [card])
  writeCache(rail)
  return target
}

/** Shift every attachment at `from` and later one slot toward the tail. */
function shiftTail(data: CanvasData, rail: RailInfo, from: number): void {
  const occupied = [...rail.cards.keys()].filter((s) => s >= from).sort((a, b) => b - a)
  if (occupied.length === 0) return
  const deepest = occupied[0]!
  if (deepest + 1 >= rail.joints.length) extendRail(data, rail, deepest + 2 - rail.joints.length)
  for (const s of occupied) {
    const cs = rail.cards.get(s)!
    rail.cards.delete(s)
    rail.cards.set(s + 1, cs)
    for (const card of cs) {
      placeCard(rail, s + 1, card)
      for (const e of attachEdges(data, rail, card.id)) {
        e.toNode = rail.joints[s + 1]!.id
        Object.assign(e, ATTACH_SIDES[slotSide(rail, s + 1)])
      }
    }
  }
}

/** Remove a card's attachment. The joint stays (an empty slot is an affordance); the card does not move. */
export function detachCard(data: CanvasData, rail: RailInfo, card: CanvasNode): void {
  const drop = attachEdges(data, rail, card.id)
  if (drop.length === 0) throw new Error(`card ${card.id} is not attached to this rail`)
  const ids = new Set(drop.map((e) => e.id))
  data.edges = edges(data).filter((e) => !ids.has(e.id))
  for (const [s, cs] of rail.cards) {
    const rest = cs.filter((c) => c.id !== card.id)
    if (rest.length === 0) rail.cards.delete(s)
    else rail.cards.set(s, rest)
  }
  writeCache(rail)
}

/** Move a card to another slot (insert semantics at the destination). */
export function reorderCard(data: CanvasData, rail: RailInfo, card: CanvasNode, toSlot: number): void {
  detachCard(data, rail, card)
  attachCard(data, rail, card, toSlot)
}

/** Change pitch and re-project every joint and attached card onto the new grid. */
export function setRailPitch(data: CanvasData, rail: RailInfo, pitch: number): void {
  if (pitch < JOINT_SIZE * 2) throw new Error(`set_rail: pitch must be >= ${JOINT_SIZE * 2}`)
  rail.pitch = pitch
  rail.joints.forEach((joint, slot) => Object.assign(joint, jointPos(rail, slot)))
  for (const [slot, cs] of rail.cards) for (const card of cs) placeCard(rail, slot, card)
  fitGroup(rail)
  writeCache(rail)
}

/** Rail geometry moved as a unit (rail group `move` takes cards along). */
export function shiftRailCards(data: CanvasData, rail: RailInfo, dx: number, dy: number, alreadyMoved: Set<string>): void {
  for (const cs of rail.cards.values()) {
    for (const card of cs) {
      if (alreadyMoved.has(card.id)) continue
      card.x += dx
      card.y += dy
      alreadyMoved.add(card.id)
    }
  }
}
