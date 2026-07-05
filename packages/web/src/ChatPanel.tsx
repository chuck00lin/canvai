import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type ChatMessage } from './api'
import { Markdown } from './markdown'

interface Props {
  /** bumped by App when the hub broadcasts chat_changed */
  signal: number
  /** true while an agent turn is running */
  agentBusy: boolean
  /** hub WebSocket connectivity — the user's trust anchor */
  wsUp: boolean
  /** phone: the panel is a bottom sheet; this drives its visibility */
  open?: boolean
  /** phone: render a close button (presence marks sheet mode) */
  onClose?: () => void
}

function Elapsed({ since }: { since: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const m = Math.floor(seconds / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return <span className="ps-elapsed">{m > 0 ? `${m}m${s}s` : `${seconds}s`}</span>
}

/**
 * The text side-channel. Prose lives here instead of becoming cards; sending
 * a message hands the turn to the agent (that's the natural expectation of a
 * chat box). The board stays the curated artifact.
 *
 * Status discipline (the loop must never feel like a black box):
 * 已送出 ⏳ → agent 收到 🤖(思考中 + elapsed) → reply lands. If the pickup
 * signal doesn't arrive, say so instead of leaving a dead spinner.
 */
export function ChatPanel({ signal, agentBusy, wsUp, open, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sendBusy, setSendBusy] = useState(false)
  const lastSent = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  // iOS IME: the Return that CONFIRMS a composition arrives AFTER
  // compositionend with isComposing=false — the standard guard misses it
  const compositionEndedAt = useRef(0)
  // set when 交棒 is sent; cleared when the busy signal (or a reply) arrives
  const [handoffSentAt, setHandoffSentAt] = useState<number | null>(null)
  const [busySince, setBusySince] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    api.chat()
      .then((r) => setMessages(r.messages))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    load()
  }, [load, signal])

  useEffect(() => {
    if (agentBusy) {
      setBusySince((existing) => existing ?? Date.now())
      setHandoffSentAt(null) // picked up — the ack pending state is over
    } else {
      setBusySince(null)
    }
  }, [agentBusy])

  // a fresh agent reply also resolves the pending state (belt & suspenders)
  const lastAgentId = messages.filter((m) => m.from === 'agent').at(-1)?.id
  useEffect(() => {
    if (lastAgentId) setHandoffSentAt(null)
  }, [lastAgentId])

  // re-render once past the ack window so the warning can appear
  const [, bumpAck] = useState(0)
  useEffect(() => {
    if (handoffSentAt === null) return
    const timer = window.setTimeout(() => bumpAck((n) => n + 1), 12_500)
    return () => window.clearTimeout(timer)
  }, [handoffSentAt])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, agentBusy, handoffSentAt, open])

  const send = useCallback(
    async (alsoHandoff: boolean) => {
      if (sendBusy) return // in-flight lock: no double-fire while awaiting
      const text = draft.trim()
      // same text within 3s = a duplicate trigger (leaked IME Enter + button
      // tap, double tap, ...) — field bug 2026-07-04: every message arrived twice
      const now = Date.now()
      if (text !== '' && text === lastSent.current.text && now - lastSent.current.at < 3000) {
        setDraft('')
        return
      }
      try {
        setSendBusy(true)
        setError(null)
        if (text !== '') {
          await api.postChat(text)
          lastSent.current = { text, at: Date.now() }
          setDraft('')
        }
        if (alsoHandoff && !agentBusy) {
          await api.handoff()
          setHandoffSentAt(Date.now())
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSendBusy(false)
      }
    },
    [draft, agentBusy, sendBusy],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME guard: Enter that confirms a CJK composition must NOT send
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      // iOS delivers the composition-confirming Return AFTER compositionend
      // with isComposing already false — swallow Enters right after it
      if (Date.now() - compositionEndedAt.current < 150) return
      // Enter only records; a handoff is deliberate (the 🤖 button) — CEO
      // kept triggering agent turns while just taking notes
      void send(false)
    }
  }

  const ackOverdue = handoffSentAt !== null && Date.now() - handoffSentAt > 12_000

  return (
    <aside className={`ps-chat${open ? ' is-open' : ''}`}>
      <header className="ps-chat-head">
        <span>
          <i className={`ps-live${wsUp ? ' is-up' : ''}`} title={wsUp ? '已連線' : '重新連線中…'} />
          chat
        </span>
        <span className="ps-chat-head-right">
          {!wsUp && <span className="ps-chat-reconnect">重新連線中…</span>}
          {onClose && (
            <button className="ps-chat-close" onClick={onClose} aria-label="close chat">
              ✕
            </button>
          )}
        </span>
      </header>
      <div className="ps-chat-list" ref={listRef}>
        {messages.map((m) => (
          <div key={m.id} className={`ps-msg ps-msg-${m.from}`}>
            <div className="ps-msg-meta">
              {m.from === 'agent' ? '🤖' : '🧑'} {m.ts.slice(11, 16)}
            </div>
            <div className="ps-msg-body">
              <Markdown text={m.text} />
            </div>
          </div>
        ))}
        {messages.length === 0 && <div className="ps-chat-empty">文字走這裡，空間思考留在板上。Enter 只送出；要叫 agent 用「交棒 🤖」。</div>}
        {agentBusy && busySince !== null && (
          <div className="ps-status">
            <span className="ps-chat-busy">🤖 思考中…</span> <Elapsed since={busySince} />
            <span className="ps-status-hint">（工作回合可能要幾分鐘，回覆會直接出現在這裡）</span>
          </div>
        )}
        {!agentBusy && handoffSentAt !== null && !ackOverdue && <div className="ps-status">⏳ 已交棒，等待 agent 接手…</div>}
        {!agentBusy && ackOverdue && (
          <div className="ps-status ps-status-warn">
            ⚠ 交棒尚未被接手（{wsUp ? 'agent 可能正忙著別的回合，訊息已排隊' : '連線中斷，恢復後會補送狀態'}）
          </div>
        )}
      </div>
      {error && <div className="ps-chat-error">{error}</div>}
      <footer className="ps-chat-input">
        <textarea
          value={draft}
          placeholder="說點什麼…（Enter 送出，Shift+Enter 換行；交棒用 🤖）"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionEnd={() => {
            compositionEndedAt.current = Date.now()
          }}
        />
        <div className="ps-chat-actions">
          <button onClick={() => void send(false)} disabled={draft.trim() === '' || sendBusy} title="只記錄，不呼叫 agent">
            只送出
          </button>
          <button className="ps-primary" onClick={() => void send(true)} disabled={agentBusy || sendBusy} title="呼叫一個 agent 回合（會讀 chat、events 與 active board）">
            {agentBusy ? '🤖 思考中…' : draft.trim() === '' ? '交棒 🤖' : '送出＋交棒 🤖'}
          </button>
        </div>
      </footer>
    </aside>
  )
}
