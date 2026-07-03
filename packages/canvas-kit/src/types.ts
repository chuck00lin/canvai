/**
 * JSON Canvas 1.0 types (https://jsoncanvas.org/spec/1.0/).
 *
 * Deliberately loose: every record carries an index signature so that fields
 * we don't know about (e.g. Advanced Canvas styling) survive a round-trip
 * untouched. That preservation is a core invariant of pairsketch (design D3).
 */

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type EdgeEnd = 'none' | 'arrow'
export type NodeType = 'text' | 'file' | 'link' | 'group'

export interface CanvasNode {
  id: string
  type: NodeType | (string & {})
  x: number
  y: number
  width: number
  height: number
  color?: string
  /** type: "text" */
  text?: string
  /** type: "file" */
  file?: string
  subpath?: string
  /** type: "link" */
  url?: string
  /** type: "group" */
  label?: string
  background?: string
  backgroundStyle?: string
  [key: string]: unknown
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: Side
  toSide?: Side
  fromEnd?: EdgeEnd
  toEnd?: EdgeEnd
  color?: string
  label?: string
  [key: string]: unknown
}

export interface CanvasData {
  nodes?: CanvasNode[]
  edges?: CanvasEdge[]
  [key: string]: unknown
}

export function nodes(data: CanvasData): CanvasNode[] {
  return data.nodes ?? []
}

export function edges(data: CanvasData): CanvasEdge[] {
  return data.edges ?? []
}
