import { describe, expect, it } from 'vitest'
import type { CanvasData } from '../src/types.ts'
import { applyOps } from '../src/ops.ts'
import { findRails } from '../src/rail.ts'

function board(): CanvasData {
  return { nodes: [], edges: [] }
}

function twoRails(data: CanvasData) {
  applyOps(data, [{ op: 'add_rail', label: 'A', slots: 3, pitch: 100 }])
  applyOps(data, [{ op: 'move', id: findRails(data)[0]!.group.id, dy: 1000 }])
  applyOps(data, [{ op: 'add_rail', label: 'B', slots: 3, pitch: 100 }])
  const rails = findRails(data)
  const a = rails.find((r) => r.group.label!.includes('A'))!
  const b = rails.find((r) => r.group.label!.includes('B'))!
  return { a, b }
}

describe('QA regressions (2026-07-10 review)', () => {
  it('an edge linking two rails’ joints is not an attachment — moving rail A leaves rail B intact', () => {
    const data = board()
    const { a, b } = twoRails(data)
    data.edges!.push({ id: 'link', fromNode: a.joints[1]!.id, toNode: b.joints[1]!.id })
    expect(findRails(data).every((r) => r.cards.size === 0)).toBe(true)
    const bJointBefore = { x: b.joints[1]!.x, y: b.joints[1]!.y }
    applyOps(data, [{ op: 'move', id: a.group.id, dx: 50, dy: 50 }])
    expect({ x: b.joints[1]!.x, y: b.joints[1]!.y }).toEqual(bJointBefore)
  })

  it('rail ops on a joint-less rail-marked group fail with a clear error, not a TypeError', () => {
    const data = board()
    applyOps(data, [{ op: 'add_group', label: 'plain', ref: 'g' }, { op: 'update_node', id: '$g', label: '⇥ fake rail' }])
    const fake = data.nodes!.find((n) => n.type === 'group')!
    for (const op of [
      { op: 'attach_to_rail' as const, rail: fake.id, text: 'x' },
      { op: 'extend_rail' as const, rail: fake.id },
      { op: 'set_rail' as const, rail: fake.id, pitch: 200 },
    ]) {
      expect(() => applyOps(structuredClone(data), [op])).toThrowError(/no slots/)
    }
  })

  it('agent attach_to_rail releases the card from any other rail (matches the human path)', () => {
    const data = board()
    const { a, b } = twoRails(data)
    applyOps(data, [{ op: 'add_node', text: 'wanderer', ref: 'c' }, { op: 'attach_to_rail', rail: a.group.id, card: '$c' }])
    const wanderer = data.nodes!.find((n) => n.text === 'wanderer')!
    applyOps(data, [{ op: 'attach_to_rail', rail: b.group.id, card: wanderer.id }])
    const rails = findRails(data)
    const onA = rails.find((r) => r.group.id === a.group.id)!.cards.size
    const onB = rails.find((r) => r.group.id === b.group.id)!.cards.size
    expect(onA).toBe(0)
    expect(onB).toBe(1)
  })

  it('moving an outer group that contains a rail carries the rail’s attached cards', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'rider' },
      { op: 'add_group', label: 'outer', around: ['$r'], ref: 'g' },
    ])
    const rail = findRails(data)[0]!
    const card = [...rail.cards.values()][0]![0]!
    const before = { x: card.x, y: card.y }
    const outer = data.nodes!.find((n) => n.type === 'group' && n.label === 'outer')!
    applyOps(data, [{ op: 'move', id: outer.id, dx: 500, dy: 500 }])
    expect(card.x).toBe(before.x + 500)
    expect(card.y).toBe(before.y + 500)
  })
})
