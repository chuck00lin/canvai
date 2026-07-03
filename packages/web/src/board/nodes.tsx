import { useContext, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Handle, NodeResizer, Position, type NodeProps, type NodeTypes } from '@xyflow/react'
import { BoardActions } from './actions'
import { colorOf, type PSFlowNode } from './mapping'
import { Markdown } from '../markdown'

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
  const { commitText, commitGeometry } = useContext(BoardActions)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const node = data.node

  const finish = (save: boolean) => {
    setEditing(false)
    if (save && draft !== (node.text ?? '')) commitText(id, draft)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') finish(false)
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') finish(true)
  }

  return (
    <div
      className={`ps-card ps-text${selected ? ' is-selected' : ''}`}
      style={tintStyle(node.color)}
      onDoubleClick={(event) => {
        event.stopPropagation()
        setDraft(node.text ?? '')
        setEditing(true)
      }}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={120}
        minHeight={48}
        onResizeEnd={(_, params) => commitGeometry(id, params)}
      />
      <Sides />
      <Pin pinned={data.pinned} />
      {editing ? (
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
    </div>
  )
}

function FileNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitGeometry } = useContext(BoardActions)
  const node = data.node
  return (
    <div className={`ps-card ps-file${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)}>
      <NodeResizer isVisible={!!selected} minWidth={120} minHeight={40} onResizeEnd={(_, p) => commitGeometry(id, p)} />
      <Sides />
      <Pin pinned={data.pinned} />
      <span className="ps-file-icon">📄</span>
      <span className="ps-file-path">
        {node.file}
        {typeof node.subpath === 'string' ? node.subpath : ''}
      </span>
    </div>
  )
}

function LinkNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitGeometry } = useContext(BoardActions)
  const node = data.node
  return (
    <div className={`ps-card ps-link${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)}>
      <NodeResizer isVisible={!!selected} minWidth={120} minHeight={40} onResizeEnd={(_, p) => commitGeometry(id, p)} />
      <Sides />
      <Pin pinned={data.pinned} />
      <a href={node.url} target="_blank" rel="noreferrer" className="nodrag">
        🔗 {node.url}
      </a>
    </div>
  )
}

function GroupNode({ id, data, selected }: NodeProps<PSFlowNode>) {
  const { commitLabel, commitGeometry } = useContext(BoardActions)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const node = data.node

  return (
    <div className={`ps-group${selected ? ' is-selected' : ''}`} style={tintStyle(node.color)}>
      <NodeResizer isVisible={!!selected} minWidth={160} minHeight={120} onResizeEnd={(_, p) => commitGeometry(id, p)} />
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

export const nodeTypes: NodeTypes = {
  text: TextNode,
  file: FileNode,
  link: LinkNode,
  group: GroupNode,
}
