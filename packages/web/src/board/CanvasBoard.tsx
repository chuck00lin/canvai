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

// diagnostics channel: the debugtouch harness registers a sink here so deeper
// layers (the bridge's swallow) can emit lines without coupling to it
const debugHook = () => (window as { __psDebugLog?: (line: string) => void }).__psDebugLog

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
  const boardRef = useRef<HTMLDivElement>(null)

  // WebKit ignores touch-action on descendants of CSS-transformed ancestors
  // (every card lives inside the transformed viewport) — CSS alone leaves
  // iOS free to claim moves that start on card content. JS fallback: any
  // touch sequence that began on a node is ours; preventDefault its moves.
  useEffect(() => {
    if (!coarse) return
    const el = boardRef.current
    if (!el) return
    const onTouchMove = (event: TouchEvent) => {
      if (event.cancelable && (event.target as HTMLElement).closest?.('.react-flow__node')) {
        event.preventDefault()
      }
    }
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => el.removeEventListener('touchmove', onTouchMove)
  }, [coarse])

  // POINTER→MOUSE BRIDGE for iPad desktop-mode Safari. Field numbers: 69
  // presses produced only 12 mousedowns — Safari synthesizes mouse events
  // only for gestures it deems click-like, and with no TouchEvent API in
  // desktop mode, d3-drag (mouse/touch only) can never see the rest. Drags
  // therefore engaged ~1 time in 6 ("sometimes the center drags, sometimes
  // not"). Pointer events arrive for 69/69 — so drive d3's mouse path from
  // them ourselves. Only on nodes; pane pan/zoom works natively.
  useEffect(() => {
    if (!coarse) return
    const el = boardRef.current
    if (!el) return
    let bridging = false
    // GATE ON BEHAVIOR, NOT API: desktop-mode iPad keeps the TouchEvent API
    // surface ('ontouchstart' in window is TRUE) but never DISPATCHES touch
    // events — an API-presence check disqualified exactly the device that
    // needs the bridge. If real touch events ever fire, d3's touch path is
    // alive and the bridge stands down.
    let touchWorks = false
    const markTouch = () => {
      touchWorks = true
    }
    // While we drive d3 with the synthetic stream, Safari's own click-like
    // synthesis must not reach d3 — a trusted mouseup mid-gesture makes d3
    // unbind its window move/up listeners, deafening it to the rest of the
    // synthetic stream (field: "one step then frozen for 7s of circling";
    // reproduced: trusted down+up after move 1 → transform frozen at step 1).
    // MUST live on window: d3-drag binds its gesture listeners on window, and
    // window is above the board el in capture order — an el-level swallow
    // fires too late. Registered at bridge init, so it precedes d3's
    // per-gesture registration and stopImmediatePropagation starves it.
    // NO preventDefault, or the native click (selection taps) dies with it.
    const swallowRealMouse = (event: MouseEvent) => {
      if (bridging && event.isTrusted) {
        event.stopImmediatePropagation()
        debugHook()?.(`swallow trusted ${event.type} (${Math.round(event.clientX)},${Math.round(event.clientY)})`)
      }
    }
    const mouse = (type: string, pe: PointerEvent) =>
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: pe.clientX,
        clientY: pe.clientY,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
      })
    const onPointerDown = (pe: PointerEvent) => {
      if (touchWorks) return // genuine touch platform (iPhone) — d3 touch path handles it
      if (pe.pointerType !== 'touch' || !pe.isPrimary) return
      if (!(pe.target as HTMLElement).closest?.('.react-flow__node')) return
      const target = pe.target as HTMLElement
      // arm the swallow immediately — Safari's click-like mousedown can land
      // in this same tick and must not reach d3
      bridging = true
      // defer the synthetic mousedown one tick: on a REAL touch platform the
      // first-ever gesture may deliver touchstart right after pointerdown —
      // abort instead of double-driving d3 with both paths
      window.setTimeout(() => {
        if (touchWorks) {
          bridging = false
          return
        }
        target.dispatchEvent(mouse('mousedown', pe))
      }, 0)
    }
    const onPointerMove = (pe: PointerEvent) => {
      if (bridging && pe.pointerType === 'touch' && pe.isPrimary) window.dispatchEvent(mouse('mousemove', pe))
    }
    const end = (pe: PointerEvent) => {
      if (!bridging) return
      bridging = false
      window.dispatchEvent(mouse('mouseup', pe))
    }
    window.addEventListener('touchstart', markTouch, { capture: true, passive: true })
    window.addEventListener('mousedown', swallowRealMouse, { capture: true })
    window.addEventListener('mousemove', swallowRealMouse, { capture: true })
    window.addEventListener('mouseup', swallowRealMouse, { capture: true })
    el.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointermove', onPointerMove, { capture: true })
    window.addEventListener('pointerup', end, { capture: true })
    window.addEventListener('pointercancel', end, { capture: true })
    return () => {
      window.removeEventListener('touchstart', markTouch, { capture: true })
      window.removeEventListener('mousedown', swallowRealMouse, { capture: true })
      window.removeEventListener('mousemove', swallowRealMouse, { capture: true })
      window.removeEventListener('mouseup', swallowRealMouse, { capture: true })
      el.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
      window.removeEventListener('pointerup', end, { capture: true })
      window.removeEventListener('pointercancel', end, { capture: true })
    }
  }, [coarse])

  // ZOMBIE-DRAG KILLER (field-diagnosed via debugtouch: a node stayed in
  // .dragging across an entire session). iPad desktop-mode Safari delivers
  // fingers as MOUSE events; when iOS claims a gesture mid-drag it stops the
  // stream WITHOUT a mouseup — and the mouse model has no cancel event, so
  // the d3 drag gesture lives forever, eating every later interaction.
  // A fresh primary pointerdown while a drag is still "active" is proof the
  // old gesture died: force-close it with a synthetic mouseup first.
  useEffect(() => {
    if (!coarse) return
    const closeZombie = (event?: PointerEvent) => {
      if (!document.querySelector('.react-flow__node.dragging')) return
      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          view: window,
          clientX: event?.clientX ?? 0,
          clientY: event?.clientY ?? 0,
        }),
      )
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.isPrimary) closeZombie(event)
    }
    const onHide = () => closeZombie()
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('blur', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('blur', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [coarse])

  // remote diagnostics: open /?token=…&debugtouch — events show on-screen AND
  // stream to the hub (.pairsketch/debug.jsonl) so gesture bugs on real
  // devices can be read server-side (emulators don't reproduce iOS arbitration)
  const [debugLines, setDebugLines] = useState<string[]>([])
  const debugTouch = useMemo(() => new URLSearchParams(window.location.search).has('debugtouch'), [])
  useEffect(() => {
    if (!debugTouch) return
    const el = boardRef.current
    if (!el) return
    const buffer: string[] = []
    let lastMoveLogged = 0
    const push = (line: string) => {
      const stamped = `${new Date().toISOString().slice(11, 23)} ${line}`
      buffer.push(stamped)
      setDebugLines((prev) => [...prev.slice(-11), stamped])
    }
    ;(window as { __psDebugLog?: (line: string) => void }).__psDebugLog = push
    const label = (t: EventTarget | null) =>
      ((t as HTMLElement)?.className?.toString().split(' ').slice(0, 2).join('.') ?? '?').slice(0, 34)
    const detail = (e: Event) => {
      const touch = (e as TouchEvent).touches?.[0]
      const px = touch?.clientX ?? (e as PointerEvent).clientX
      const py = touch?.clientY ?? (e as PointerEvent).clientY
      const x = typeof px === 'number' ? Math.round(px) : ''
      const y = typeof py === 'number' ? Math.round(py) : ''
      const draggingEl = document.querySelector('.react-flow__node.dragging')
      const dragging = draggingEl ? `DRAG:${draggingEl.getAttribute('data-id')?.slice(0, 6) ?? '?'}` : '----'
      // live transform of the dragged node: distinguishes "state updates but
      // iOS won't paint" from "position pipeline frozen" during a desync
      const dragT = draggingEl
        ? `T(${(draggingEl as HTMLElement).style.transform.match(/-?[\d.]+/g)?.slice(0, 2).map(Number).map(Math.round).join(',') ?? '?'})`
        : ''
      const kind = (e as PointerEvent).pointerType ?? ((e as TouchEvent).touches ? 'touch' : '?')
      return `${kind} ${dragging}${dragT} (${x},${y})${e.defaultPrevented ? ' prevented' : ''}${(e as TouchEvent).cancelable === false ? ' NONCANCELABLE' : ''}`
    }
    // per-gesture verdict: did a node drag ENGAGE, and how fast? Puts the
    // measurement on the same gesture the tester feels.
    let gestureT0 = 0
    let gestureEngaged = false
    let gestureOnNode = false
    const handlers: Array<[string, (e: Event) => void]> = (
      [
        'touchstart',
        'touchmove',
        'touchend',
        'touchcancel',
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'mousedown',
        'mouseup',
      ] as const
    ).map((type) => [
      type,
      (e: Event) => {
        if (type === 'pointerdown') {
          gestureT0 = performance.now()
          gestureEngaged = false
          gestureOnNode = !!(e.target as HTMLElement).closest?.('.react-flow__node')
        }
        if (
          !gestureEngaged &&
          gestureOnNode &&
          (type === 'pointermove' || type === 'pointerup') &&
          document.querySelector('.react-flow__node.dragging')
        ) {
          gestureEngaged = true
          push(`>>> ENGAGE ${Math.round(performance.now() - gestureT0)}ms`)
        }
        if (type === 'pointerup' && gestureOnNode && !gestureEngaged) {
          push(`>>> NO-ENGAGE（此次按在卡片上但拖曳未掛上）`)
        }
        if (type === 'touchmove' || type === 'pointermove') {
          if ((e as PointerEvent).buttons === 0 && type === 'pointermove') return // hover noise
          const now = performance.now()
          if (now - lastMoveLogged < 80) return
          lastMoveLogged = now
        }
        push(`${type} @${label(e.target)} ${detail(e)}`)
      },
    ])
    // capture AND non-capture end: defaultPrevented is only meaningful after
    // bubble handlers ran, so log at the end of the bubble phase
    for (const [type, fn] of handlers) el.addEventListener(type, fn, { passive: true })
    const flush = window.setInterval(() => {
      if (buffer.length === 0) return
      const lines = buffer.splice(0, buffer.length)
      // reuse the page's own query string — it already carries ?token=
      void fetch('/api/debug' + window.location.search, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines }),
      }).catch(() => {})
    }, 1500)
    push(`debug session start ua=${navigator.userAgent.slice(0, 80)}`)
    return () => {
      for (const [type, fn] of handlers) el.removeEventListener(type, fn)
      window.clearInterval(flush)
      delete (window as { __psDebugLog?: (line: string) => void }).__psDebugLog
    }
  }, [debugTouch])

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
        // if we just committed moves, loading NOW would fetch pre-commit
        // state and visually snap the card back ("card jumped/disappeared") —
        // our own mutate broadcasts board_changed and refreshes with truth
        if (changed.length === 0) void load()
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
      ref={boardRef}
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
      {debugTouch && (
        <pre className="ps-debug">
          {debugLines.join('\n') || 'debugtouch: 觸控事件會顯示在這裡'}
        </pre>
      )}
    </div>
  )
}
