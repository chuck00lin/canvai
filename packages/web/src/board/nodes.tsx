import { memo, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Handle, NodeResizer, Position, type NodeProps, type NodeTypes } from '@xyflow/react'
import { api } from '../api'
import { BoardActions, EditRequest } from './actions'
import { colorOf, type PSFlowNode } from './mapping'
import { Markdown } from '../markdown'
import { useLongPress } from './useLongPress'
import { COARSE_QUERY, PHONE_QUERY, useMediaQuery } from '../useMediaQuery'

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
}) {
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
          placeholder="markdown — ```mermaid fences render as diagrams"
        />
        <div className="ps-modal-actions">
          <button onClick={props.onCancel}>取消</button>
          <button className="ps-primary" onClick={props.onSave}>
            儲存
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

function Sides() {
  // targets first (underneath, drop-only), sources on top: a drag that starts
  // on a node always starts from a SOURCE handle, so the arrow points the way
  // you dragged — edge direction is semantics for the agent.
  return (
    <>
      {SIDES.map(([id, position]) => (
        <Handle
          key={`t-${id}`}
          id={id}
          type="target"
          position={position}
          className="ps-handle"
          isConnectableStart={false}
        />
      ))}
      {SIDES.map(([id, position]) => (
        <Handle key={`s-${id}`} id={id} type="source" position={position} className="ps-handle" />
      ))}
    </>
  )
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
  const { commitText, commitGeometry, notifyEditing, deleteNode } = useContext(BoardActions)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
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
    // a card that stays empty after editing is invisible junk (the
    // create-then-edit flow starts from '') — remove it instead
    const result = save ? draft : (node.text ?? '')
    if ((node.text ?? '') === '' && result.trim() === '') {
      deleteNode(id)
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
    <div className={selected ? 'is-selected' : undefined} style={{ width: '100%', height: '100%' }}>
      <NodeResizer
        isVisible={!!selected}
        handleClassName="nopan"
        lineClassName="nopan"
        minWidth={120}
        minHeight={48}
        onResizeEnd={onResizeEnd}
      />
      <Sides />
      <div
        className={`ps-card ps-text${selected ? ' is-selected' : ''}`}
        style={tintStyle(node.color)}
        onDoubleClick={(event) => {
          event.stopPropagation()
          begin()
        }}
        {...press}
      >
        <Pin pinned={data.pinned} />
        {editing && !phone ? (
          <textarea
            className="ps-editor nodrag nowheel"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={onKeyDown}
            placeholder="markdown — ```mermaid fences render as diagrams"
          />
        ) : (
          <Markdown text={node.text ?? ''} />
        )}
        {editing && phone && (
          <PhoneEditor draft={draft} setDraft={setDraft} onCancel={() => finish(false)} onSave={() => finish(true)} />
        )}
        {/* touch drag shield: iOS claims gestures that start ON TEXT (select
            /scroll arbitration) before the app sees them whole — the shield
            puts inert blank space under the finger instead. Only when
            selected (select-then-drag) and never while editing. Double-tap
            and long-press still work: their events bubble through it. */}
        {selected && coarse && !editing && <div className="ps-dragshield" />}
      </div>
    </div>
  )
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const TEXT_EXTS = new Set(['md', 'markdown', 'txt'])

function FileNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitGeometry } = useContext(BoardActions)
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
    <div className={selected ? 'is-selected' : undefined} style={{ width: '100%', height: '100%' }}>
      <NodeResizer isVisible={!!selected} handleClassName="nopan" lineClassName="nopan" minWidth={120} minHeight={40} onResizeEnd={onResizeEnd} />
      <Sides />
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
    <div className={selected ? 'is-selected' : undefined} style={{ width: '100%', height: '100%' }}>
      <NodeResizer isVisible={!!selected} handleClassName="nopan" lineClassName="nopan" minWidth={120} minHeight={40} onResizeEnd={onResizeEnd} />
      <Sides />
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
    <div className={`ps-group${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)} {...press}>
      <NodeResizer isVisible={!!selected} handleClassName="nopan" lineClassName="nopan" minWidth={160} minHeight={120} onResizeEnd={onResizeEnd} />
      <Sides />
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

// memo: board reloads and selection changes hand every node a fresh props
// object — without memo each one re-renders its full markdown body
export const nodeTypes: NodeTypes = {
  text: memo(TextNode),
  file: memo(FileNode),
  link: memo(LinkNode),
  group: memo(GroupNode),
}
