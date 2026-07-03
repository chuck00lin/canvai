import { describe, expect, it } from 'vitest'
import { detectStyle, parseCanvas, serializeCanvas } from '../src/index.ts'

// Style observed in older Obsidian output: tabs, no space after colons.
const OLD_STYLE = [
  '{',
  '\t"nodes":[',
  '\t\t{',
  '\t\t\t"id":"aaaa000011112222",',
  '\t\t\t"type":"text",',
  '\t\t\t"text":"hello\\nworld",',
  '\t\t\t"x":-120,',
  '\t\t\t"y":-40,',
  '\t\t\t"width":240,',
  '\t\t\t"height":120,',
  '\t\t\t"color":"6",',
  '\t\t\t"shape":"diamond"',
  '\t\t}',
  '\t],',
  '\t"edges":[],',
  '\t"metadata":{',
  '\t\t"pluginVersion":"6.3.0"',
  '\t}',
  '}',
].join('\n') + '\n'

// Style observed in current Obsidian output: tabs, spaced colons.
const NEW_STYLE = [
  '{',
  '\t"nodes": [',
  '\t\t{',
  '\t\t\t"id": "adb115059e28d960",',
  '\t\t\t"type": "text",',
  '\t\t\t"text": "**系統全貌**",',
  '\t\t\t"x": -120,',
  '\t\t\t"y": -40,',
  '\t\t\t"width": 240,',
  '\t\t\t"height": 120,',
  '\t\t\t"color": "6"',
  '\t\t}',
  '\t],',
  '\t"edges": []',
  '}',
].join('\n') + '\n'

describe('style detection', () => {
  it('detects tab + unspaced colons', () => {
    expect(detectStyle(OLD_STYLE)).toEqual({ indent: '\t', colonSpace: false, trailingNewline: true })
  })
  it('detects tab + spaced colons', () => {
    expect(detectStyle(NEW_STYLE)).toEqual({ indent: '\t', colonSpace: true, trailingNewline: true })
  })
})

describe('round-trip fidelity', () => {
  it('is byte-identical for the unspaced dialect, unknown fields included', () => {
    const { data, style } = parseCanvas(OLD_STYLE)
    expect(serializeCanvas(data, style)).toBe(OLD_STYLE)
  })

  it('is byte-identical for the spaced dialect', () => {
    const { data, style } = parseCanvas(NEW_STYLE)
    expect(serializeCanvas(data, style)).toBe(NEW_STYLE)
  })

  it('preserves unknown node-level and top-level fields', () => {
    const { data } = parseCanvas(OLD_STYLE)
    expect(data.nodes?.[0]?.shape).toBe('diamond')
    expect((data.metadata as Record<string, unknown>).pluginVersion).toBe('6.3.0')
  })

  it('parses empty input as an empty board', () => {
    const { data } = parseCanvas('')
    expect(data).toEqual({})
  })
})
