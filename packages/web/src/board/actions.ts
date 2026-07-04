import { createContext } from 'react'

/** Callbacks node components use to commit human edits back to the hub. */
export interface BoardActionsValue {
  commitText: (id: string, text: string) => void
  commitLabel: (id: string, label: string) => void
  /** x/y are in React Flow node coordinates (relative when parented); CanvasBoard converts to absolute. */
  commitGeometry: (id: string, geometry: { x?: number; y?: number; width?: number; height?: number }) => void
  /** while any card is being edited, board reloads are deferred (a reload would blur the editor mid-typing) */
  notifyEditing: (active: boolean) => void
  /** cancelling the editor of a still-empty card removes it — an empty card is invisible junk */
  deleteNode: (id: string) => void
}

export const BoardActions = createContext<BoardActionsValue>({
  commitText: () => {},
  commitLabel: () => {},
  commitGeometry: () => {},
  notifyEditing: () => {},
  deleteNode: () => {},
})

/**
 * Edit requests initiated from outside the node component — the touch
 * toolbar's ✏️ button (double-click is not a touch gesture). `seq` bumps on
 * every request so asking for the same node twice still triggers.
 */
export interface EditRequestValue {
  id: string
  seq: number
}

export const EditRequest = createContext<EditRequestValue>({ id: '', seq: 0 })
