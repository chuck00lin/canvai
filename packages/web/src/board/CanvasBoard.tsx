import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { BoardActions, type BoardActionsValue } from './actions'
import { absolutePosition, colorOf, toFlow, type PSFlowNode } from './mapping'
import { nodeTypes } from './nodes'

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

  useEffect(() => {
    if (changeSignal === 0) return
    if (dragging.current) pendingReload.current = true
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
    }),
    [mutate],
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

  return (
    <div className="ps-board">
      <BoardActions.Provider value={actions}>
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
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
          minZoom={0.05}
          zoomOnDoubleClick={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => colorOf((n as PSFlowNode).data?.node?.color) ?? '#e2e5e9'} />
        </ReactFlow>
      </BoardActions.Provider>
      <button className="ps-addcard" onClick={addCard} title="add a text card at the viewport center">
        ＋ card
      </button>
      {error && <div className="ps-error">{error}</div>}
    </div>
  )
}
