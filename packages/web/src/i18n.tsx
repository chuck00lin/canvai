import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

// Lightweight i18n: no dependency, a flat dictionary keyed by string id, each
// with an `en` (default) and `zh` (繁體中文) value. Locale lives in
// localStorage so a user's choice sticks; the Settings panel switches it.
// Add future UI languages by adding a key to Locale and a value per string.

export type Locale = 'en' | 'zh'
export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '繁體中文' },
]

type Entry = Record<Locale, string>
export type StringId = keyof typeof STRINGS

const STRINGS = {
  'live.connected': { en: 'connected', zh: '已連線' },
  'live.reconnecting': { en: 'reconnecting…', zh: '重新連線中…' },

  'sidebar.tagline': { en: 'your AI canvas partner', zh: '你的 AI 畫布夥伴' },
  'sidebar.hint.select': {
    en: 'tap a card = select → toolbar below (edit / connect / delete)',
    zh: '點卡片＝選取 → 下方工具列（編輯／連線／刪除）',
  },
  'sidebar.hint.drag': {
    en: 'drag a card = pin · pinch to zoom/pan · ＋ card, bottom-right',
    zh: '拖曳卡片＝pin · 雙指縮放/平移 · ＋ card 在右下',
  },

  'toolbar.edit': { en: 'Edit', zh: '編輯' },
  'toolbar.discuss.leave': { en: 'Mute', zh: '退出討論' },
  'toolbar.discuss.rejoin': { en: 'Unmute', zh: '加回討論' },
  'toolbar.delete': { en: 'Delete', zh: '刪除' },
  'toolbar.delete.confirm': { en: 'Delete?', zh: '確定刪除' },
  'toolbar.reverse': { en: 'Reverse', zh: '反向' },
  'toolbar.connectHint': { en: 'tap the target card to connect', zh: '點目標卡片完成連線' },
  'toolbar.cancel': { en: 'Cancel', zh: '取消' },

  'editor.cancel': { en: 'Cancel', zh: '取消' },
  'editor.save': { en: 'Save', zh: '儲存' },
  'editor.placeholder': { en: 'markdown — ```mermaid fences render as diagrams', zh: 'markdown — ```mermaid 區塊會渲染成圖' },

  'card.add': { en: '＋ card', zh: '＋ 卡片' },
  'rail.add': { en: 'rail', zh: '軌道' },
  'rail.hint': { en: 'drag on the canvas to draw a rail (locks to horizontal / vertical) · Esc to cancel', zh: '在畫布上拖一筆畫出軌道（自動鎖水平/垂直）· Esc 取消' },
  'rail.hint.touch': { en: 'drag on the canvas to draw a rail · tap ⇥ again to cancel', zh: '在畫布上拖一筆畫出軌道 · 再點 ⇥ 取消' },
  'panel.collapse': { en: 'collapse', zh: '收合' },
  'panel.boards': { en: 'boards', zh: '板列表' },
  'toolbar.copy': { en: 'copy', zh: '複製' },
  'toolbar.paste': { en: 'paste', zh: '貼上' },
  'toolbar.multi': { en: 'multi', zh: '多選' },

  'chat.title': { en: 'chat', zh: '對話' },
  'chat.send': { en: 'Send', zh: '送出' },
  'chat.note': { en: 'Note', zh: '記錄' },
  'chat.send.title': { en: 'The agent reads the board, chat, and recent edits, then replies', zh: 'agent 讀板、對話與最近編輯後回覆' },
  'chat.note.title': { en: 'Add to the board without asking the agent', zh: '只加到板上，不叫 agent' },
  'chat.thinking': { en: 'thinking…', zh: '思考中…' },
  'chat.busyHint': { en: '(a work turn can take a few minutes; the reply appears here)', zh: '（回合可能要幾分鐘，回覆會出現在這裡）' },
  'chat.waiting': { en: 'sent — waiting for the agent…', zh: '已送出，等待 agent…' },
  'chat.overdue.busy': { en: 'it may be busy with another turn; your message is queued', zh: 'agent 可能忙著別的回合，訊息已排隊' },
  'chat.overdue.offline': { en: 'connection dropped — it will resend when reconnected', zh: '連線中斷，恢復後會補送' },
  'chat.placeholder': { en: 'Message the agent…   ⏎ send · ⇧⏎ newline', zh: '傳訊給 agent…   ⏎ 送出 · ⇧⏎ 換行' },
  'chat.empty': {
    en: 'Words go here; spatial thinking stays on the board. Send and the agent reads the whole board and replies — or Note to jot something without a reply.',
    zh: '文字走這裡，空間思考留在板上。Send＝agent 讀整張板後回覆；Note＝只記在板上不叫 agent。',
  },

  'board.active': { en: 'active', zh: '啟用' },
  'board.activeTitle': { en: 'active board: the shared focus for humans and agents', zh: '啟用中的板：人與 agent 共同的焦點' },
  'board.new': { en: '＋ new board', zh: '＋ 新板' },
  'board.none': { en: 'no boards yet', zh: '還沒有板' },
  'board.unreachable': { en: 'hub unreachable — run `npm run serve`', zh: 'hub 連不上 — 執行 `npm run serve`' },
  'board.placeholder': { en: 'create a board to start sketching with your agent', zh: '建一張板，開始跟你的 agent 一起畫' },

  'hint.desktop.1': { en: 'drag = pin · double-click card = edit · double-click canvas = new card', zh: '拖曳＝pin · 雙擊卡片＝編輯 · 雙擊畫布＝新卡' },
  'hint.desktop.2': { en: 'double-click edge = reverse arrow · Delete = remove', zh: '雙擊連線＝反向 · Delete＝刪除' },
  'hint.desktop.3': { en: 'agents connect via MCP (`canvai-hub`)', zh: 'agent 透過 MCP 連接（`canvai-hub`）' },

  'settings.title': { en: 'Settings', zh: '設定' },
  'settings.language': { en: 'Language', zh: '語言' },
} satisfies Record<string, Entry>

const STORAGE_KEY = 'canvai.locale'
function readLocale(): Locale {
  if (typeof localStorage === 'undefined') return 'en'
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'zh' || v === 'en' ? v : 'en'
}

interface LocaleValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (id: StringId) => string
}
const LocaleContext = createContext<LocaleValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readLocale)
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try {
      localStorage.setItem(STORAGE_KEY, l)
    } catch {
      // private mode / storage disabled — locale just won't persist
    }
  }, [])
  const t = useCallback((id: StringId) => STRINGS[id][locale], [locale])
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useI18n(): LocaleValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useI18n must be used within LocaleProvider')
  return ctx
}

export function useT(): (id: StringId) => string {
  return useI18n().t
}
