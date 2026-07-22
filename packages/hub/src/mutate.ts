import {
  attachCard,
  createRail,
  detachCard,
  genId,
  isRailGroup,
  nodes,
  edges,
  railInfo,
  railJointIds,
  reorderCard,
  resizeRail,
  type CanvasData,
  type CanvasNode,
  type RailOrient,
  type Side,
} from '@canvai/canvas-kit'

/**
 * The HUMAN write path, used by the web client. Unlike agent ops (semantic,
 * anchor-relative — see canvas-kit/ops), humans own space: dragging produces
 * absolute coordinates and that is fine. Design invariant D4 constrains
 * agents, not people.
 */

export type Mutation =
  | { kind: 'set_geometry'; id: string; x?: number; y?: number; width?: number; height?: number; pin?: boolean }
  | { kind: 'set_text'; id: string; text: string }
  | { kind: 'set_color'; id: string; color?: string }
  | { kind: 'set_label'; id: string; label: string }
  | { kind: 'set_discuss'; id: string; discuss: boolean }
  | { kind: 'add_text_node'; x: number; y: number; text?: string; width?: number; height?: number }
  | { kind: 'add_file_node'; x: number; y: number; file: string; width?: number; height?: number }
  | { kind: 'add_group'; x: number; y: number; width: number; height: number; label?: string }
  | { kind: 'add_edge'; from: string; to: string; fromSide?: Side; toSide?: Side; label?: string; color?: string }
  | { kind: 'delete_node'; id: string }
  | { kind: 'delete_edge'; id: string }
  | { kind: 'replace_board'; data: CanvasData }
  | { kind: 'add_rail'; orient: RailOrient; x: number; y: number; slots: number; pitch?: number; label?: string }
  | { kind: 'rail_attach'; rail: string; card: string; slot: number }
  | { kind: 'rail_detach'; rail: string; card: string }
  | { kind: 'rail_resize'; rail: string; x: number; y: number; width: number; height: number }

export interface MutateOutcome {
  /** nodes whose x/y a human changed — these get pinned */
  movedIds: string[]
  /** nodes removed — their pins should be pruned */
  deletedIds: string[]
  summary: string[]
}

export function applyMutations(data: CanvasData, mutations: Mutation[]): MutateOutcome {
  if (!data.nodes) data.nodes = []
  if (!data.edges) data.edges = []
  const movedIds: string[] = []
  const deletedIds: string[] = []
  const summary: string[] = []

  const mustGet = (id: string): CanvasNode => {
    const node = nodes(data).find((n) => n.id === id)
    if (!node) throw new Error(`unknown node id: "${id}"`)
    return node
  }

  for (const m of mutations) {
    switch (m.kind) {
      case 'set_geometry': {
        const node = mustGet(m.id)
        // pin: false = a derived move (e.g. cards riding a dragged rail), not
        // the human arranging this node — it must not opt out of auto-layout
        if ((m.x !== undefined || m.y !== undefined) && m.pin !== false) movedIds.push(node.id)
        if (m.x !== undefined) node.x = Math.round(m.x)
        if (m.y !== undefined) node.y = Math.round(m.y)
        if (m.width !== undefined) node.width = Math.round(m.width)
        if (m.height !== undefined) node.height = Math.round(m.height)
        summary.push(`geometry ${node.id}`)
        break
      }
      case 'set_text': {
        mustGet(m.id).text = m.text
        summary.push(`text ${m.id}`)
        break
      }
      case 'set_color': {
        const node = mustGet(m.id)
        if (m.color === undefined || m.color === '') delete node.color
        else node.color = m.color
        summary.push(`color ${m.id}`)
        break
      }
      case 'set_label': {
        mustGet(m.id).label = m.label
        summary.push(`label ${m.id}`)
        break
      }
      case 'set_discuss': {
        const node = mustGet(m.id)
        // default is ON — store the field only for opt-outs so boards stay clean
        if (m.discuss) delete node.discuss
        else node.discuss = false
        summary.push(`discuss ${node.id} ${m.discuss ? 'on' : 'off'}`)
        break
      }
      case 'add_text_node': {
        const node: CanvasNode = {
          id: genId(),
          type: 'text',
          text: m.text ?? '',
          x: Math.round(m.x),
          y: Math.round(m.y),
          width: Math.round(m.width ?? 300),
          height: Math.round(m.height ?? 100),
        }
        data.nodes.push(node)
        movedIds.push(node.id) // human chose the spot — pin it
        summary.push(`added ${node.id}`)
        break
      }
      case 'add_file_node': {
        const node: CanvasNode = {
          id: genId(),
          type: 'file',
          file: m.file,
          x: Math.round(m.x),
          y: Math.round(m.y),
          width: Math.round(m.width ?? 360),
          height: Math.round(m.height ?? 280),
        }
        data.nodes.push(node)
        movedIds.push(node.id) // human chose the spot — pin it
        summary.push(`added ${node.id}`)
        break
      }
      case 'add_group': {
        // the human boxed a selection into a group; membership is geometric
        // (containerOf), so we just drop an enclosing group node
        const node: CanvasNode = {
          id: genId(),
          type: 'group',
          label: m.label ?? '',
          x: Math.round(m.x),
          y: Math.round(m.y),
          width: Math.round(m.width),
          height: Math.round(m.height),
        }
        data.nodes.push(node)
        movedIds.push(node.id) // human placed it → pin so auto-layout leaves it put
        summary.push(`added ${node.id}`)
        break
      }
      case 'add_edge': {
        const from = mustGet(m.from)
        const to = mustGet(m.to)
        // self-loops render as a stray arrowhead on the card and carry no
        // meaning for the discussion graph — reject at the hub so every
        // frontend (web, agents) is covered
        if (from.id === to.id) throw new Error(`self-edge rejected: ${from.id}`)
        data.edges.push({
          id: genId(),
          fromNode: from.id,
          ...(m.fromSide ? { fromSide: m.fromSide } : {}),
          toNode: to.id,
          ...(m.toSide ? { toSide: m.toSide } : {}),
          ...(m.label ? { label: m.label } : {}),
          ...(m.color ? { color: m.color } : {}),
        })
        summary.push(`edge ${from.id} -> ${to.id}`)
        break
      }
      case 'delete_node': {
        // idempotent: React Flow deletes a rail group and its joint children in
        // one batch, and the group's cascade removes the joints first — the
        // follow-up ids must not fail the whole mutation
        const node = nodes(data).find((n) => n.id === m.id)
        if (!node) {
          summary.push(`already deleted ${m.id}`)
          break
        }
        // deleting a rail takes its joints along — orphaned dots are junk
        const drop = new Set([node.id, ...railJointIds(data, node)])
        data.nodes = data.nodes.filter((n) => !drop.has(n.id))
        data.edges = data.edges.filter((e) => !drop.has(e.fromNode) && !drop.has(e.toNode))
        deletedIds.push(...drop)
        summary.push(`deleted ${node.id}`)
        break
      }
      case 'delete_edge': {
        const before = data.edges.length
        data.edges = data.edges.filter((e) => e.id !== m.id)
        if (data.edges.length === before) throw new Error(`unknown edge id: "${m.id}"`)
        summary.push(`deleted edge ${m.id}`)
        break
      }
      case 'replace_board': {
        // undo/redo: restore a full prior board snapshot wholesale. Guard against
        // a malformed payload wiping the board.
        if (!m.data || !Array.isArray(m.data.nodes) || !Array.isArray(m.data.edges)) {
          throw new Error('replace_board: data must have nodes[] and edges[]')
        }
        const oldIds = new Set(nodes(data).map((n) => n.id))
        data.nodes = m.data.nodes.map((n) => ({ ...n }))
        data.edges = m.data.edges.map((e) => ({ ...e }))
        for (const id of oldIds) if (!data.nodes.some((n) => n.id === id)) deletedIds.push(id)
        summary.push(`replaced board (${data.nodes.length} nodes, ${data.edges.length} edges)`)
        break
      }
      case 'add_rail': {
        // the human drew the stroke — origin is theirs; slot layout is ours
        const rail = createRail(data, {
          orient: m.orient,
          slots: Math.max(2, Math.round(m.slots)),
          pitch: m.pitch ?? 160,
          attach: 'both',
          label: m.label ?? '',
          origin: { x: Math.round(m.x), y: Math.round(m.y) },
        })
        summary.push(`added rail ${rail.group.id}`)
        break
      }
      case 'rail_attach': {
        const group = mustGet(m.rail)
        if (!isRailGroup(group)) throw new Error(`node ${m.rail} is not a rail`)
        const card = mustGet(m.card)
        if (card.type === 'group') throw new Error('groups cannot attach to a rail')
        if (m.slot < 1) throw new Error('rail_attach: "slot" is 1-based')
        const rail = railInfo(data, group)
        const attachedHere = [...rail.cards.values()].some((cs) => cs.some((c) => c.id === card.id))
        // dropped while attached elsewhere: release that rail first
        if (!attachedHere) {
          for (const g of nodes(data).filter((n) => isRailGroup(n) && n.id !== group.id)) {
            const other = railInfo(data, g)
            if ([...other.cards.values()].some((cs) => cs.some((c) => c.id === card.id))) {
              detachCard(data, other, card)
            }
          }
        }
        // reorder covers the drop-on-own-slot case too: detach + re-attach re-seats the card
        if (attachedHere) reorderCard(data, rail, card, m.slot - 1)
        else attachCard(data, rail, card, m.slot - 1)
        summary.push(`rail ${group.id} slot ${m.slot} ← ${card.id}`)
        break
      }
      case 'rail_detach': {
        const group = mustGet(m.rail)
        if (!isRailGroup(group)) throw new Error(`node ${m.rail} is not a rail`)
        detachCard(data, railInfo(data, group), mustGet(m.card))
        summary.push(`rail ${group.id} released ${m.card}`)
        break
      }
      case 'rail_resize': {
        const group = mustGet(m.rail)
        if (!isRailGroup(group)) throw new Error(`node ${m.rail} is not a rail`)
        const slots = resizeRail(data, railInfo(data, group), { x: m.x, y: m.y, width: m.width, height: m.height })
        summary.push(`rail ${group.id} -> ${slots} slots`)
        break
      }
      default:
        throw new Error(`unknown mutation: ${JSON.stringify(m satisfies never)}`)
    }
  }
  return { movedIds, deletedIds, summary }
}
