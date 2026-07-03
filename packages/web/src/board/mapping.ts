import { MarkerType, type Edge as FlowEdge, type Node as FlowNode } from '@xyflow/react'
import type { CanvasData, CanvasNode } from '../api'

export interface PSData extends Record<string, unknown> {
  node: CanvasNode
  pinned: boolean
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
 * JSON Canvas -> React Flow. Groups become parent nodes (top-level only) so
 * dragging a group carries its members, matching Obsidian's behavior; member
 * positions turn relative and are converted back on write.
 */
export function toFlow(data: CanvasData, pinned: ReadonlySet<string>): { nodes: PSFlowNode[]; edges: FlowEdge[] } {
  const all = data.nodes ?? []
  const groups = all.filter((n) => n.type === 'group')

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
      type: 'group',
      position: { x: g.x, y: g.y },
      style: { width: g.width, height: g.height },
      zIndex: -10,
      data: { node: g, pinned: pinned.has(g.id) },
    })
  }
  for (const n of all) {
    if (n.type === 'group') continue
    const parent = containerOf(n)
    flowNodes.push({
      id: n.id,
      type: n.type === 'file' || n.type === 'link' ? n.type : 'text',
      position: parent ? { x: n.x - parent.x, y: n.y - parent.y } : { x: n.x, y: n.y },
      ...(parent ? { parentId: parent.id } : {}),
      style: { width: n.width, height: n.height },
      data: { node: n, pinned: pinned.has(n.id) },
    })
  }

  const flowEdges: FlowEdge[] = (data.edges ?? []).map((e) => {
    const stroke = colorOf(e.color) ?? '#9aa0a6'
    return {
      id: e.id,
      source: e.fromNode,
      target: e.toNode,
      sourceHandle: (e.fromSide as string | undefined) ?? 'right',
      targetHandle: (e.toSide as string | undefined) ?? 'left',
      ...(e.label ? { label: e.label } : {}),
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      style: { stroke, strokeWidth: 1.6 },
    }
  })

  return { nodes: flowNodes, edges: flowEdges }
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
