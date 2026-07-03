import type { CanvasData } from './types.ts'

/**
 * Serialization style of a .canvas file. Obsidian's exact output has varied
 * across versions (tab indent with and without a space after the colon), so
 * instead of hardcoding one dialect we detect the style per file and mirror
 * it on write — keeping git diffs limited to what actually changed.
 */
export interface CanvasStyle {
  /** one indentation level, e.g. "\t" or "  " */
  indent: string
  /** `"key": value` (true) vs `"key":value` (false) */
  colonSpace: boolean
  trailingNewline: boolean
}

/** Style for files pairsketch creates: current Obsidian output (tabs, spaced colons). */
export const DEFAULT_STYLE: CanvasStyle = { indent: '\t', colonSpace: true, trailingNewline: true }

export function detectStyle(text: string): CanvasStyle {
  const indentMatch = text.match(/\n([\t ]+)\S/)
  const indent = indentMatch ? (indentMatch[1]!.startsWith('\t') ? '\t' : indentMatch[1]!) : DEFAULT_STYLE.indent
  const spaced = (text.match(/": /g) ?? []).length
  const unspaced = (text.match(/":[^ \n]/g) ?? []).length
  return {
    indent,
    colonSpace: spaced >= unspaced,
    trailingNewline: text.endsWith('\n'),
  }
}

export interface ParsedCanvas {
  data: CanvasData
  style: CanvasStyle
}

export function parseCanvas(text: string): ParsedCanvas {
  const trimmed = text.trim()
  const data = (trimmed === '' ? {} : JSON.parse(trimmed)) as CanvasData
  return { data, style: detectStyle(text) }
}

/**
 * Serialize preserving key insertion order (JSON.parse keeps file order;
 * ops only append or edit in place) and the detected style. `undefined`
 * values are dropped, everything else — including fields we don't know
 * about — is written back verbatim.
 */
export function serializeCanvas(data: CanvasData, style: CanvasStyle = DEFAULT_STYLE): string {
  const body = stringifyValue(data, style, 0)
  return style.trailingNewline ? body + '\n' : body
}

function stringifyValue(value: unknown, style: CanvasStyle, depth: number): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  const inner = style.indent.repeat(depth + 1)
  const outer = style.indent.repeat(depth)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => inner + stringifyValue(item, style, depth + 1))
    return '[\n' + items.join(',\n') + '\n' + outer + ']'
  }
  const colon = style.colonSpace ? ': ' : ':'
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return '{}'
  const items = entries.map(([k, v]) => inner + JSON.stringify(k) + colon + stringifyValue(v, style, depth + 1))
  return '{\n' + items.join(',\n') + '\n' + outer + '}'
}
