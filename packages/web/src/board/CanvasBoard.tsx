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
import { absolutePosition, colorOf, toFlow, type PSFlowNode } from './mapping'
import { nodeTypes } from './nodes'
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

  const load = useCallback(async () => {
    try {
      const { data, pinned } = await api.board(path)
      const mapped = toFlow(data, new Set(pinned))
      setNodes(mapped.nodes)
      setEdges(mapped.edges)
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
    }),
    [mutate, load],
  )

  const onNodeDragStart = useCallback(() => {
    dragging.current = true
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
      mutate([...moves.entries()].map(([id, pos]) => ({ kind: 'set_geometry', id, x: pos.x, y: pos.y })))
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

  const addCard = useCallback(() => {
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    mutate([{ kind: 'add_text_node', x: center.x - 150, y: center.y - 50, text: 'new card' }])
  }, [mutate, screenToFlowPosition])

  // double-click on empty canvas = new card where you clicked
  const onWrapperDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      mutate([{ kind: 'add_text_node', x: position.x - 150, y: position.y - 40, text: 'new card' }])
    },
    [mutate, screenToFlowPosition],
  )

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

  // connect mode (touch): 連線 on the toolbar, then tap the target node
  const onNodeClick = useCallback(
    (_event: ReactMouseEvent, node: FlowNode) => {
      if (!connectFrom) return
      if (node.id !== connectFrom) mutate([{ kind: 'add_edge', from: connectFrom, to: node.id }])
      setConnectFrom(null)
    },
    [connectFrom, mutate],
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

  return (
    <div className="ps-board" onDoubleClick={onWrapperDoubleClick}>
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
            deleteKeyCode={['Backspace', 'Delete']}
            connectionRadius={44}
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
          ) : selNode ? (
            <>
              {(selNode.type === 'text' || selNode.type === 'group') && (
                <button onClick={() => setEditReq((r) => ({ id: selNode.id, seq: r.seq + 1 }))}>✏️ 編輯</button>
              )}
              <button onClick={() => setConnectFrom(selNode.id)}>🔗 連線</button>
              <button
                className="ps-toolbar-danger"
                onClick={() => mutate([{ kind: 'delete_node', id: selNode.id }])}
              >
                🗑 刪除
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
