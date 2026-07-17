import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
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
import { BoardActions, Connecting, EditRequest, type BoardActionsValue, type EditRequestValue } from './actions'
import { clipRead, clipWrite, parsePayload, type ClipPayload } from './clipboard'
import {
  absolutePosition,
  buildRailLookup,
  CANVAS_COLORS,
  colorOf,
  nearestSlot,
  toFlow,
  type PSFlowNode,
  type RailLookup,
} from './mapping'
import { nodeTypes } from './nodes'
import { useLongPress } from './useLongPress'
import { COARSE_QUERY, useMediaQuery } from '../useMediaQuery'
import { useT } from '../i18n'

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
  const edgesRef = useRef<FlowEdge[]>([])
  edgesRef.current = edges
  const { screenToFlowPosition, getZoom } = useReactFlow()
  // touch devices get a selection toolbar: double-click, drag-from-handle and
  // the Delete key have no natural touch equivalent
  const coarse = useMediaQuery(COARSE_QUERY)
  const t = useT()
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] })
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
  // stream to the hub (.canvai/debug.jsonl) so gesture bugs on real
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
    // node-count watchdog: field report "resize a card → all others vanish"
    // reproduces on no emulator, so log the live count so a device capture
    // shows the exact frame cards leave the DOM and how many remain.
    let lastCount = -1
    let rafId = 0
    const watchCount = () => {
      const n = document.querySelectorAll('.react-flow__node').length
      if (n !== lastCount) {
        if (lastCount !== -1) push(`⚠ nodes ${lastCount} → ${n}`)
        lastCount = n
      }
      rafId = window.requestAnimationFrame(watchCount)
    }
    rafId = window.requestAnimationFrame(watchCount)
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
          // a press while a node is still .dragging = the PREVIOUS gesture
          // never closed; it also fools the ENGAGE detector below — flag it
          const stale = document.querySelector('.react-flow__node.dragging')
          if (stale) push(`(stale drag at press: ${stale.getAttribute('data-id')?.slice(0, 6) ?? '?'})`)
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
          push(`>>> NO-ENGAGE (pressed on a card but the drag never engaged)`)
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
    // window-level mouse probe: the bridge's synthetic stream and Safari's
    // trusted synthesis both live on window, ABOVE el — el-level logging
    // never sees them. Registered before d3's per-gesture listeners, so
    // d3's stopImmediatePropagation can't hide events from this probe.
    // dp is sampled a microtask after dispatch: d3's drag handler
    // preventDefaults mousemoves, so dp=1 ⇒ d3 consumed the event; d3mm=1
    // ⇒ a mousemove.drag listener is currently parked on window.
    const d3mm = () => {
      const on = (window as { __on?: Array<{ type: string; name: string }> }).__on
      return on?.some((o) => o.type === 'mousemove' && o.name === 'drag') ? 1 : 0
    }
    let lastMouseLogged = 0
    const winMouse = (e: MouseEvent) => {
      const now = performance.now()
      if (e.type === 'mousemove' && now - lastMouseLogged < 200) return
      lastMouseLogged = now
      const { type: mtype, isTrusted, clientX, clientY } = e
      queueMicrotask(() => {
        push(
          `win:${mtype} t=${isTrusted ? 1 : 0} dp=${e.defaultPrevented ? 1 : 0} d3mm=${d3mm()} (${Math.round(clientX)},${Math.round(clientY)})`,
        )
      })
    }
    for (const t of ['mousedown', 'mousemove', 'mouseup'] as const) window.addEventListener(t, winMouse, { capture: true })
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
      for (const t of ['mousedown', 'mousemove', 'mouseup'] as const)
        window.removeEventListener(t, winMouse, { capture: true })
      window.cancelAnimationFrame(rafId)
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

  // cards born from THIS session's create-then-edit flow: only these may be
  // auto-discarded when their editor closes still empty — a pre-existing
  // empty card someone tapped open is a deliberate placeholder, not junk
  const freshCards = useRef(new Set<string>())

  const actions = useMemo<BoardActionsValue>(
    () => ({
      commitText: (id, text) => {
        freshCards.current.delete(id) // it has content now — it's a real card
        mutate([{ kind: 'set_text', id, text }])
      },
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
        // resizing a rail is a slot-count gesture, not a box edit — the hub
        // re-lays the grid from the new length (CEO 2026-07-08: 要可以調長度)
        if (node.type === 'railGroup') {
          const abs = absolutePosition(node, map)
          mutate([
            {
              kind: 'rail_resize',
              rail: id,
              x: x ?? abs.x,
              y: y ?? abs.y,
              width: geometry.width ?? node.data.node.width,
              height: geometry.height ?? node.data.node.height,
            },
          ])
          return
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
      discardEmpty: (id) => {
        if (freshCards.current.delete(id)) mutate([{ kind: 'delete_node', id }])
      },
    }),
    [mutate, load],
  )

  // positions when the drag interaction began — a tap also fires
  // dragstart/dragstop, and committing an unmoved node would PIN it
  const dragStartPos = useRef<Map<string, { x: number; y: number }>>(new Map())

  const onNodeDragStart = useCallback((_event: unknown, node: FlowNode) => {
    dragging.current = true
    // dragging a just-created card is the human placing it — it's no longer a
    // pending "new card" that Escape should be able to discard
    freshCards.current.delete(node.id)
    const map = byId()
    dragStartPos.current = new Map([...map.values()].map((n) => [n.id, absolutePosition(n, map)]))
  }, [])

  // live snap hint: while a card is dragged near a rail, its landing slot lights up
  const [snapHint, setSnapHint] = useState<string | null>(null)
  const railLookup = useCallback(
    (): RailLookup => buildRailLookup(nodesRef.current, edgesRef.current),
    [],
  )
  const onNodeDrag = useCallback(
    (_event: unknown, node: FlowNode) => {
      if (node.type !== 'text' && node.type !== 'file' && node.type !== 'link') return
      const map = byId()
      const current = map.get(node.id)
      if (!current) return
      const a = absolutePosition(current, map)
      const hit = nearestSlot(railLookup(), a.x + current.data.node.width / 2, a.y + current.data.node.height / 2)
      const hint = hit?.jointId ?? null
      setSnapHint((previous) => (previous === hint ? previous : hint))
    },
    [railLookup],
  )

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: FlowNode, draggedNodes: FlowNode[]) => {
      dragging.current = false
      setSnapHint(null)
      const map = byId()
      const lookup = railLookup()
      const moves = new Map<string, { x: number; y: number }>()
      const railChanges: Mutation[] = []
      // cards a rail seats itself — committing their raw drop position would
      // fight the snap
      const skipGeometry = new Set<string>()
      // cards that merely rode a dragged rail: their geometry commits, but the
      // hub must not pin them (the human arranged the rail, not each card)
      const ridingCards = new Set<string>()
      const movedEnough = (id: string, pos: { x: number; y: number }) => {
        const start = dragStartPos.current.get(id)
        return !start || Math.abs(start.x - pos.x) > 0.5 || Math.abs(start.y - pos.y) > 0.5
      }

      for (const dragged of draggedNodes) {
        const current = map.get(dragged.id)
        if (!current) continue
        const now = absolutePosition(current, map)
        moves.set(dragged.id, now)
        // moving a group moves its members' absolute positions too
        if (current.type === 'group' || current.type === 'railGroup') {
          for (const child of map.values()) {
            if (child.parentId === current.id && !moves.has(child.id)) {
              moves.set(child.id, absolutePosition(child, map))
            }
          }
        }
        // a moved rail carries its attached cards — they are edge-linked, not RF children
        if (current.type === 'railGroup') {
          const start = dragStartPos.current.get(current.id)
          const ddx = start ? now.x - start.x : 0
          const ddy = start ? now.y - start.y : 0
          if (ddx !== 0 || ddy !== 0) {
            for (const [cardId, at] of lookup.cardRail) {
              if (at.railId !== current.id || moves.has(cardId)) continue
              const cardStart = dragStartPos.current.get(cardId)
              if (cardStart) {
                moves.set(cardId, { x: cardStart.x + ddx, y: cardStart.y + ddy })
                ridingCards.add(cardId)
              }
            }
          }
        }
        // rail snap: a card dropped on/near a shaft attaches to the nearest slot;
        // an attached card dragged well clear of its joint detaches
        if (
          (current.type === 'text' || current.type === 'file' || current.type === 'link') &&
          movedEnough(current.id, now)
        ) {
          const cx = now.x + current.data.node.width / 2
          const cy = now.y + current.data.node.height / 2
          const hit = nearestSlot(lookup, cx, cy)
          const attachedAt = lookup.cardRail.get(current.id)
          const ownSlot = hit && attachedAt && hit.railId === attachedAt.railId && hit.slot === attachedAt.slot
          if (hit && !ownSlot) {
            // dropped on the rail itself: seat it at that slot (occupied = insert)
            railChanges.push({ kind: 'rail_attach', rail: hit.railId, card: current.id, slot: hit.slot + 1 })
            skipGeometry.add(current.id)
          }
          // near its OWN slot: the human is adjusting the hang (e.g. pulling the
          // card closer than the snap radius) — re-seating would undo exactly
          // that, so the geometry commit stands and the attachment just holds
          // dropped anywhere else: the geometry commit stands. For an attached
          // card that means the human is adjusting its hang — which side of
          // the rail and how long the line is are theirs to choose (CEO
          // 2026-07-08); the attachment holds and the line just follows.
          // Detaching stays explicit: delete the dashed edge.
        }
      }
      const changed = [...moves.entries()].filter(
        ([id, pos]) => !skipGeometry.has(id) && movedEnough(id, pos),
      )
      mutate([
        ...changed.map(
          ([id, pos]) =>
            ({
              kind: 'set_geometry',
              id,
              x: pos.x,
              y: pos.y,
              ...(ridingCards.has(id) ? { pin: false } : {}),
            }) as Mutation,
        ),
        ...railChanges,
      ])
      if (pendingReload.current) {
        pendingReload.current = false
        // if we just committed moves, loading NOW would fetch pre-commit
        // state and visually snap the card back ("card jumped/disappeared") —
        // our own mutate broadcasts board_changed and refreshes with truth
        if (changed.length === 0 && railChanges.length === 0) void load()
      }
    },
    [mutate, load, railLookup],
  )

  // true during a connection drag → cards force all handles mounted so a
  // hover-revealed source handle doesn't unmount when the pointer leaves it
  const [connecting, setConnecting] = useState(false)

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      // releasing over your own card must not create a self-loop — the
      // "tiny arrowhead on my own card" bug (drag right/down, let go)
      if (connection.source === connection.target) return
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

  // drop-anywhere-on-the-card fallback: React Flow only completes a
  // connection within connectionRadius of a HANDLE POINT (side midpoints),
  // so "the line touches the target card" did nothing unless it reached the
  // middle of a side. When the drop misses every handle, hit-test the drop
  // point against card rects (+tolerance) and wire the edge ourselves,
  // anchored on the target side that faces the source.
  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      connectionState: {
        isValid: boolean | null
        fromNode: FlowNode | null
        fromHandle: { type: string; id?: string | null } | null
      },
    ) => {
      setConnecting(false) // connection drag ended (valid or not)
      if (connectionState.isValid) return // a handle caught it — onConnect handled this drop
      const fromNode = connectionState.fromNode
      if (!fromNode || connectionState.fromHandle?.type !== 'source') return
      const { clientX, clientY } =
        'changedTouches' in event ? event.changedTouches[0] : (event as MouseEvent)
      const p = screenToFlowPosition({ x: clientX, y: clientY })
      const TOLERANCE = 24 // finger-friendly: grazing the card edge counts
      const map = byId()
      const s = map.get(fromNode.id)
      if (!s) return
      let hit: PSFlowNode | undefined
      for (const n of map.values()) {
        if (n.id === fromNode.id || n.data.node.type === 'group') continue
        const a = absolutePosition(n, map)
        const { width, height } = n.data.node
        if (
          p.x >= a.x - TOLERANCE &&
          p.x <= a.x + width + TOLERANCE &&
          p.y >= a.y - TOLERANCE &&
          p.y <= a.y + height + TOLERANCE
        ) {
          hit = n
          break
        }
      }
      if (!hit) return
      const sa = absolutePosition(s, map)
      const ha = absolutePosition(hit, map)
      const dx = ha.x + hit.data.node.width / 2 - (sa.x + s.data.node.width / 2)
      const dy = ha.y + hit.data.node.height / 2 - (sa.y + s.data.node.height / 2)
      const toSide = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'left' : 'right') : dy > 0 ? 'top' : 'bottom'
      mutate([
        {
          kind: 'add_edge',
          from: fromNode.id,
          to: hit.id,
          fromSide: connectionState.fromHandle?.id ?? undefined,
          toSide,
        },
      ])
    },
    [mutate, screenToFlowPosition],
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
        freshCards.current.add(added)
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

  // ── clipboard: copy/paste shared by ⌘C/⌘V, the touch toolbar, and the
  // context menu. clipWrite/clipRead fall back to an in-app clipboard when
  // navigator.clipboard is unavailable (plain-http origins — the primary
  // self-hosted path). Plain text from anywhere pastes as a new card.
  const selectionRef = useRef(selection)
  selectionRef.current = selection

  /** copy the given cards (default: current selection) plus the edges between them */
  const copyCards = useCallback((wanted?: string[]): boolean => {
    const ids = new Set(wanted ?? selectionRef.current.nodes)
    if (ids.size === 0) return false
    const map = byId()
    const cards = [...ids]
      .map((id) => map.get(id))
      .filter((n): n is PSFlowNode => !!n && (n.type === 'text' || n.type === 'file' || n.type === 'link'))
    if (cards.length === 0) return false
    const payload: ClipPayload = {
      canvai: 1,
      cards: cards.map((n) => {
        const abs = absolutePosition(n, map)
        const node = n.data.node
        return {
          id: n.id,
          type: node.type,
          text: node.text,
          file: node.file,
          url: node.url,
          color: node.color,
          x: abs.x,
          y: abs.y,
          width: node.width,
          height: node.height,
        }
      }),
      edges: edgesRef.current
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          from: e.source,
          to: e.target,
          fromSide: (e.sourceHandle as string | null) ?? undefined,
          toSide: (e.targetHandle as string | null) ?? undefined,
          label: typeof e.label === 'string' ? e.label : undefined,
        })),
    }
    void clipWrite(JSON.stringify(payload))
    return true
  }, [])

  /** paste at `at` (flow coords: payload top-left lands there) or offset from the original spot */
  const pasteClipboard = useCallback(
    (at?: { x: number; y: number }) => {
      void (async () => {
        const text = await clipRead()
        if (!text.trim()) return
        const payload = parsePayload(text)
        try {
          if (payload) {
            const minX = Math.min(...payload.cards.map((c) => c.x))
            const minY = Math.min(...payload.cards.map((c) => c.y))
            const dx = at ? at.x - minX : 32
            const dy = at ? at.y - minY : 32
            const batch = payload.cards.map((c) =>
              c.type === 'file' && c.file
                ? ({
                    kind: 'add_file_node',
                    x: c.x + dx,
                    y: c.y + dy,
                    file: c.file,
                    width: c.width,
                    height: c.height,
                  } as Mutation)
                : ({
                    kind: 'add_text_node',
                    x: c.x + dx,
                    y: c.y + dy,
                    text: c.type === 'link' && c.url ? c.url : (c.text ?? ''),
                    width: c.width,
                    height: c.height,
                  } as Mutation),
            )
            const result = await api.mutate(path, batch)
            const newIds = result.summary
              .filter((line) => line.startsWith('added '))
              .map((line) => line.slice('added '.length))
            const idMap = new Map(payload.cards.map((c, i) => [c.id, newIds[i]]))
            const follow: Mutation[] = []
            payload.cards.forEach((c, i) => {
              const id = newIds[i]
              if (id && c.color) follow.push({ kind: 'set_color', id, color: c.color })
            })
            for (const e of payload.edges ?? []) {
              const from = idMap.get(e.from)
              const to = idMap.get(e.to)
              if (from && to) {
                follow.push({ kind: 'add_edge', from, to, fromSide: e.fromSide, toSide: e.toSide, label: e.label })
              }
            }
            if (follow.length > 0) await api.mutate(path, follow)
          } else {
            // plain text becomes a card
            const p = at ?? screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
            await api.mutate(path, [
              { kind: 'add_text_node', x: at ? p.x : p.x - 150, y: at ? p.y : p.y - 50, text },
            ])
          }
          await load()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })()
    },
    [path, load, screenToFlowPosition],
  )

  useEffect(() => {
    const inEditor = (target: EventTarget | null) =>
      !!(target as HTMLElement | null)?.closest?.('textarea, input, [contenteditable]')
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || (event.key !== 'c' && event.key !== 'v')) return
      if (inEditor(event.target)) return // never hijack copy/paste while typing
      if (event.key === 'c') {
        // only claim ⌘C when we actually copied — else the browser's own copy
        // (e.g. selected chat text) must proceed
        if (copyCards()) event.preventDefault()
      } else {
        event.preventDefault()
        pasteClipboard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyCards, pasteClipboard])

  // rail draw tool: one stroke on the canvas becomes a rail — direction locks
  // to whichever axis dominates, slot count follows the stroke length
  // (length-driven; the agent side grows rails on demand instead)
  const [railDraw, setRailDraw] = useState(false)
  const [railPreview, setRailPreview] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const railStroke = useRef<{ x: number; y: number; rect: DOMRect } | null>(null)
  const RAIL_PITCH = 160
  const lockEnd = (start: { x: number; y: number }, x: number, y: number) =>
    Math.abs(x - start.x) >= Math.abs(y - start.y) ? { x, y: start.y } : { x: start.x, y }
  const onRailPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = event.currentTarget.getBoundingClientRect()
    railStroke.current = { x: event.clientX, y: event.clientY, rect }
    setRailPreview({
      x1: event.clientX - rect.left,
      y1: event.clientY - rect.top,
      x2: event.clientX - rect.left,
      y2: event.clientY - rect.top,
    })
  }, [])
  const onRailPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const s = railStroke.current
    if (!s) return
    const end = lockEnd(s, event.clientX, event.clientY)
    setRailPreview({ x1: s.x - s.rect.left, y1: s.y - s.rect.top, x2: end.x - s.rect.left, y2: end.y - s.rect.top })
  }, [])
  // Esc backs out of the draw mode — a mode with no exit key feels like a trap
  useEffect(() => {
    if (!railDraw) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      railStroke.current = null
      setRailPreview(null)
      setRailDraw(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [railDraw])

  const onRailPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const s = railStroke.current
      railStroke.current = null
      setRailPreview(null)
      setRailDraw(false)
      if (!s) return
      const end = lockEnd(s, event.clientX, event.clientY)
      const a = screenToFlowPosition({ x: s.x, y: s.y })
      const b = screenToFlowPosition(end)
      const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
      const length = Math.abs(horizontal ? b.x - a.x : b.y - a.y)
      if (length < 40) return // a click, not a stroke
      const slots = Math.max(2, Math.round(length / RAIL_PITCH) + 1)
      // the stroke is the shaft line; origin is the first joint's top-left
      const origin = horizontal
        ? { x: Math.min(a.x, b.x) - 5, y: a.y - 5 }
        : { x: a.x - 5, y: Math.min(a.y, b.y) - 5 }
      mutate([
        { kind: 'add_rail', orient: horizontal ? 'h' : 'v', x: Math.round(origin.x), y: Math.round(origin.y), slots },
      ])
    },
    [mutate, screenToFlowPosition],
  )

  // touch: select-then-drag (CEO decision 2026-07-05). A card must be tapped
  // (selected) before it will drag — kills accidental drags while panning,
  // and pairs with the drag shield (nodes.tsx) that puts blank space under
  // the finger where iOS would otherwise claim text gestures. Mouse keeps
  // direct drag.
  const renderNodes = useMemo(() => {
    let rendered = coarse
      ? nodes.map((n) => ({ ...n, draggable: n.type === 'railJoint' ? false : !!n.selected }))
      : nodes
    if (snapHint) {
      rendered = rendered.map((n) => (n.id === snapHint ? { ...n, data: { ...n.data, snap: true } } : n))
    }
    return rendered
  }, [coarse, nodes, snapHint])

  // force-select on click — some iOS tap sequences (e.g. first tap after
  // the keyboard dismisses) deliver the click without React Flow
  // registering selection, and the toolbar never appears
  // touch multi-select: the toolbar's ☑ arms this mode, then every tap
  // toggles a card in/out of the selection (keyboard modifiers don't exist
  // on touch). Cleared automatically when the selection empties (pane tap).
  const [multiMode, setMultiMode] = useState(false)
  useEffect(() => {
    if (multiMode && selection.nodes.length === 0) setMultiMode(false)
  }, [multiMode, selection.nodes.length])

  const onNodeClick = useCallback(
    (event: ReactMouseEvent, node: FlowNode) => {
      // shift/cmd-click is a multi-select gesture — forcing single selection
      // here was clobbering React Flow's own multi-select handling
      if (event.shiftKey || event.metaKey || event.ctrlKey) return
      if (multiMode) {
        setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, selected: !n.selected } : n)))
        setSelection((prev) => {
          const has = prev.nodes.includes(node.id)
          return { nodes: has ? prev.nodes.filter((i) => i !== node.id) : [...prev.nodes, node.id], edges: [] }
        })
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
    [setNodes, multiMode],
  )

  // ── context menu (fine pointers): right-click is the mouse analog of the
  // touch long-press — same actions the touch toolbar offers, at the cursor.
  // Suppressed for coarse primary pointers (long-press → toolbar covers it,
  // and iOS synthesizes contextmenu events from long-presses).
  const [ctxMenu, setCtxMenu] = useState<null | { x: number; y: number; kind: 'node' | 'edge' | 'pane'; id?: string }>(
    null,
  )
  useEffect(() => {
    if (!ctxMenu) return
    const close = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest?.('.ps-ctxmenu')) return
      setCtxMenu(null)
    }
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('pointerdown', close, { capture: true })
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('pointerdown', close, { capture: true })
      window.removeEventListener('keydown', onEsc)
    }
  }, [ctxMenu])

  const onNodeContextMenu = useCallback(
    (event: ReactMouseEvent, node: FlowNode) => {
      event.preventDefault()
      if (coarse || node.type === 'railJoint') return
      // select the node the menu is about — the actions read the selection
      setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, selected: true } : { ...n, selected: false })))
      setSelection({ nodes: [node.id], edges: [] })
      setCtxMenu({ x: event.clientX, y: event.clientY, kind: 'node', id: node.id })
    },
    [coarse, setNodes],
  )
  const onEdgeContextMenu = useCallback(
    (event: ReactMouseEvent, edge: FlowEdge) => {
      event.preventDefault()
      if (coarse) return
      setCtxMenu({ x: event.clientX, y: event.clientY, kind: 'edge', id: edge.id })
    },
    [coarse],
  )
  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault()
      if (coarse) return
      setCtxMenu({ x: event.clientX, y: event.clientY, kind: 'pane' })
    },
    [coarse],
  )

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
       <Connecting.Provider value={connecting}>
        <EditRequest.Provider value={editReq}>
          <ReactFlow
            nodes={renderNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={() => setConnecting(true)}
            onConnectEnd={onConnectEnd}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onSelectionChange={onSelectionChange}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            // touch: no keyboard delete — the toolbar 🗑 (with confirm) is
            // the delete path; a lingering selection + Backspace was a trap
            deleteKeyCode={coarse ? null : ['Backspace', 'Delete']}
            // touch: edges are 1.6px lines — give the finger a fatter target
            defaultEdgeOptions={coarse ? { interactionWidth: 32 } : undefined}
            connectionRadius={44}
            // no self-loops: also stops the connection preview from snapping
            // back onto the card the drag started from
            isValidConnection={(c) => c.source !== c.target}
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
       </Connecting.Provider>
      </BoardActions.Provider>
      <button className="ps-addcard" onClick={addCard} title="add a text card at the viewport center">
        {t('card.add')}
      </button>
      <button
        className={`ps-addrail${railDraw ? ' is-active' : ''}`}
        onClick={() => setRailDraw((v) => !v)}
        title={coarse ? t('rail.hint.touch') : t('rail.hint')}
      >
        ⇥ {t('rail.add')}
      </button>
      {coarse && (
        <button className="ps-paste" onClick={() => pasteClipboard()} title={t('toolbar.paste')}>
          📋
        </button>
      )}
      {railDraw && (
        <div
          className="ps-raildraw"
          onPointerDown={onRailPointerDown}
          onPointerMove={onRailPointerMove}
          onPointerUp={onRailPointerUp}
          onPointerCancel={() => {
            railStroke.current = null
            setRailPreview(null)
            setRailDraw(false)
          }}
        >
          <div className="ps-raildraw-hint">{coarse ? t('rail.hint.touch') : t('rail.hint')}</div>
          {railPreview &&
            (() => {
              // truthful preview: show the slots the release will actually create
              const dx = railPreview.x2 - railPreview.x1
              const dy = railPreview.y2 - railPreview.y1
              const len = Math.hypot(dx, dy)
              const pitchPx = RAIL_PITCH * getZoom()
              const slots = Math.max(2, Math.round(len / pitchPx) + 1)
              const ux = len > 0 ? dx / len : 1
              const uy = len > 0 ? dy / len : 0
              const endX = railPreview.x1 + ux * pitchPx * (slots - 1)
              const endY = railPreview.y1 + uy * pitchPx * (slots - 1)
              const dots = Array.from({ length: slots }, (_, i) => ({
                cx: railPreview.x1 + ux * pitchPx * i,
                cy: railPreview.y1 + uy * pitchPx * i,
              }))
              // rails always order slots by ascending coordinate, so the
              // arrowhead of the CREATED rail sits at the max end — show that
              // truthfully even when the stroke was drawn right-to-left
              const horiz = Math.abs(dx) >= Math.abs(dy)
              const ax = horiz ? Math.max(railPreview.x1, endX) : railPreview.x1
              const ay = horiz ? railPreview.y1 : Math.max(railPreview.y1, endY)
              const tri = horiz
                ? `${ax + 12},${ay} ${ax},${ay - 8} ${ax},${ay + 8}`
                : `${ax},${ay + 12} ${ax - 8},${ay} ${ax + 8},${ay}`
              return (
                <>
                  <svg className="ps-raildraw-svg">
                    <line x1={railPreview.x1} y1={railPreview.y1} x2={endX} y2={endY} />
                    {dots.map((d, i) => (
                      <circle key={i} cx={d.cx} cy={d.cy} r={6} />
                    ))}
                    <polygon points={tri} />
                  </svg>
                  <div
                    className="ps-raildraw-count"
                    style={{ left: railPreview.x2 + 16, top: railPreview.y2 - 34 }}
                  >
                    {slots} slots
                  </div>
                </>
              )
            })()}
        </div>
      )}
      {coarse && (selNode || selEdge || selection.nodes.length > 1) && (
        <div className="ps-toolbar">
          {colorMode && (selNode || selection.nodes.length > 1) ? (
            <>
              <button onClick={() => setColorMode(false)} aria-label="back">
                ←
              </button>
              {Object.entries(CANVAS_COLORS).map(([key, hex]) => (
                <button
                  key={key}
                  className="ps-colordot"
                  style={{ background: hex }}
                  onClick={() =>
                    mutate(
                      (selNode ? [selNode.id] : selection.nodes).map(
                        (id) => ({ kind: 'set_color', id, color: key }) as Mutation,
                      ),
                    )
                  }
                  aria-label={`color ${key}`}
                />
              ))}
              <button
                className="ps-colordot ps-colordot-none"
                onClick={() =>
                  mutate(
                    (selNode ? [selNode.id] : selection.nodes).map(
                      (id) => ({ kind: 'set_color', id, color: '' }) as Mutation,
                    ),
                  )
                }
                aria-label="clear color"
              >
                ⊘
              </button>
            </>
          ) : selection.nodes.length > 1 ? (
            <>
              <button onClick={() => copyCards()}>⧉ {t('toolbar.copy')}</button>
              <button onClick={() => setColorMode(true)} aria-label="cards color">
                🎨
              </button>
              <button
                className="ps-toolbar-danger"
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true)
                    window.setTimeout(() => setConfirmDelete(false), 3000)
                    return
                  }
                  mutate(selection.nodes.map((id) => ({ kind: 'delete_node', id }) as Mutation))
                }}
              >
                {confirmDelete ? `❗${t('toolbar.delete.confirm')}` : `🗑 ${selection.nodes.length}`}
              </button>
              <button
                onClick={() => {
                  setMultiMode(false)
                  setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
                  setSelection({ nodes: [], edges: [] })
                }}
                aria-label="exit multi-select"
              >
                ☒
              </button>
            </>
          ) : selNode ? (
            <>
              {(selNode.type === 'text' || selNode.type === 'group' || selNode.type === 'railGroup') && (
                <button onClick={() => requestEdit(selNode.id)}>✏️ {t('toolbar.edit')}</button>
              )}
              <button onClick={() => setColorMode(true)} aria-label="card color">
                🎨
              </button>
              {selNode.type !== 'railGroup' && selNode.type !== 'group' && (
                <button onClick={() => copyCards([selNode.id])} aria-label="copy card">
                  ⧉
                </button>
              )}
              <button
                className={multiMode ? 'is-active' : undefined}
                onClick={() => setMultiMode((v) => !v)}
                aria-label="multi-select mode"
              >
                ☑ {t('toolbar.multi')}
              </button>
              <button
                onClick={() =>
                  mutate([{ kind: 'set_discuss', id: selNode.id, discuss: selNode.data.node.discuss === false }])
                }
                aria-label="toggle discuss participation"
              >
                ⏸ {selNode.data.node.discuss === false ? t('toolbar.discuss.rejoin') : t('toolbar.discuss.leave')}
              </button>
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
                {confirmDelete ? `❗${t('toolbar.delete.confirm')}` : `🗑 ${t('toolbar.delete')}`}
              </button>
            </>
          ) : selEdge ? (
            <>
              <button onClick={() => reverseEdge(selEdge)}>⇄ {t('toolbar.reverse')}</button>
              <button
                className="ps-toolbar-danger"
                onClick={() => mutate([{ kind: 'delete_edge', id: selEdge.id }])}
              >
                🗑 {t('toolbar.delete')}
              </button>
            </>
          ) : null}
        </div>
      )}
      {ctxMenu &&
        (() => {
          const menuNode = ctxMenu.kind === 'node' ? nodes.find((n) => n.id === ctxMenu.id) : undefined
          const menuEdge = ctxMenu.kind === 'edge' ? edges.find((e) => e.id === ctxMenu.id) : undefined
          const close = () => setCtxMenu(null)
          const isCard = menuNode && (menuNode.type === 'text' || menuNode.type === 'file' || menuNode.type === 'link')
          return (
            <div
              className="ps-ctxmenu"
              style={{
                left: Math.min(ctxMenu.x, window.innerWidth - 210),
                top: Math.min(ctxMenu.y, window.innerHeight - 260),
              }}
            >
              {menuNode && (
                <>
                  {(menuNode.type === 'text' || menuNode.type === 'group' || menuNode.type === 'railGroup') && (
                    <button
                      onClick={() => {
                        requestEdit(menuNode.id)
                        close()
                      }}
                    >
                      ✏️ {t('toolbar.edit')}
                    </button>
                  )}
                  <div className="ps-ctxmenu-colors">
                    {Object.entries(CANVAS_COLORS).map(([key, hex]) => (
                      <button
                        key={key}
                        className="ps-colordot"
                        style={{ background: hex }}
                        onClick={() => {
                          mutate([{ kind: 'set_color', id: menuNode.id, color: key }])
                          close()
                        }}
                        aria-label={`color ${key}`}
                      />
                    ))}
                    <button
                      className="ps-colordot ps-colordot-none"
                      onClick={() => {
                        mutate([{ kind: 'set_color', id: menuNode.id, color: '' }])
                        close()
                      }}
                      aria-label="clear color"
                    >
                      ⊘
                    </button>
                  </div>
                  {isCard && (
                    <button
                      onClick={() => {
                        copyCards([menuNode.id])
                        close()
                      }}
                    >
                      ⧉ {t('toolbar.copy')}
                    </button>
                  )}
                  {isCard && (
                    <button
                      onClick={() => {
                        mutate([
                          { kind: 'set_discuss', id: menuNode.id, discuss: menuNode.data.node.discuss === false },
                        ])
                        close()
                      }}
                    >
                      ⏸{' '}
                      {menuNode.data.node.discuss === false
                        ? t('toolbar.discuss.rejoin')
                        : t('toolbar.discuss.leave')}
                    </button>
                  )}
                  <button
                    className="ps-toolbar-danger"
                    onClick={() => {
                      mutate([{ kind: 'delete_node', id: menuNode.id }])
                      close()
                    }}
                  >
                    🗑 {t('toolbar.delete')}
                  </button>
                </>
              )}
              {menuEdge && (
                <>
                  <button
                    onClick={() => {
                      reverseEdge(menuEdge)
                      close()
                    }}
                  >
                    ⇄ {t('toolbar.reverse')}
                  </button>
                  <button
                    className="ps-toolbar-danger"
                    onClick={() => {
                      mutate([{ kind: 'delete_edge', id: menuEdge.id }])
                      close()
                    }}
                  >
                    🗑 {t('toolbar.delete')}
                  </button>
                </>
              )}
              {ctxMenu.kind === 'pane' && (
                <>
                  <button
                    onClick={() => {
                      void addCardAt({ x: ctxMenu.x, y: ctxMenu.y })
                      close()
                    }}
                  >
                    {t('card.add')}
                  </button>
                  <button
                    onClick={() => {
                      pasteClipboard(screenToFlowPosition({ x: ctxMenu.x, y: ctxMenu.y }))
                      close()
                    }}
                  >
                    📋 {t('toolbar.paste')}
                  </button>
                </>
              )}
            </div>
          )
        })()}
      {error && <div className="ps-error">{error}</div>}
      {debugTouch && (
        <pre className="ps-debug">
          {debugLines.join('\n') || 'debugtouch: touch events show here'}
        </pre>
      )}
    </div>
  )
}
