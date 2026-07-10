import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { api, connectHub, type BoardInfo } from './api'
import { CanvasBoard } from './board/CanvasBoard'
import { ChatPanel } from './ChatPanel'
import { Settings } from './Settings'
import { useT } from './i18n'
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery'

export function App() {
  const t = useT()
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
  // desktop: both panels collapse (edge tabs) and drag-resize (edge handles),
  // like the phone overlays but persistent — the canvas is the main act
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem('ps-side-open') !== '0')
  const [deskChatOpen, setDeskChatOpen] = useState(() => localStorage.getItem('ps-chat-open') !== '0')
  const [sideW, setSideW] = useState(() => Number(localStorage.getItem('ps-side-w')) || 280)
  const [chatW, setChatW] = useState(() => Number(localStorage.getItem('ps-chat-w')) || 340)
  useEffect(() => localStorage.setItem('ps-side-open', sideOpen ? '1' : '0'), [sideOpen])
  useEffect(() => localStorage.setItem('ps-chat-open', deskChatOpen ? '1' : '0'), [deskChatOpen])
  // persist widths from effects, not the pointerup handler — the handler's
  // closure can hold the previous render's value
  useEffect(() => localStorage.setItem('ps-side-w', String(sideW)), [sideW])
  useEffect(() => localStorage.setItem('ps-chat-w', String(chatW)), [chatW])
  const panelDrag = useRef<{ which: 'side' | 'chat'; startX: number; startW: number } | null>(null)
  const startPanelDrag = (which: 'side' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    panelDrag.current = { which, startX: event.clientX, startW: which === 'side' ? sideW : chatW }
  }
  const onPanelDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = panelDrag.current
    if (!d) return
    const delta = event.clientX - d.startX
    if (d.which === 'side') setSideW(Math.min(480, Math.max(180, d.startW + delta)))
    else setChatW(Math.min(560, Math.max(240, d.startW - delta)))
  }
  const endPanelDrag = () => {
    panelDrag.current = null
  }
  const currentRef = useRef<string | null>(null)
  currentRef.current = current
  const activeRef = useRef<string | null>(null)
  activeRef.current = active
  const chatOpenRef = useRef(false)
  chatOpenRef.current = phone ? chatOpen : deskChatOpen

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
    <div
      className={`ps-app${phone ? ' is-mobile' : ''}${!phone && !sideOpen ? ' side-closed' : ''}${!phone && !deskChatOpen ? ' chat-closed' : ''}`}
      style={
        phone
          ? undefined
          : {
              // minmax lets wide persisted panels give way on narrow windows —
              // the canvas keeps at least 320px instead of collapsing to 0
              gridTemplateColumns: `minmax(0, ${sideOpen ? sideW : 0}px) minmax(320px, 1fr) minmax(0, ${deskChatOpen ? chatW : 0}px)`,
            }
      }
    >
      {phone && (
        <header className="ps-topbar">
          <button className="ps-iconbtn" onClick={() => setDrawerOpen(true)} aria-label="boards">
            ☰
          </button>
          <div className="ps-topbar-title">
            <i
              className={`ps-live${wsUp ? ' is-up' : ''}`}
              title={wsUp ? t('live.connected') : t('live.reconnecting')}
              aria-label={wsUp ? 'connected' : 'reconnecting'}
            />
            {current ? current.replace(/\.canvas$/, '') : 'canvai'}
          </div>
          {agentBusy && <span className="ps-topbar-busy">🤖</span>}
          <Settings />
          <button className="ps-iconbtn" onClick={openChat} aria-label={t('chat.title')}>
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
          <div className="ps-brand-text">
            <span className="ps-logo">canvai</span>
            <span className="ps-tagline">{t('sidebar.tagline')}</span>
          </div>
          {!phone && <Settings />}
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
          ))}
          {boards.length === 0 && !offline && <div className="ps-empty">{t('board.none')}</div>}
          {offline && <div className="ps-empty">{t('board.unreachable')}</div>}
        </div>
        <button className="ps-newboard" onClick={() => void newBoard()}>
          {t('board.new')}
        </button>
        <footer className="ps-hint">
          {phone ? (
            <>
              {t('sidebar.hint.select')}
              <br />
              {t('sidebar.hint.drag')}
            </>
          ) : (
            <>
              {t('hint.desktop.1')}
              <br />
              {t('hint.desktop.2')}
              <br />
              {t('hint.desktop.3')}
            </>
          )}
        </footer>
      </aside>
      <main className="ps-main">
        {current ? (
          <CanvasBoard key={current} path={current} changeSignal={changeSignal} />
        ) : (
          <div className="ps-placeholder">{t('board.placeholder')}</div>
        )}
        {!phone && (
          <>
            <button
              className="ps-paneltab ps-paneltab-left"
              onClick={() => setSideOpen((v) => !v)}
              title={sideOpen ? t('panel.collapse') : t('panel.boards')}
              aria-label="toggle board list"
            >
              {sideOpen ? '‹' : '›'}
            </button>
            <button
              className="ps-paneltab ps-paneltab-right"
              onClick={() => {
                setDeskChatOpen((v) => !v)
                setChatUnread(false)
              }}
              title={deskChatOpen ? t('panel.collapse') : t('chat.title')}
              aria-label="toggle chat"
            >
              {deskChatOpen ? '›' : '‹'}
              {!deskChatOpen && chatUnread && <i className="ps-dot" />}
            </button>
            {sideOpen && (
              <div
                className="ps-panelresize ps-panelresize-left"
                onPointerDown={startPanelDrag('side')}
                onPointerMove={onPanelDrag}
                onPointerUp={endPanelDrag}
                onPointerCancel={endPanelDrag}
              />
            )}
            {deskChatOpen && (
              <div
                className="ps-panelresize ps-panelresize-right"
                onPointerDown={startPanelDrag('chat')}
                onPointerMove={onPanelDrag}
                onPointerUp={endPanelDrag}
                onPointerCancel={endPanelDrag}
              />
            )}
          </>
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
