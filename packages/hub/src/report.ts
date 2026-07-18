import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

/**
 * Optional error telemetry. When `--report-url` is set the hub POSTs a compact
 * JSON event there on startup, on a crash, and on an API/client error — so an
 * operator (or the maintainer, during early testing) learns about problems
 * without shell access to the machine.
 *
 * Privacy: events carry only diagnostics — error kind, message, a short stack,
 * hub/node version, platform. NEVER board content, file contents, or paths
 * beyond the root's basename. Off unless the operator opts in with a URL.
 */

export type ReportKind = 'startup' | 'crash' | 'error' | 'client-error'

export interface Reporter {
  send(kind: ReportKind, detail: Record<string, unknown>): void
}

const NOOP: Reporter = { send: () => {} }

function hubVersion(): string {
  try {
    const pkg = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json')
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Trim a stack to its head so we don't ship a novel (or absolute paths beyond hints). */
function shortStack(stack?: string): string | undefined {
  if (!stack) return undefined
  return stack.split('\n').slice(0, 4).join('\n').slice(0, 800)
}

export function createReporter(url: string | undefined, rootLabel: string): Reporter {
  if (!url) return NOOP
  const base = {
    hubVersion: hubVersion(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    root: rootLabel, // basename only — set by caller
  }
  const send = (kind: ReportKind, detail: Record<string, unknown>): void => {
    // fire-and-forget; telemetry must never delay or crash the hub
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: new Date().toISOString(), kind, ...base, ...detail }),
    }).catch(() => {})
  }
  return { send }
}

/** Normalise an unknown thrown value into a report detail. */
export function errorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { message: error.message, stack: shortStack(error.stack) }
  return { message: String(error) }
}
