declare module 'elkjs/lib/elk.bundled.js' {
  export interface ElkEdge {
    id: string
    sources: string[]
    targets: string[]
  }
  export interface ElkNode {
    id: string
    x?: number
    y?: number
    width?: number
    height?: number
    layoutOptions?: Record<string, string>
    children?: ElkNode[]
    edges?: ElkEdge[]
  }
  export default class ELK {
    layout(graph: ElkNode): Promise<ElkNode>
  }
}
