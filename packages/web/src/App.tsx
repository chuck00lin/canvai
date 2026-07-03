import { useCallback, useEffect, useRef, useState } from 'react'
import { api, connectHub, type BoardInfo } from './api'
import { CanvasBoard } from './board/CanvasBoard'

export function App() {
  const [boards, setBoards] = useState<BoardInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [changeSignal, setChangeSignal] = useState(0)
  const [offline, setOffline] = useState(false)
  const currentRef = useRef<string | null>(null)
  currentRef.current = current

  const refreshBoards = useCallback(async () => {
    try {
      const result = await api.boards()
      setBoards(result.boards)
      setActive(result.active)
      setOffline(false)
      setCurrent((existing) => existing ?? result.active ?? result.boards[0]?.path ?? null)
    } catch {
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    void refreshBoards()
    return connectHub((message) => {
      if (message.type === 'boards_changed') void refreshBoards()
      if (message.type === 'board_changed' && message.board === currentRef.current) {
        setChangeSignal((n) => n + 1)
      }
      if (message.type === 'hello' || message.type === 'active_changed') {
        setActive(message.active)
        // the active board is the shared focus — follow it
        if (message.active) setCurrent(message.active)
      }
    })
  }, [refreshBoards])

  const newBoard = async () => {
    const path = window.prompt('New board path (repo-relative):', 'discuss/topic.canvas')
    if (!path) return
    try {
      await api.createBoard(path)
      await api.setActive(path)
      await refreshBoards()
      setCurrent(path)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="ps-app">
      <aside className="ps-sidebar">
        <header className="ps-brand">
          <span className="ps-logo">pairsketch</span>
          <span className="ps-tagline">think in pictures, together</span>
        </header>
        <div className="ps-boards">
          {boards.map((board) => (
            <div
              key={board.path}
              className={`ps-boarditem${board.path === current ? ' is-current' : ''}`}
              onClick={() => setCurrent(board.path)}
            >
              <div className="ps-boardname">{board.path.replace(/\.canvas$/, '')}</div>
              <div className="ps-boardmeta">
                {board.nodes} nodes · {board.edges} edges
              </div>
              <label
                className={`ps-active${board.path === active ? ' is-active' : ''}`}
                title="active board: the shared focus for humans and agents"
                onClick={(event) => event.stopPropagation()}
              >
                <input
                  type="radio"
                  name="active-board"
                  checked={board.path === active}
                  onChange={() => void api.setActive(board.path)}
                />
                active
              </label>
            </div>
          ))}
          {boards.length === 0 && !offline && <div className="ps-empty">no boards yet</div>}
          {offline && <div className="ps-empty">hub unreachable — run `npm run serve`</div>}
        </div>
        <button className="ps-newboard" onClick={() => void newBoard()}>
          ＋ new board
        </button>
        <footer className="ps-hint">
          drag = pin · double-click card = edit · double-click canvas = new card
          <br />
          double-click edge = reverse arrow · Delete = remove
          <br />
          agents connect via MCP (`pairsketch-hub`)
        </footer>
      </aside>
      <main className="ps-main">
        {current ? (
          <CanvasBoard key={current} path={current} changeSignal={changeSignal} />
        ) : (
          <div className="ps-placeholder">create a board to start sketching with your agent</div>
        )}
      </main>
    </div>
  )
}
