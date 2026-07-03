import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type ChatMessage } from './api'
import { Markdown } from './markdown'

interface Props {
  /** bumped by App when the hub broadcasts chat_changed */
  signal: number
  /** true while an agent turn is running */
  agentBusy: boolean
}

/**
 * The text side-channel. Prose lives here instead of becoming cards; sending
 * a message hands the turn to the agent (that's the natural expectation of a
 * chat box). The board stays the curated artifact.
 */
export function ChatPanel({ signal, agentBusy }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, agentBusy])

  const send = useCallback(
    async (alsoHandoff: boolean) => {
      const text = draft.trim()
      try {
        setError(null)
        if (text !== '') {
          await api.postChat(text)
          setDraft('')
        }
        if (alsoHandoff && !agentBusy) await api.handoff()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [draft, agentBusy],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(true)
    }
  }

  return (
    <aside className="ps-chat">
      <header className="ps-chat-head">
        <span>chat</span>
        {agentBusy && <span className="ps-chat-busy">🤖 思考中…</span>}
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
        {messages.length === 0 && <div className="ps-chat-empty">文字走這裡，空間思考留在板上。Enter 送出＝交棒給 agent。</div>}
      </div>
      {error && <div className="ps-chat-error">{error}</div>}
      <footer className="ps-chat-input">
        <textarea
          value={draft}
          placeholder="說點什麼…（Enter 送出＋交棒，Shift+Enter 換行）"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="ps-chat-actions">
          <button onClick={() => void send(false)} disabled={draft.trim() === ''} title="只記錄，不呼叫 agent">
            只送出
          </button>
          <button className="ps-primary" onClick={() => void send(true)} disabled={agentBusy} title="呼叫一個 agent 回合（會讀 chat、events 與 active board）">
            {draft.trim() === '' ? '交棒 🤖' : '送出＋交棒 🤖'}
          </button>
        </div>
      </footer>
    </aside>
  )
}
