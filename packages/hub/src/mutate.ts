import { genId, nodes, edges, type CanvasData, type CanvasNode, type Side } from '@pairsketch/canvas-kit'

/**
 * The HUMAN write path, used by the web client. Unlike agent ops (semantic,
 * anchor-relative — see canvas-kit/ops), humans own space: dragging produces
 * absolute coordinates and that is fine. Design invariant D4 constrains
 * agents, not people.
 */

export type Mutation =
  | { kind: 'set_geometry'; id: string; x?: number; y?: number; width?: number; height?: number }
  | { kind: 'set_text'; id: string; text: string }
  | { kind: 'set_color'; id: string; color?: string }
  | { kind: 'set_label'; id: string; label: string }
  | { kind: 'add_text_node'; x: number; y: number; text?: string; width?: number; height?: number }
  | { kind: 'add_edge'; from: string; to: string; fromSide?: Side; toSide?: Side; label?: string }
  | { kind: 'delete_node'; id: string }
  | { kind: 'delete_edge'; id: string }

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
        if (m.x !== undefined || m.y !== undefined) movedIds.push(node.id)
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
      case 'add_edge': {
        const from = mustGet(m.from)
        const to = mustGet(m.to)
        data.edges.push({
          id: genId(),
          fromNode: from.id,
          ...(m.fromSide ? { fromSide: m.fromSide } : {}),
          toNode: to.id,
          ...(m.toSide ? { toSide: m.toSide } : {}),
          ...(m.label ? { label: m.label } : {}),
        })
        summary.push(`edge ${from.id} -> ${to.id}`)
        break
      }
      case 'delete_node': {
        const id = mustGet(m.id).id
        data.nodes = data.nodes.filter((n) => n.id !== id)
        data.edges = data.edges.filter((e) => e.fromNode !== id && e.toNode !== id)
        deletedIds.push(id)
        summary.push(`deleted ${id}`)
        break
      }
      case 'delete_edge': {
        const before = data.edges.length
        data.edges = data.edges.filter((e) => e.id !== m.id)
        if (data.edges.length === before) throw new Error(`unknown edge id: "${m.id}"`)
        summary.push(`deleted edge ${m.id}`)
        break
      }
      default:
        throw new Error(`unknown mutation: ${JSON.stringify(m satisfies never)}`)
    }
  }
  return { movedIds, deletedIds, summary }
}
