import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api, type BoardInfo } from './api'
import { useT } from './i18n'

/**
 * VS Code / Obsidian-style file tree for the board list. Boards ARE .canvas
 * files in the user's repo — the tree makes that location visible (folders,
 * file extension) instead of hiding it behind a flat list. Rows support
 * rename, delete, and move (drag onto a folder / swipe to reveal on touch).
 */

interface Props {
  boards: BoardInfo[]
  active: string | null
  current: string | null
  coarse: boolean
  onOpen: (path: string) => void
  onNewBoard: (folder?: string) => void
  onDelete: (path: string) => void
  onRename: (from: string, to: string) => void
}

interface Folder {
  name: string
  path: string
  folders: Folder[]
  boards: BoardInfo[]
}

function buildTree(boards: BoardInfo[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], boards: [] }
  const dirOf = (segments: string[]): Folder => {
    let cursor = root
    let acc = ''
    for (const segment of segments) {
      acc = acc ? `${acc}/${segment}` : segment
      let next = cursor.folders.find((f) => f.path === acc)
      if (!next) {
        next = { name: segment, path: acc, folders: [], boards: [] }
        cursor.folders.push(next)
      }
      cursor = next
    }
    return cursor
  }
  for (const board of boards) {
    const segments = board.path.split('/')
    dirOf(segments.slice(0, -1)).boards.push(board)
  }
  const sortAll = (folder: Folder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name))
    folder.boards.sort((a, b) => a.path.localeCompare(b.path))
    folder.folders.forEach(sortAll)
  }
  sortAll(root)
  return root
}

const COLLAPSE_KEY = 'ps-tree-collapsed'
function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

const dirOfPath = (p: string) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}
const baseOfPath = (p: string) =>
  p
    .split('/')
    .pop()!
    .replace(/\.canvas$/, '')

function BoardRow({
  board,
  active,
  current,
  depth,
  coarse,
  onOpen,
  onDelete,
  onRename,
  onDragBoard,
}: {
  board: BoardInfo
  active: string | null
  current: string | null
  depth: number
  coarse: boolean
  onOpen: (path: string) => void
  onDelete: (path: string) => void
  onRename: (from: string, to: string) => void
  onDragBoard: (path: string | null) => void
}) {
  const t = useT()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [swipe, setSwipe] = useState(0) // px the row is slid left (touch)
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const base = baseOfPath(board.path)

  const beginRename = () => {
    setDraft(base)
    setRenaming(true)
    setSwipe(0)
  }
  const commitRename = () => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === base) return
    const dir = dirOfPath(board.path)
    onRename(board.path, `${dir ? dir + '/' : ''}${name}.canvas`)
  }

  // touch swipe-left reveals rename/delete; a mostly-vertical drag is a scroll
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!coarse || renaming) return
    swipeStart.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipeStart.current
    if (!s) return
    const dx = event.clientX - s.x
    const dy = event.clientY - s.y
    if (Math.abs(dy) > Math.abs(dx)) {
      swipeStart.current = null // vertical → let it scroll
      return
    }
    setSwipe(Math.max(0, Math.min(132, -dx)))
  }
  const onPointerUp = () => {
    swipeStart.current = null
    setSwipe((s) => (s > 66 ? 132 : 0)) // snap open or closed
  }

  return (
    <div className="ps-boardrow">
      {coarse && swipe > 0 && (
        <div className="ps-swipe-actions">
          <button className="ps-swipe-rename" onClick={beginRename}>
            {t('board.rename')}
          </button>
          <button className="ps-swipe-delete" onClick={() => onDelete(board.path)}>
            {t('toolbar.delete')}
          </button>
        </div>
      )}
      <div
        className={`ps-boarditem${board.path === current ? ' is-current' : ''}`}
        style={{ paddingLeft: 12 + depth * 14, transform: swipe ? `translateX(-${swipe}px)` : undefined }}
        title={board.path}
        draggable={!coarse && !renaming}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/canvai-board', board.path)
          event.dataTransfer.effectAllowed = 'move'
          onDragBoard(board.path)
        }}
        onDragEnd={() => onDragBoard(null)}
        onClick={() => !renaming && swipe === 0 && onOpen(board.path)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {renaming ? (
          <input
            className="ps-rename-input"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <div className="ps-boardname">
            {base}
            <span className="ps-ext">.canvas</span>
          </div>
        )}
        <div className="ps-boardmeta">
          {board.nodes} nodes · {board.edges} edges
        </div>
        <div className="ps-boardrow-foot">
          <label
            className={`ps-active${board.path === active ? ' is-active' : ''}`}
            title={t('board.activeTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="radio"
              name="active-board"
              checked={board.path === active}
              onChange={() => void api.setActive(board.path)}
            />
            {t('board.active')}
          </label>
          {!coarse && (
            <span className="ps-row-actions">
              <button
                title={t('board.rename')}
                onClick={(event) => {
                  event.stopPropagation()
                  beginRename()
                }}
              >
                ✎
              </button>
              <button
                className="ps-row-delete"
                title={t('toolbar.delete')}
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete(board.path)
                }}
              >
                🗑
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function BoardTree({
  boards,
  active,
  current,
  coarse,
  onOpen,
  onNewBoard,
  onDelete,
  onRename,
}: Props) {
  const t = useT()
  const tree = useMemo(() => buildTree(boards), [boards])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [path]: !prev[path] }
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next))
      } catch {
        // private mode — collapse state just won't persist
      }
      return next
    })
  }, [])

  // drop a board onto a folder = move it there (rename to folder/base.canvas)
  const dropOnFolder = (folderPath: string) => {
    const from = dragging
    setDragging(null)
    setDropFolder(null)
    if (!from) return
    if (dirOfPath(from) === folderPath) return // already here
    const base = from.split('/').pop()!
    onRename(from, `${folderPath ? folderPath + '/' : ''}${base}`)
  }

  const renderBoard = (board: BoardInfo, depth: number) => (
    <BoardRow
      key={board.path}
      board={board}
      active={active}
      current={current}
      depth={depth}
      coarse={coarse}
      onOpen={onOpen}
      onDelete={onDelete}
      onRename={onRename}
      onDragBoard={setDragging}
    />
  )

  const renderFolder = (folder: Folder, depth: number) => {
    const isCollapsed = !!collapsed[folder.path]
    return (
      <div key={folder.path}>
        <div
          className={`ps-folder${dropFolder === folder.path ? ' is-droptarget' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => toggle(folder.path)}
          title={`${folder.path}/`}
          onDragOver={(event) => {
            if (!dragging) return
            event.preventDefault()
            setDropFolder(folder.path)
          }}
          onDragLeave={() => setDropFolder((f) => (f === folder.path ? null : f))}
          onDrop={(event) => {
            event.preventDefault()
            dropOnFolder(folder.path)
          }}
        >
          <span className="ps-folder-chevron">{isCollapsed ? '▸' : '▾'}</span>
          <span className="ps-folder-name">{folder.name}</span>
          <button
            className="ps-folder-add"
            title={t('board.newIn')}
            onClick={(event) => {
              event.stopPropagation()
              onNewBoard(folder.path)
            }}
          >
            ＋
          </button>
        </div>
        {!isCollapsed && (
          <>
            {folder.folders.map((f) => renderFolder(f, depth + 1))}
            {folder.boards.map((b) => renderBoard(b, depth + 1))}
          </>
        )}
      </div>
    )
  }

  return (
    <div
      className={`ps-tree${dropFolder === '' ? ' is-droptarget' : ''}`}
      onDragOver={(event) => {
        if (dragging) {
          event.preventDefault()
          setDropFolder('')
        }
      }}
      onDrop={(event) => {
        // dropped on tree background = move to repo root
        if (dragging && event.target === event.currentTarget) {
          event.preventDefault()
          dropOnFolder('')
        }
      }}
    >
      {tree.folders.map((f) => renderFolder(f, 0))}
      {tree.boards.map((b) => renderBoard(b, 0))}
    </div>
  )
}
