import { createContext } from 'react'

/** Callbacks node components use to commit human edits back to the hub. */
export interface BoardActionsValue {
  commitText: (id: string, text: string) => void
  commitLabel: (id: string, label: string) => void
  /** x/y are in React Flow node coordinates (relative when parented); CanvasBoard converts to absolute. */
  commitGeometry: (id: string, geometry: { x?: number; y?: number; width?: number; height?: number }) => void
}

export const BoardActions = createContext<BoardActionsValue>({
  commitText: () => {},
  commitLabel: () => {},
  commitGeometry: () => {},
})
