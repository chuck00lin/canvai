import { useCallback, useMemo, useState } from 'react'
import { api, type BoardInfo } from './api'
import { useT } from './i18n'

/**
 * VS Code / Obsidian-style file tree for the board list. Boards ARE .canvas
 * files in the user's repo — the tree makes that location visible (folders,
 * file extension) instead of hiding it behind a flat list.
 */

interface Props {
  boards: BoardInfo[]
  active: string | null
  current: string | null
  onOpen: (path: string) => void
  /** open the new-board prompt, pre-filled with this folder */
  onNewBoard: (folder?: string) => void
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

export function BoardTree({ boards, active, current, onOpen, onNewBoard }: Props) {
  const t = useT()
  const tree = useMemo(() => buildTree(boards), [boards])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed)
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

  const renderBoard = (board: BoardInfo, depth: number) => {
    const name = board.path.split('/').pop()!
    const base = name.replace(/\.canvas$/, '')
    return (
      <div
        key={board.path}
        className={`ps-boarditem${board.path === current ? ' is-current' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        title={board.path}
        onClick={() => onOpen(board.path)}
      >
        <div className="ps-boardname">
          {base}
          <span className="ps-ext">.canvas</span>
        </div>
        <div className="ps-boardmeta">
          {board.nodes} nodes · {board.edges} edges
        </div>
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
      </div>
    )
  }

  const renderFolder = (folder: Folder, depth: number) => {
    const isCollapsed = !!collapsed[folder.path]
    return (
      <div key={folder.path}>
        <div
          className="ps-folder"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => toggle(folder.path)}
          title={`${folder.path}/`}
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
    <div className="ps-tree">
      {tree.folders.map((f) => renderFolder(f, 0))}
      {tree.boards.map((b) => renderBoard(b, 0))}
    </div>
  )
}
