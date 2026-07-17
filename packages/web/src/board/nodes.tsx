import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps, type NodeTypes } from '@xyflow/react'
import { api, compressImage } from '../api'
import { BoardActions, Connecting, EditRequest } from './actions'
import { colorOf, RAIL_MARK, type PSFlowNode } from './mapping'
import { Markdown } from '../markdown'
import { useLongPress } from './useLongPress'
import { COARSE_QUERY, PHONE_QUERY, useMediaQuery } from '../useMediaQuery'
import { useT } from '../i18n'

// ?noshield: on-device A/B for the center-dead-zone mechanism. The shield
// made the symptom disappear; disabling it (with &debugtouch recording)
// is the controlled experiment that proves/refutes "iOS claims gestures
// that start on text" as the actual trigger.
const NO_SHIELD = new URLSearchParams(window.location.search).has('noshield')

/** listen for toolbar-initiated edit requests (touch has no double-click) */
function useEditRequest(id: string, begin: () => void) {
  const editReq = useContext(EditRequest)
  useEffect(() => {
    if (editReq.seq > 0 && editReq.id === id) begin()
    // react to the request bump only; begin() is guarded against re-entry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editReq])
}

/**
 * Phone editor: a card-sized inline textarea under a soft keyboard is
 * unusable, so editing gets a full-screen modal.
 *
 * Backdrop rules learned in the field (2026-07-04 lost-text incident):
 * - the long-press that OPENS the editor synthesizes a click on release,
 *   which can land on the backdrop — ignore backdrop input during a short
 *   grace period after mount;
 * - after that, backdrop tap = SAVE. Only the explicit 取消 button
 *   discards — a stray tap must never silently destroy typed text.
 */
function PhoneEditor(props: {
  draft: string
  setDraft: (value: string) => void
  onCancel: () => void
  onSave: () => void
  onAttach: () => void
}) {
  const t = useT()
  const mountedAt = useRef(performance.now())
  const onBackdrop = () => {
    if (performance.now() - mountedAt.current < 600) return
    props.onSave()
  }
  return createPortal(
    <div className="ps-modal" onClick={onBackdrop}>
      <div className="ps-modal-card" onClick={(event) => event.stopPropagation()}>
        <textarea
          autoFocus
          value={props.draft}
          onChange={(event) => props.setDraft(event.target.value)}
          placeholder={t('editor.placeholder')}
        />
        <div className="ps-modal-actions">
          <button onClick={props.onAttach} aria-label="attach an image into this card">
            📎
          </button>
          <button onClick={props.onCancel}>{t('editor.cancel')}</button>
          <button className="ps-primary" onClick={props.onSave}>
            {t('editor.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const

/**
 * Node connection handles. targets first (underneath, drop-only), sources on
 * top: a drag that starts on a node always starts from a SOURCE handle, so the
 * arrow points the way you dragged — edge direction is semantics for the agent.
 *
 * Lazy mount (perf): 8 handles/card is a big chunk of DOM on a large board.
 * SOURCE handles (4) stay ALWAYS mounted — a new connection must be able to
 * START from any side at any time, and React Flow will not reliably begin a
 * connection from a handle that only just mounted (dynamic-handle limitation).
 * TARGET handles (4) are lazy: needed only as drop points, and (a) the
 * `connecting` context mounts every card's full set during a drag so drops
 * snap, (b) the drop-anywhere fallback (onConnectEnd) hit-tests card rects
 * anyway. So at rest a card carries 4 handles, not 8 — plus any a live edge
 * anchors to (`used`, kept mounted so edges don't jump).
 */
function Sides({ used, interactive }: { used?: string[]; interactive?: boolean }) {
  // sources always; targets on demand (interactive = hover/select/connecting)
  const show = (key: string) => key.startsWith('s-') || interactive || used?.includes(key)
  return (
    <>
      {SIDES.map(([id, position]) =>
        show(`t-${id}`) ? (
          <Handle
            key={`t-${id}`}
            id={id}
            type="target"
            position={position}
            className="ps-handle"
            isConnectableStart={false}
          />
        ) : null,
      )}
      {SIDES.map(([id, position]) =>
        show(`s-${id}`) ? (
          <Handle key={`s-${id}`} id={id} type="source" position={position} className="ps-handle" />
        ) : null,
      )}
    </>
  )
}

/**
 * "should this card mount all its handles" — true on hover (mouse) or while a
 * connection drag is in flight (so a hover-revealed source handle doesn't
 * unmount mid-drag when the pointer leaves the card). Nodes OR this with
 * `selected` (touch has no hover). Returns hover handlers for the outer div.
 *
 * CRITICAL: when the handle set changes we must `updateNodeInternals(id)` —
 * React Flow measures a node's handles once on mount; a lazily-added handle is
 * invisible to the connection system until this re-measure, so a drag from it
 * never starts. This is the documented requirement for dynamic handles.
 */
function useHover(id: string): [boolean, { onPointerEnter: () => void; onPointerLeave: () => void }] {
  const [hovered, setHovered] = useState(false)
  const connecting = useContext(Connecting)
  const active = hovered || connecting
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [active, id, updateNodeInternals])
  return [active, { onPointerEnter: () => setHovered(true), onPointerLeave: () => setHovered(false) }]
}

function Pin({ pinned }: { pinned: boolean }) {
  if (!pinned) return null
  return (
    <span className="ps-pin" title="pinned — auto-layout will not move this node">
      📌
    </span>
  )
}

function tintStyle(color?: string): CSSProperties | undefined {
  const tint = colorOf(color)
  return tint ? ({ '--tint': tint } as CSSProperties) : undefined
}

function TextNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitText, commitGeometry, notifyEditing, discardEmpty } = useContext(BoardActions)
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [hovered, hoverProps] = useHover(id)
  const phone = useMediaQuery(PHONE_QUERY)
  const coarse = useMediaQuery(COARSE_QUERY)
  const node = data.node

  const begin = () => {
    if (editing) return
    setDraft(node.text ?? '')
    setEditing(true)
    notifyEditing(true)
  }
  const finish = (save: boolean) => {
    if (!editing) return
    setEditing(false)
    notifyEditing(false)
    // a just-created card left empty is discarded ONLY on an explicit cancel
    // (Escape, save=false). A blur — from dragging the card or clicking away —
    // means the human is keeping it (they placed it), so leave the empty card
    // be; they can fill or delete it. (CEO 2026-07-16: a freshly double-click
    // -created card vanished mid-drag because the drag blurred its editor.)
    // EXCEPT while an image attach is in flight: the picker blurs the editor.
    const result = save ? draft : (node.text ?? '')
    if ((node.text ?? '') === '' && result.trim() === '') {
      if (!save && !attaching.current) discardEmpty(id)
      return
    }
    if (save && draft !== (node.text ?? '')) commitText(id, draft)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') finish(false)
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') finish(true)
  }
  useEditRequest(id, begin)
  // 📎 in edit mode: upload → append ![](assets/…) to THIS card's text —
  // the image renders inline with the CEO's notes (annotatable), instead of
  // becoming a separate card. The system picker blurs the inline editor
  // (which saves+closes); `attaching` bridges that gap.
  const attaching = useRef(false)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const imgInput = useRef<HTMLInputElement>(null)
  const armAttach = () => {
    attaching.current = true
    window.setTimeout(() => {
      attaching.current = false // picker cancelled: no change event ever fires
    }, 60_000)
    imgInput.current?.click()
  }
  const onAttachPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    attaching.current = false
    if (!file) return
    const base = draft // text as of the moment the picker was opened
    try {
      const blob = await compressImage(file)
      const name = /\.(jpe?g|png|gif|webp)$/i.test(file.name) ? file.name : `${file.name || 'photo'}.jpg`
      const { path } = await api.upload(blob, name)
      const composed = `${base.trimEnd()}\n\n![](${path})\n`.replace(/^\n+/, '')
      // modal editor stays open across the picker → keep editing the draft;
      // the inline editor was blur-closed by the picker → commit directly
      if (editingRef.current) setDraft(composed)
      else commitText(id, composed)
    } catch {
      // local hub; the board error banner covers mutate failures elsewhere
    }
  }
  // touch: double-tap = edit. Long-press deliberately does NOT edit — it
  // just selects (toolbar + resize handles appear), matching platform
  // convention that a long-press opens options, not an editor
  const press = useLongPress({ onDoubleTap: begin })
  // MUST be referentially stable: React Flow's ResizeControl lists
  // onResizeEnd in an effect that destroys/rebinds the resizer on change —
  // an inline arrow re-created per render killed in-flight TOUCH resize
  // gestures after their first frame (mouse survived: window listeners)
  const onResizeEnd = useCallback(
    (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
      commitGeometry(id, params),
    [commitGeometry, id],
  )

  return (
    // resizer + handles live OUTSIDE the card div: .ps-card clips overflow,
    // which cut the corner grips in half — visually AND for hit-testing
    // (touch resize was dead since Phase 1 because of this)
    <div className={selected ? 'is-selected' : undefined} style={{ width: '100%', height: '100%' }} {...hoverProps}>
      <NodeResizer
        isVisible={!!selected}
        handleClassName="nopan"
        lineClassName="nopan"
        minWidth={120}
        minHeight={48}
        onResizeEnd={onResizeEnd}
      />
      <Sides used={data.usedHandles} interactive={hovered || selected} />
      <div
        className={`ps-card ps-text${selected ? ' is-selected' : ''}${node.discuss === false ? ' is-muted' : ''}`}
        style={tintStyle(node.color)}
        onDoubleClick={(event) => {
          event.stopPropagation()
          begin()
        }}
        {...press}
      >
        <Pin pinned={data.pinned} />
        {editing && !phone ? (
          <>
            <textarea
              className="ps-editor nodrag nowheel"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => finish(true)}
              onKeyDown={onKeyDown}
              placeholder={t('editor.placeholder')}
            />
            <button
              className="ps-attach nodrag"
              // arm BEFORE the textarea blur fires (pointerdown precedes blur)
              onPointerDown={() => {
                attaching.current = true
              }}
              onClick={armAttach}
              aria-label="attach an image into this card"
            >
              📎
            </button>
          </>
        ) : (
          <Markdown text={node.text ?? ''} />
        )}
        {editing && phone && (
          <PhoneEditor
            draft={draft}
            setDraft={setDraft}
            onCancel={() => finish(false)}
            onSave={() => finish(true)}
            onAttach={armAttach}
          />
        )}
        <input
          ref={imgInput}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(event) => void onAttachPick(event)}
        />
        {/* touch drag shield: iOS claims gestures that start ON TEXT (select
            /scroll arbitration) before the app sees them whole — the shield
            puts inert blank space under the finger instead. Only when
            selected (select-then-drag) and never while editing. Double-tap
            and long-press still work: their events bubble through it. */}
        {selected && coarse && !editing && !NO_SHIELD && <div className="ps-dragshield" />}
      </div>
    </div>
  )
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const TEXT_EXTS = new Set(['md', 'markdown', 'txt'])

function FileNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitGeometry } = useContext(BoardActions)
  const [hovered, hoverProps] = useHover(id)
  // MUST be referentially stable: React Flow's ResizeControl lists
  // onResizeEnd in an effect that destroys/rebinds the resizer on change —
  // an inline arrow re-created per render killed in-flight TOUCH resize
  // gestures after their first frame (mouse survived: window listeners)
  const onResizeEnd = useCallback(
    (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
      commitGeometry(id, params),
    [commitGeometry, id],
  )
  const node = data.node
  const file = node.file ?? ''
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const [content, setContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!TEXT_EXTS.has(ext)) return
    let cancelled = false
    api
      .file(file)
      .then((r) => {
        if (!cancelled) setContent(r.text)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [file, ext])

  return (
    <div className={selected ? 'is-selected' : undefined} style={{ width: '100%', height: '100%' }} {...hoverProps}>
      <NodeResizer isVisible={!!selected} handleClassName="nopan" lineClassName="nopan" minWidth={120} minHeight={40} onResizeEnd={onResizeEnd} />
      <Sides used={data.usedHandles} interactive={hovered || selected} />
      <div className={`ps-card ps-file${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)}>
        <Pin pinned={data.pinned} />
        <div className="ps-file-head">
          <span className="ps-file-icon">📄</span>
          <span className="ps-file-path">
            {file}
            {typeof node.subpath === 'string' ? node.subpath : ''}
          </span>
        </div>
        <div className="ps-file-body nowheel">
          {IMAGE_EXTS.has(ext) && <img src={api.fileRawUrl(file)} alt={file} />}
          {TEXT_EXTS.has(ext) && content !== null && <Markdown text={content} />}
          {loadError && <div className="ps-file-error">{loadError}</div>}
        </div>
      </div>
    </div>
  )
}

function LinkNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitGeometry } = useContext(BoardActions)
  const [hovered, hoverProps] = useHover(id)
  // MUST be referentially stable: React Flow's ResizeControl lists
  // onResizeEnd in an effect that destroys/rebinds the resizer on change —
  // an inline arrow re-created per render killed in-flight TOUCH resize
  // gestures after their first frame (mouse survived: window listeners)
  const onResizeEnd = useCallback(
    (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
      commitGeometry(id, params),
    [commitGeometry, id],
  )
  const node = data.node
  return (
    <div className={selected ? 'is-selected' : undefined} style={{ width: '100%', height: '100%' }} {...hoverProps}>
      <NodeResizer isVisible={!!selected} handleClassName="nopan" lineClassName="nopan" minWidth={120} minHeight={40} onResizeEnd={onResizeEnd} />
      <Sides used={data.usedHandles} interactive={hovered || selected} />
      <div className={`ps-card ps-link${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)}>
        <Pin pinned={data.pinned} />
        <a href={node.url} target="_blank" rel="noreferrer" className="nodrag">
          🔗 {node.url}
        </a>
      </div>
    </div>
  )
}

function GroupNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitLabel, commitGeometry, notifyEditing } = useContext(BoardActions)
  const [hovered, hoverProps] = useHover(id)
  // MUST be referentially stable: React Flow's ResizeControl lists
  // onResizeEnd in an effect that destroys/rebinds the resizer on change —
  // an inline arrow re-created per render killed in-flight TOUCH resize
  // gestures after their first frame (mouse survived: window listeners)
  const onResizeEnd = useCallback(
    (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
      commitGeometry(id, params),
    [commitGeometry, id],
  )
  const [editing, setEditingState] = useState(false)
  const [draft, setDraft] = useState('')
  const node = data.node
  const setEditing = (on: boolean) => {
    setEditingState(on)
    notifyEditing(on)
  }
  const beginLabel = () => {
    if (editing) return
    setDraft(node.label ?? '')
    setEditing(true)
  }
  useEditRequest(id, beginLabel)
  const press = useLongPress({ onDoubleTap: beginLabel })

  return (
    <div className={`ps-group${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)} {...press} {...hoverProps}>
      <NodeResizer isVisible={!!selected} handleClassName="nopan" lineClassName="nopan" minWidth={160} minHeight={120} onResizeEnd={onResizeEnd} />
      <Sides used={data.usedHandles} interactive={hovered || selected} />
      <Pin pinned={data.pinned} />
      {editing ? (
        <input
          className="ps-group-label ps-group-input nodrag"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false)
            if (draft !== (node.label ?? '')) commitLabel(id, draft)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <div
          className="ps-group-label"
          onDoubleClick={(event) => {
            event.stopPropagation()
            setDraft(node.label ?? '')
            setEditing(true)
          }}
        >
          {node.label ?? 'group'}
        </div>
      )}
    </div>
  )
}

/**
 * A rail slot. The 10×10 node is spec-real; the visible dot is CSS drawn
 * larger. Not draggable/selectable (mapping.ts) — the grid belongs to the
 * rail. Handles stay so humans can draw attach edges into a slot.
 *
 * All four handles sit STACKED AT THE CENTER (invisible): a joint is a point,
 * so every edge — whatever side id it carries — must visually converge into
 * the dot instead of stopping at the 10×10 box border ("arrows attach to the
 * slot's frame", CEO 2026-07-08).
 */
const JOINT_HANDLE: CSSProperties = {
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 14,
  height: 14,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
  borderRadius: '50%',
  opacity: 0,
}

function JointHandles() {
  return (
    <>
      {SIDES.map(([id, position]) => (
        <Handle
          key={`t-${id}`}
          id={id}
          type="target"
          position={position}
          style={JOINT_HANDLE}
          isConnectableStart={false}
        />
      ))}
      {SIDES.map(([id, position]) => (
        <Handle key={`s-${id}`} id={id} type="source" position={position} style={JOINT_HANDLE} />
      ))}
    </>
  )
}

function RailJointNode({ data }: NodeProps<PSFlowNode>) {
  return (
    <div
      className={`ps-joint${data.occupied ? ' is-occupied' : ''}${data.snap ? ' is-snap' : ''}`}
      title={data.occupied ? undefined : 'empty slot — drop a card here'}
    >
      <JointHandles />
    </div>
  )
}

/**
 * The rail body. Label is edited WITHOUT the RAIL_MARK prefix and the marker
 * is re-attached on save — losing it would demote the rail to a plain group.
 * Resizing is a slot-count gesture: commitGeometry routes rail groups to
 * rail_resize and the hub re-lays the grid from the new length.
 */
function RailGroupNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitLabel, commitGeometry, notifyEditing } = useContext(BoardActions)
  // MUST be referentially stable: React Flow's ResizeControl lists
  // onResizeEnd in an effect that destroys/rebinds the resizer on change —
  // an inline arrow re-created per render killed in-flight TOUCH resize
  // gestures after their first frame (mouse survived: window listeners)
  const onResizeEnd = useCallback(
    (_: unknown, params: { x: number; y: number; width: number; height: number }) =>
      commitGeometry(id, params),
    [commitGeometry, id],
  )
  const [editing, setEditingState] = useState(false)
  const [draft, setDraft] = useState('')
  const node = data.node
  const shown = (node.label ?? '').slice(RAIL_MARK.length).trim()
  const setEditing = (on: boolean) => {
    setEditingState(on)
    notifyEditing(on)
  }
  const beginLabel = () => {
    if (editing) return
    setDraft(shown)
    setEditing(true)
  }
  useEditRequest(id, beginLabel)
  const press = useLongPress({ onDoubleTap: beginLabel })

  return (
    <div className={`ps-rail${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)} {...press}>
      <NodeResizer
        isVisible={!!selected}
        handleClassName="nopan"
        lineClassName="nopan"
        minWidth={70}
        minHeight={70}
        onResizeEnd={onResizeEnd}
      />
      {/* non-connectable: dragging a line from the rail BODY looks like a slot
          attach but isn't — edges belong on the dots. Handles stay in the DOM
          so agent-made group edges still have anchors to render from. */}
      {SIDES.map(([id, position]) => (
        <Handle key={`t-${id}`} id={id} type="target" position={position} className="ps-handle" isConnectable={false} />
      ))}
      {SIDES.map(([id, position]) => (
        <Handle key={`s-${id}`} id={id} type="source" position={position} className="ps-handle" isConnectable={false} />
      ))}
      {editing ? (
        <input
          className="ps-rail-label ps-group-input nodrag"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false)
            if (draft !== shown) commitLabel(id, `${RAIL_MARK} ${draft}`.trimEnd())
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
            if (event.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <div
          className="ps-rail-label"
          onDoubleClick={(event) => {
            event.stopPropagation()
            beginLabel()
          }}
        >
          ⇥ {shown || 'rail'}
        </div>
      )}
    </div>
  )
}

// memo: default shallow compare. A value-comparator (samePSNode) that skipped
// re-renders on unrelated board changes was REVERTED 2026-07-06: on iPad/iPhone
// Safari it unmasked a compositing bug — after heavy interaction + a pan, cards
// stayed in the DOM (node count held at 18 in a device capture) but Safari
// stopped PAINTING them, because without the incidental re-renders nothing
// re-dirtied the memory-evicted GPU tiles. Restoring the re-renders is the
// known-good behavior. The board-growth perf win needs a paint-safe redo
// (repaint nudge on move-end), verified on-device — see DevLog 2026-07-06.
export const nodeTypes: NodeTypes = {
  text: memo(TextNode),
  file: memo(FileNode),
  link: memo(LinkNode),
  group: memo(GroupNode),
  railJoint: memo(RailJointNode),
  railGroup: memo(RailGroupNode),
}
