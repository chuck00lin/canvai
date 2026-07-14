/**
 * Clipboard with an in-app fallback. navigator.clipboard exists only in
 * secure contexts (https / localhost) — over plain http (VPN/LAN IPs, the
 * primary self-hosted path) it is undefined and every call would silently
 * do nothing. localStorage mirrors every copy, so canvai→canvai copy/paste
 * (including across boards) works on any origin; the system clipboard is
 * used on top whenever the browser allows it.
 */

const KEY = 'canvai-clipboard'

export interface ClipCard {
  id: string
  type: string
  text?: string
  file?: string
  url?: string
  color?: string
  x: number
  y: number
  width: number
  height: number
}

export interface ClipPayload {
  canvai: number
  cards: ClipCard[]
  edges?: { from: string; to: string; fromSide?: string; toSide?: string; label?: string }[]
}

export async function clipWrite(text: string): Promise<void> {
  localStorage.setItem(KEY, text)
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // non-secure context or permission denied — the mirror above covers us
  }
}

/** System clipboard first (it may hold fresher external text), mirror second. */
export async function clipRead(): Promise<string> {
  try {
    const text = await navigator.clipboard?.readText()
    if (text) return text
  } catch {
    // fall through to the mirror
  }
  return localStorage.getItem(KEY) ?? ''
}

export function parsePayload(text: string): ClipPayload | null {
  try {
    const parsed = JSON.parse(text) as ClipPayload
    if (parsed && parsed.canvai === 1 && Array.isArray(parsed.cards) && parsed.cards.length > 0) return parsed
  } catch {
    // not ours
  }
  return null
}
