import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

/**
 * Recursive watcher over the root. Emits debounced, path-level signals; the
 * serve layer owns snapshots/diffs. Uses node:fs.watch (FSEvents on macOS,
 * recursive inotify on Linux with Node >= 20) — no extra dependency.
 */

export interface WatchSignal {
  type: 'canvas' | 'state'
  /** repo-relative board path for type=canvas */
  board?: string
}

export interface Watcher {
  close(): void
}

const DEBOUNCE_MS = 200

export function watchRoot(root: string, onSignal: (signal: WatchSignal) => void): Watcher {
  const timers = new Map<string, NodeJS.Timeout>()

  const schedule = (key: string, signal: WatchSignal) => {
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        onSignal(signal)
      }, DEBOUNCE_MS),
    )
  }

  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const rel = filename.split(path.sep).join('/')
    const segments = rel.split('/')
    const base = segments.at(-1) ?? ''
    if (rel === '.pairsketch/state.json') {
      schedule('state', { type: 'state' })
      return
    }
    // ignore dotted dirs (.git, .obsidian, .pairsketch) and our tmp files
    if (segments.some((s) => s.startsWith('.')) || segments.includes('node_modules')) return
    if (!base.endsWith('.canvas')) return
    schedule(rel, { type: 'canvas', board: rel })
  })

  return {
    close() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      watcher.close()
    },
  }
}
