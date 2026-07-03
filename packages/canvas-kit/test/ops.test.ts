import { describe, expect, it } from 'vitest'
import {
  applyOps,
  parseCanvas,
  serializeCanvas,
  structuralProjection,
  nodes,
  edges,
  type CanvasData,
} from '../src/index.ts'

function board(): CanvasData {
  return {
    nodes: [
      { id: 'aaaa000011112222', type: 'text', text: 'origin', x: 0, y: 0, width: 300, height: 60, custom: 'kept' },
      { id: 'bbbb000011112222', type: 'group', label: 'Risks', x: 600, y: -100, width: 500, height: 400 },
      { id: 'bbbb111122223333', type: 'text', text: 'inside', x: 640, y: -20, width: 300, height: 60 },
    ],
    edges: [],
    unknownTop: { keep: true },
  }
}

describe('applyOps', () => {
  it('adds anchored nodes, connects them via batch refs, and preserves unknown fields', () => {
    const data = board()
    const result = applyOps(data, [
      { op: 'add_node', text: 'first', anchor: 'aaaa', dir: 'right', ref: 'a' },
      { op: 'add_node', text: 'second', anchor: '$a', dir: 'right', ref: 'b' },
      { op: 'connect', from: '$a', to: '$b', label: 'then' },
    ])
    expect(nodes(data)).toHaveLength(5)
    expect(edges(data)).toHaveLength(1)
    const a = nodes(data).find((n) => n.id === result.created.$a)!
    const b = nodes(data).find((n) => n.id === result.created.$b)!
    expect(a.x).toBeGreaterThan(300) // placed right of the origin card
    expect(b.x).toBeGreaterThan(a.x)
    const edge = edges(data)[0]!
    expect(edge.fromSide).toBe('right')
    expect(edge.toSide).toBe('left')
    expect(edge.label).toBe('then')
    // untouched content survives
    expect(nodes(data)[0]!.custom).toBe('kept')
    expect((data.unknownTop as Record<string, unknown>).keep).toBe(true)
  })

  it('never hands agents absolute coordinates but still avoids collisions', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_node', text: 'x1', anchor: 'aaaa', dir: 'below' },
      { op: 'add_node', text: 'x2', anchor: 'aaaa', dir: 'below' },
    ])
    const [, , , n1, n2] = nodes(data)
    expect(n1 && n2).toBeTruthy()
    const overlap =
      n1!.x < n2!.x + n2!.width && n1!.x + n1!.width > n2!.x && n1!.y < n2!.y + n2!.height && n1!.y + n1!.height > n2!.y
    expect(overlap).toBe(false)
  })

  it('places into a group and expands it when needed', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_node', text: 'risk A: a fairly long description that needs some height', in_group: 'bbbb0000' },
    ])
    const group = nodes(data).find((n) => n.id === 'bbbb000011112222')!
    const added = nodes(data).at(-1)!
    expect(added.x).toBeGreaterThanOrEqual(group.x)
    expect(added.y + added.height).toBeLessThanOrEqual(group.y + group.height)
  })

  it('deletes nodes with their edges', () => {
    const data = board()
    applyOps(data, [{ op: 'connect', from: 'aaaa', to: 'bbbb1111' }])
    expect(edges(data)).toHaveLength(1)
    applyOps(data, [{ op: 'delete_node', id: 'aaaa' }])
    expect(nodes(data).some((n) => n.id.startsWith('aaaa'))).toBe(false)
    expect(edges(data)).toHaveLength(0)
  })

  it('moves a group together with its members', () => {
    const data = board()
    applyOps(data, [{ op: 'move', id: 'bbbb0000', dx: 100, dy: 50 }])
    const group = nodes(data).find((n) => n.id === 'bbbb000011112222')!
    const member = nodes(data).find((n) => n.id === 'bbbb111122223333')!
    expect(group.x).toBe(700)
    expect(member.x).toBe(740)
    expect(member.y).toBe(30)
  })

  it('rejects ambiguous prefixes and unknown refs', () => {
    const data = board()
    expect(() => applyOps(data, [{ op: 'delete_node', id: 'bbbb' }])).toThrow(/ambiguous/)
    expect(() => applyOps(data, [{ op: 'connect', from: '$nope', to: 'aaaa' }])).toThrow(/unknown batch reference/)
  })

  it('round-trips through serialize after ops without disturbing style', () => {
    const raw = serializeCanvas(board(), { indent: '\t', colonSpace: false, trailingNewline: true })
    const { data, style } = parseCanvas(raw)
    applyOps(data, [{ op: 'update_node', id: 'aaaa', color: '4' }])
    const out = serializeCanvas(data, style)
    expect(out).toContain('"color":"4"')
    expect(out).toContain('"custom":"kept"')
    expect(out.includes('": ')).toBe(false) // dialect preserved
  })
})

describe('structuralProjection', () => {
  it('shows groups, membership, and short ids agents can reuse', () => {
    const data = board()
    applyOps(data, [{ op: 'connect', from: 'aaaa', to: 'bbbb1111', label: 'watch' }])
    const projection = structuralProjection(data, 'discuss/demo.canvas')
    expect(projection.text).toContain('board: discuss/demo.canvas')
    expect(projection.text).toContain('"Risks"')
    expect(projection.text).toMatch(/\[bbbb11\S*\] text \(in bbbb00\S*\): inside/)
    expect(projection.text).toContain('"watch"')
    // aliases resolve back to full ids
    for (const [short, full] of Object.entries(projection.aliases)) {
      expect(full.startsWith(short)).toBe(true)
    }
    // structure view stays coordinate-free
    expect(projection.text).not.toMatch(/"x":|\bx=|\(0, 0\)/)
  })
})
