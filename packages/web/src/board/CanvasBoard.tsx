import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type Node as FlowNode,
} from '@xyflow/react'
import { api, type Mutation } from '../api'
import { BoardActions, EditRequest, type BoardActionsValue, type EditRequestValue } from './actions'
import { absolutePosition, CANVAS_COLORS, colorOf, toFlow, type PSFlowNode } from './mapping'
import { nodeTypes } from './nodes'
import { useLongPress } from './useLongPress'
import { COARSE_QUERY, useMediaQuery } from '../useMediaQuery'

interface Props {
  path: string
  /** bumped by App when the hub reports this board changed */
  changeSignal: number
}

export function CanvasBoard(props: Props) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  )
}

function BoardInner({ path, changeSignal }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<PSFlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([])
  const [error, setError] = useState<string | null>(null)
  const dragging = useRef(false)
  const pendingReload = useRef(false)
  const nodesRef = useRef<PSFlowNode[]>([])
  nodesRef.current = nodes
  const { screenToFlowPosition } = useReactFlow()
  // touch devices get a selection toolbar: double-click, drag-from-handle and
  // the Delete key have no natural touch equivalent
  const coarse = useMediaQuery(COARSE_QUERY)
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] })
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [editReq, setEditReq] = useState<EditRequestValue>({ id: '', seq: 0 })
  // toolbar shows the color palette instead of actions
  const [colorMode, setColorMode] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data, pinned } = await api.board(path)
      const mapped = toFlow(data, new Set(pinned))
      // selection survives sync reloads — e.g. picking a color triggers a
      // board_changed, and losing selection would close the toolbar mid-use
      setNodes((previous) => {
        const selected = new Set(previous.filter((n) => n.selected).map((n) => n.id))
        return mapped.nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n))
      })
      setEdges((previous) => {
        const selected = new Set(previous.filter((e) => e.selected).map((e) => e.id))
        return mapped.edges.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e))
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [path, setNodes, setEdges])

  useEffect(() => {
    void load()
  }, [load])

  const editingCount = useRef(0)

  useEffect(() => {
    if (changeSignal === 0) return
    // a reload while dragging or editing would yank the interaction (blur the
    // editor, drop the drag) — defer until the human is done
    if (dragging.current || editingCount.current > 0) pendingReload.current = true
    else void load()
  }, [changeSignal, load])

  const mutate = useCallback(
    (changes: Mutation[]) => {
      if (changes.length === 0) return
      api.mutate(path, changes).catch((e) => setError(e instanceof Error ? e.message : String(e)))
      // the hub broadcasts board_changed, which triggers the reload
    },
    [path],
  )

  const byId = () => new Map(nodesRef.current.map((n) => [n.id, n]))

  const actions = useMemo<BoardActionsValue>(
    () => ({
      commitText: (id, text) => mutate([{ kind: 'set_text', id, text }]),
      commitLabel: (id, label) => mutate([{ kind: 'set_label', id, label }]),
      commitGeometry: (id, geometry) => {
        const map = byId()
        const node = map.get(id)
        if (!node) return
        let { x, y } = geometry
        if (x !== undefined && y !== undefined && node.parentId) {
          const abs = absolutePosition({ position: { x, y }, parentId: node.parentId }, map)
          x = abs.x
          y = abs.y
        }
        mutate([{ kind: 'set_geometry', id, x, y, width: geometry.width, height: geometry.height }])
      },
      notifyEditing: (active) => {
        editingCount.current = Math.max(0, editingCount.current + (active ? 1 : -1))
        if (editingCount.current === 0 && pendingReload.current) {
          pendingReload.current = false
          void load()
        }
      },
      deleteNode: (id) => mutate([{ kind: 'delete_node', id }]),
    }),
    [mutate, load],
  )

  // positions when the drag interaction began — a tap also fires
  // dragstart/dragstop, and committing an unmoved node would PIN it
  const dragStartPos = useRef<Map<string, { x: number; y: number }>>(new Map())

  const onNodeDragStart = useCallback(() => {
    dragging.current = true
    const map = byId()
    dragStartPos.current = new Map([...map.values()].map((n) => [n.id, absolutePosition(n, map)]))
  }, [])

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: FlowNode, draggedNodes: FlowNode[]) => {
      dragging.current = false
      const map = byId()
      const moves = new Map<string, { x: number; y: number }>()
      for (const dragged of draggedNodes) {
        const current = map.get(dragged.id)
        if (!current) continue
        moves.set(dragged.id, absolutePosition(current, map))
        // moving a group moves its members' absolute positions too
        if (current.type === 'group') {
          for (const child of map.values()) {
            if (child.parentId === current.id && !moves.has(child.id)) {
              moves.set(child.id, absolutePosition(child, map))
            }
          }
        }
      }
      const changed = [...moves.entries()].filter(([id, pos]) => {
        const start = dragStartPos.current.get(id)
        return !start || Math.abs(start.x - pos.x) > 0.5 || Math.abs(start.y - pos.y) > 0.5
      })
      mutate(changed.map(([id, pos]) => ({ kind: 'set_geometry', id, x: pos.x, y: pos.y })))
      if (pendingReload.current) {
        pendingReload.current = false
        void load()
      }
    },
    [mutate, load],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      mutate([
        {
          kind: 'add_edge',
          from: connection.source,
          to: connection.target,
          fromSide: connection.sourceHandle ?? undefined,
          toSide: connection.targetHandle ?? undefined,
        },
      ])
    },
    [mutate],
  )

  const onNodesDelete = useCallback(
    (deleted: FlowNode[]) => mutate(deleted.map((n) => ({ kind: 'delete_node', id: n.id }) as Mutation)),
    [mutate],
  )
  const onEdgesDelete = useCallback(
    (deleted: FlowEdge[]) => mutate(deleted.map((e) => ({ kind: 'delete_edge', id: e.id }) as Mutation)),
    [mutate],
  )

  // create a card and drop straight into its editor — the id comes back in
  // the mutate summary as `added <id>`
  const addCardAt = useCallback(
    async (screen: { x: number; y: number }) => {
      const position = screenToFlowPosition(screen)
      try {
        const result = await api.mutate(path, [
          { kind: 'add_text_node', x: position.x - 100, y: position.y - 40, text: '' },
        ])
        const added = result.summary.find((line) => line.startsWith('added '))?.slice('added '.length)
        if (!added) return
        await load()
        requestEdit(added)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [path, screenToFlowPosition, load],
  )

  const addCard = useCallback(
    () => void addCardAt({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
    [addCardAt],
  )

  // double-click on empty canvas = new card where you clicked
  const onWrapperDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return
      void addCardAt({ x: event.clientX, y: event.clientY })
    },
    [addCardAt],
  )

  // touch: long-press on empty canvas = new card under the finger
  const panePress = useLongPress({
    onLongPress: (point) => void addCardAt(point),
    accept: (event) => (event.target as HTMLElement).classList.contains('react-flow__pane'),
  })

  const reverseEdge = useCallback(
    (edge: FlowEdge) => {
      mutate([
        { kind: 'delete_edge', id: edge.id },
        {
          kind: 'add_edge',
          from: edge.target,
          to: edge.source,
          fromSide: edge.targetHandle ?? undefined,
          toSide: edge.sourceHandle ?? undefined,
          label: typeof edge.label === 'string' ? edge.label : undefined,
        },
      ])
    },
    [mutate],
  )

  // double-click an edge = reverse its direction (arrows are semantics)
  const onEdgeDoubleClick = useCallback(
    (_event: ReactMouseEvent, edge: FlowEdge) => reverseEdge(edge),
    [reverseEdge],
  )

  const onSelectionChange = useCallback(
    (params: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
      setSelection({ nodes: params.nodes.map((n) => n.id), edges: params.edges.map((e) => e.id) })
    },
    [],
  )

  // connect mode (touch): 連線 on the toolbar, then tap the target node.
  // Otherwise: force-select on click — some iOS tap sequences (e.g. first
  // tap after the keyboard dismisses) deliver the click without React Flow
  // registering selection, and the toolbar never appears
  const onNodeClick = useCallback(
    (_event: ReactMouseEvent, node: FlowNode) => {
      if (connectFrom) {
        if (node.id !== connectFrom) mutate([{ kind: 'add_edge', from: connectFrom, to: node.id }])
        setConnectFrom(null)
        return
      }
      setNodes((ns) =>
        ns.map((n) =>
          n.id === node.id ? (n.selected ? n : { ...n, selected: true }) : n.selected ? { ...n, selected: false } : n,
        ),
      )
      setSelection((prev) =>
        prev.nodes.length === 1 && prev.nodes[0] === node.id && prev.edges.length === 0
          ? prev
          : { nodes: [node.id], edges: [] },
      )
    },
    [connectFrom, mutate, setNodes],
  )

  const onPaneClick = useCallback(() => setConnectFrom(null), [])

  const selNode =
    selection.nodes.length === 1 && selection.edges.length === 0
      ? nodes.find((n) => n.id === selection.nodes[0])
      : undefined
  const selEdge =
    selection.edges.length === 1 && selection.nodes.length === 0
      ? edges.find((e) => e.id === selection.edges[0])
      : undefined

  const selNodeId = selNode?.id
  useEffect(() => setColorMode(false), [selNodeId])
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => setConfirmDelete(false), [selNodeId, colorMode])

  // opening an editor clears canvas selection: a toolbar lurking under the
  // full-screen modal is a loaded gun — closing the modal leaves 🗑 exactly
  // where the fingers are (2026-07-04: deleted a card the CEO never aimed at)
  const requestEdit = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
      setEditReq((r) => ({ id, seq: r.seq + 1 }))
    },
    [setNodes],
  )

  return (
    <div
      className="ps-board"
      onDoubleClick={onWrapperDoubleClick}
      // long-press must not open the browser context menu / selection callout
      onContextMenu={coarse ? (event) => event.preventDefault() : undefined}
      {...panePress}
    >
      <BoardActions.Provider value={actions}>
        <EditRequest.Provider value={editReq}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onSelectionChange={onSelectionChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            // touch: no keyboard delete — the toolbar 🗑 (with confirm) is
            // the delete path; a lingering selection + Backspace was a trap
            deleteKeyCode={coarse ? null : ['Backspace', 'Delete']}
            // touch: edges are 1.6px lines — give the finger a fatter target
            defaultEdgeOptions={coarse ? { interactionWidth: 32 } : undefined}
            connectionRadius={44}
            // the attribution link hijacks long-presses near the corner on
            // touch; React Flow is credited in the README instead
            proOptions={{ hideAttribution: true }}
            // touch: a tap with slight jitter must select, not micro-drag
            // (drag = pin) — but keep the dead zone small or drag starts
            // feel sticky
            nodeDragThreshold={coarse ? 5 : 1}
            fitView
            minZoom={0.05}
            zoomOnDoubleClick={false}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => colorOf((n as PSFlowNode).data?.node?.color) ?? '#e2e5e9'} />
          </ReactFlow>
        </EditRequest.Provider>
      </BoardActions.Provider>
      <button className="ps-addcard" onClick={addCard} title="add a text card at the viewport center">
        ＋ card
      </button>
      {coarse && (connectFrom || selNode || selEdge) && (
        <div className="ps-toolbar">
          {connectFrom ? (
            <>
              <span className="ps-toolbar-hint">點目標卡片完成連線</span>
              <button onClick={() => setConnectFrom(null)}>取消</button>
            </>
          ) : selNode && colorMode ? (
            <>
              <button onClick={() => setColorMode(false)} aria-label="back">
                ←
              </button>
              {Object.entries(CANVAS_COLORS).map(([key, hex]) => (
                <button
                  key={key}
                  className="ps-colordot"
                  style={{ background: hex }}
                  onClick={() => mutate([{ kind: 'set_color', id: selNode.id, color: key }])}
                  aria-label={`color ${key}`}
                />
              ))}
              <button
                className="ps-colordot ps-colordot-none"
                onClick={() => mutate([{ kind: 'set_color', id: selNode.id, color: '' }])}
                aria-label="clear color"
              >
                ⊘
              </button>
            </>
          ) : selNode ? (
            <>
              {(selNode.type === 'text' || selNode.type === 'group') && (
                <button onClick={() => requestEdit(selNode.id)}>✏️ 編輯</button>
              )}
              <button onClick={() => setColorMode(true)} aria-label="card color">
                🎨
              </button>
              <button onClick={() => setConnectFrom(selNode.id)}>🔗 連線</button>
              <button
                className="ps-toolbar-danger"
                onClick={() => {
                  // two-step: a stray tap must not destroy a card (no undo yet)
                  if (!confirmDelete) {
                    setConfirmDelete(true)
                    window.setTimeout(() => setConfirmDelete(false), 3000)
                    return
                  }
                  mutate([{ kind: 'delete_node', id: selNode.id }])
                }}
              >
                {confirmDelete ? '❗確定刪除' : '🗑 刪除'}
              </button>
            </>
          ) : selEdge ? (
            <>
              <button onClick={() => reverseEdge(selEdge)}>⇄ 反向</button>
              <button
                className="ps-toolbar-danger"
                onClick={() => mutate([{ kind: 'delete_edge', id: selEdge.id }])}
              >
                🗑 刪除
              </button>
            </>
          ) : null}
        </div>
      )}
      {error && <div className="ps-error">{error}</div>}
    </div>
  )
}
