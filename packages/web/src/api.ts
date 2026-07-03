/**
 * REST + WebSocket client for the pairsketch hub. Types mirror
 * @pairsketch/canvas-kit (which cannot be imported here — it pulls node
 * builtins); keep them in sync.
 */

export interface CanvasNode {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  color?: string
  text?: string
  file?: string
  url?: string
  label?: string
  [key: string]: unknown
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: string
  toSide?: string
  label?: string
  color?: string
  [key: string]: unknown
}

export interface CanvasData {
  nodes?: CanvasNode[]
  edges?: CanvasEdge[]
  [key: string]: unknown
}

export interface BoardInfo {
  path: string
  nodes: number
  edges: number
  mtimeMs: number
}

export type Mutation =
  | { kind: 'set_geometry'; id: string; x?: number; y?: number; width?: number; height?: number }
  | { kind: 'set_text'; id: string; text: string }
  | { kind: 'set_color'; id: string; color?: string }
  | { kind: 'set_label'; id: string; label: string }
  | { kind: 'add_text_node'; x: number; y: number; text?: string; width?: number; height?: number }
  | { kind: 'add_edge'; from: string; to: string; fromSide?: string; toSide?: string; label?: string }
  | { kind: 'delete_node'; id: string }
  | { kind: 'delete_edge'; id: string }

export type HubMessage =
  | { type: 'hello'; active: string | null }
  | { type: 'boards_changed' }
  | { type: 'board_changed'; board: string }
  | { type: 'active_changed'; active: string | null }

/** Optional access token, taken from ?token= (used when the hub runs with --token over a VPN/LAN). */
const TOKEN = new URLSearchParams(window.location.search).get('token')

function request(input: string, init?: RequestInit): Promise<Response> {
  if (!TOKEN) return fetch(input, init)
  return fetch(input, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${TOKEN}` } })
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

export const api = {
  boards: () => request('/api/boards').then((r) => json<{ boards: BoardInfo[]; active: string | null }>(r)),
  board: (path: string) =>
    request(`/api/board?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ path: string; data: CanvasData; pinned: string[] }>(r),
    ),
  createBoard: (path: string) =>
    request('/api/boards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ ok: boolean }>(r)),
  setActive: (board: string) =>
    request('/api/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board }),
    }).then((r) => json<{ ok: boolean }>(r)),
  mutate: (board: string, changes: Mutation[]) =>
    request('/api/mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ board, changes }),
    }).then((r) => json<{ ok: boolean; summary: string[] }>(r)),
}

/** Auto-reconnecting hub socket. Returns a cleanup function. */
export function connectHub(onMessage: (message: HubMessage) => void): () => void {
  let socket: WebSocket | undefined
  let closed = false
  let retry: ReturnType<typeof setTimeout> | undefined

  const open = () => {
    if (closed) return
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const auth = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''
    socket = new WebSocket(`${protocol}://${location.host}/ws${auth}`)
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(String(event.data)) as HubMessage)
      } catch {
        // ignore malformed frames
      }
    }
    socket.onclose = () => {
      if (!closed) retry = setTimeout(open, 2000)
    }
  }
  open()

  return () => {
    closed = true
    clearTimeout(retry)
    socket?.close()
  }
}
