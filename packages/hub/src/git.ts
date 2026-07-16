import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Optional git auto-commit for the board root. When enabled (--autocommit)
 * and the root is a git repo, every board change (edit / create / delete /
 * rename) is committed, so the repo IS the undo history and audit trail.
 *
 * Only board files and image assets are staged — never the user's other
 * files — because canvai can live inside any repo and must not hoover up
 * unrelated work. Commits are debounced: a burst of edits (dragging a card
 * fires many writes) collapses into one commit.
 */

// pathspecs: boards anywhere in the tree, plus image assets. git interprets
// the globs itself (no shell), and a pathspec that matches nothing is a
// harmless no-op rather than an error.
const PATHSPECS = ['*.canvas', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg']
const DEBOUNCE_MS = 8000

export interface GitAutoCommit {
  /** note a change; the actual commit is debounced */
  touch(label: string): void
  /** commit immediately (flush pending) — call on shutdown */
  flush(): Promise<void>
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    await run('git', ['-C', root, 'rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

/** No-op recorder when auto-commit is off or the root isn't a git repo. */
const OFF: GitAutoCommit = { touch: () => {}, flush: async () => {} }

export async function createAutoCommit(root: string, enabled: boolean): Promise<GitAutoCommit> {
  if (!enabled) return OFF
  if (!(await isGitRepo(root))) {
    console.error(`canvai: --autocommit set but ${root} is not a git repo — auto-commit disabled (run \`git init\`)`)
    return OFF
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const labels = new Set<string>()
  let committing: Promise<void> = Promise.resolve()

  const commit = async (): Promise<void> => {
    const pending = [...labels]
    labels.clear()
    if (pending.length === 0) return
    const message = pending.length === 1 ? pending[0]! : `${pending[0]} (+${pending.length - 1} more)`
    try {
      // stage each pathspec independently: git errors on a pathspec that
      // matches nothing (e.g. no *.png yet), so one absent asset type must
      // not abort staging the boards. -A within each spec still catches
      // deletions and renames.
      for (const spec of PATHSPECS) {
        await run('git', ['-C', root, 'add', '-A', '--', spec]).catch(() => {})
      }
      // nothing staged (e.g. a write that didn't change bytes) → skip the commit
      const { stdout } = await run('git', ['-C', root, 'status', '--porcelain'])
      if (stdout.trim() === '') return
      await run('git', ['-C', root, 'commit', '-q', '-m', `canvai: ${message}`])
    } catch (e) {
      console.error('canvai: auto-commit failed —', e instanceof Error ? e.message : String(e))
    }
  }

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    committing = committing.then(commit)
    await committing
  }

  return {
    touch: (label: string) => {
      labels.add(label)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), DEBOUNCE_MS)
    },
    flush,
  }
}
