import { useCallback, useEffect, useRef, useState } from 'react'
import { api, connectHub, type BoardInfo } from './api'
import { CanvasBoard } from './board/CanvasBoard'
import { ChatPanel } from './ChatPanel'
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery'

export function App() {
  const [boards, setBoards] = useState<BoardInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  // survive reloads (mobile browsers discard background tabs freely) — don't
  // dump the user back on the active board after every resume
  const [current, setCurrent] = useState<string | null>(() => sessionStorage.getItem('ps-current'))

  useEffect(() => {
    if (current) sessionStorage.setItem('ps-current', current)
  }, [current])
  const [changeSignal, setChangeSignal] = useState(0)
  const [chatSignal, setChatSignal] = useState(0)
  const [agentBusy, setAgentBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const [wsUp, setWsUp] = useState(false)
  const phone = useMediaQuery(PHONE_QUERY)
  // on phones the sidebar and chat are overlays; the canvas owns the screen
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatUnread, setChatUnread] = useState(false)
  const currentRef = useRef<string | null>(null)
  currentRef.current = current
  const activeRef = useRef<string | null>(null)
  activeRef.current = active
  const chatOpenRef = useRef(false)
  chatOpenRef.current = chatOpen

  const refreshBoards = useCallback(async () => {
    try {
      const result = await api.boards()
      setBoards(result.boards)
      setActive(result.active)
      setOffline(false)
      setCurrent((existing) =>
        existing && result.boards.some((b) => b.path === existing)
          ? existing
          : (result.active ?? result.boards[0]?.path ?? null),
      )
    } catch {
      setOffline(true)
    }
  }, [])

  // returning from background (mobile browsers freeze tabs): the socket may
  // be dead for seconds and everything on screen is stale — refetch eagerly
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void refreshBoards()
      setChangeSignal((n) => n + 1)
      setChatSignal((n) => n + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refreshBoards])

  useEffect(() => {
    void refreshBoards()
    return connectHub((message) => {
      if (message.type === 'boards_changed') void refreshBoards()
      if (message.type === 'board_changed' && message.board === currentRef.current) {
        setChangeSignal((n) => n + 1)
      }
      if (message.type === 'hello' || message.type === 'active_changed') {
        const previous = activeRef.current
        setActive(message.active)
        // follow the shared focus when it actually CHANGES — a (re)connect
        // hello or a re-broadcast of the same value must not yank the user
        // off a board they navigated to themselves
        if (message.type === 'active_changed' && message.active && message.active !== previous) {
          setCurrent(message.active)
        }
        if (message.type === 'hello') {
          setCurrent((existing) => existing ?? message.active)
          // resync: handoff done/error broadcasts missed while disconnected
          // would otherwise leave the busy indicator stuck on
          setAgentBusy(!!message.busy)
        }
      }
      if (message.type === 'chat_changed') {
        setChatSignal((n) => n + 1)
        if (!chatOpenRef.current) setChatUnread(true)
      }
      if (message.type === 'handoff') setAgentBusy(message.status === 'started')
    }, setWsUp)
  }, [refreshBoards])

  const newBoard = async () => {
    const path = window.prompt('New board path (repo-relative):', 'discuss/topic.canvas')
    if (!path) return
    try {
      await api.createBoard(path)
      await api.setActive(path)
      await refreshBoards()
      setCurrent(path)
      setDrawerOpen(false)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }

  const openChat = () => {
    setChatOpen(true)
    setChatUnread(false)
    setDrawerOpen(false)
  }

  return (
    <div className={`ps-app${phone ? ' is-mobile' : ''}`}>
      {phone && (
        <header className="ps-topbar">
          <button className="ps-iconbtn" onClick={() => setDrawerOpen(true)} aria-label="boards">
            ☰
          </button>
          <div className="ps-topbar-title">
            <i
              className={`ps-live${wsUp ? ' is-up' : ''}`}
              title={wsUp ? '已連線' : '重新連線中…'}
              aria-label={wsUp ? 'connected' : 'reconnecting'}
            />
            {current ? current.replace(/\.canvas$/, '') : 'pairsketch'}
          </div>
          {agentBusy && <span className="ps-topbar-busy">🤖</span>}
          <button className="ps-iconbtn" onClick={openChat} aria-label="chat">
            💬{chatUnread && <i className="ps-dot" />}
          </button>
        </header>
      )}
      {phone && (drawerOpen || chatOpen) && (
        <div
          className="ps-backdrop"
          onClick={() => {
            setDrawerOpen(false)
            setChatOpen(false)
          }}
        />
      )}
      <aside className={`ps-sidebar${drawerOpen ? ' is-open' : ''}`}>
        <header className="ps-brand">
          <span className="ps-logo">pairsketch</span>
          <span className="ps-tagline">think in pictures, together</span>
        </header>
        <div className="ps-boards">
          {boards.map((board) => (
            <div
              key={board.path}
              className={`ps-boarditem${board.path === current ? ' is-current' : ''}`}
              onClick={() => {
                setCurrent(board.path)
                setDrawerOpen(false)
              }}
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
          {phone ? (
            <>
              點卡片＝選取 → 下方工具列（編輯／連線／刪除）
              <br />
              拖曳卡片＝pin · 雙指縮放/平移 · ＋ card 在右下
            </>
          ) : (
            <>
              drag = pin · double-click card = edit · double-click canvas = new card
              <br />
              double-click edge = reverse arrow · Delete = remove
              <br />
              agents connect via MCP (`pairsketch-hub`)
            </>
          )}
        </footer>
      </aside>
      <main className="ps-main">
        {current ? (
          <CanvasBoard key={current} path={current} changeSignal={changeSignal} />
        ) : (
          <div className="ps-placeholder">create a board to start sketching with your agent</div>
        )}
      </main>
      <ChatPanel
        signal={chatSignal}
        agentBusy={agentBusy}
        wsUp={wsUp}
        open={chatOpen}
        onClose={phone ? () => setChatOpen(false) : undefined}
      />
    </div>
  )
}
