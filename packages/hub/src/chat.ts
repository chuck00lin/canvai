import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/**
 * The text side-channel: `.pairsketch/chat.jsonl`. Prose that shouldn't
 * become cards lives here — not every human message deserves a box on the
 * canvas, and not every agent reply is a diagram. Like everything else,
 * it's a file: both hub processes read and append it directly.
 */

export interface ChatMessage {
  id: string
  ts: string
  from: 'human' | 'agent'
  text: string
  board?: string
}

let seq = 0

function chatFile(root: string): string {
  return path.join(root, '.pairsketch', 'chat.jsonl')
}

export async function appendChat(
  root: string,
  message: { from: 'human' | 'agent'; text: string; board?: string },
): Promise<ChatMessage> {
  seq += 1
  const full: ChatMessage = {
    id: `${Date.now()}-${process.pid}-c${seq}`,
    ts: new Date().toISOString(),
    ...message,
  }
  await mkdir(path.dirname(chatFile(root)), { recursive: true })
  await appendFile(chatFile(root), JSON.stringify(full) + '\n', 'utf8')
  return full
}

export async function readChat(root: string): Promise<ChatMessage[]> {
  try {
    const text = await readFile(chatFile(root), 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ChatMessage)
  } catch {
    return []
  }
}

export async function readChatSince(
  root: string,
  cursor?: string,
  limit = 200,
): Promise<{ messages: ChatMessage[]; cursor?: string }> {
  const all = await readChat(root)
  let start = 0
  if (cursor) {
    const index = all.findIndex((m) => m.id === cursor)
    start = index >= 0 ? index + 1 : 0
  }
  const messages = all.slice(start).slice(-limit)
  return { messages, cursor: messages.at(-1)?.id ?? cursor }
}
