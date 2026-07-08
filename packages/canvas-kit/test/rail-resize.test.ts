import { describe, expect, it } from 'vitest'
import type { CanvasData } from '../src/types.ts'
import { applyOps } from '../src/ops.ts'
import { findRails, resizeRail } from '../src/rail.ts'

function board(): CanvasData {
  return { nodes: [], edges: [] }
}

function shaftArrowheads(data: CanvasData): number {
  const rail = findRails(data)[0]!
  const jointIds = new Set(rail.joints.map((j) => j.id))
  return data.edges!.filter((e) => jointIds.has(e.fromNode) && jointIds.has(e.toNode) && e.toEnd === 'arrow').length
}

describe('resizeRail', () => {
  it('grows the slot count with the dragged length and keeps one arrowhead', () => {
    const data = board()
    applyOps(data, [{ op: 'add_rail', label: 't', slots: 3, pitch: 100 }])
    const rail = findRails(data)[0]!
    const g = rail.group
    resizeRail(data, rail, { x: g.x, y: g.y, width: 570, height: g.height }) // usable 500 → 6 slots
    const after = findRails(data)[0]!
    expect(after.joints).toHaveLength(6)
    expect(after.joints[5]!.x - after.joints[0]!.x).toBe(500)
    expect(shaftArrowheads(data)).toBe(1)
  })

  it('shrinks but never drops an occupied slot, and re-seats its card', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 5, pitch: 100, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'keeper', slot: 3 },
    ])
    const rail = findRails(data)[0]!
    const g = rail.group
    resizeRail(data, rail, { x: g.x, y: g.y, width: 90, height: g.height }) // would be 2 slots — clamped to 3
    const after = findRails(data)[0]!
    expect(after.joints).toHaveLength(3)
    const card = after.cards.get(2)![0]!
    expect(card.text).toBe('keeper')
    const joint = after.joints[2]!
    expect(card.x + card.width / 2).toBeCloseTo(joint.x + joint.width / 2, 0)
    expect(shaftArrowheads(data)).toBe(1)
  })

  it('preserves a custom hang offset across resize and insert-shift', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 4, pitch: 100, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'custom', slot: 2 },
    ])
    let rail = findRails(data)[0]!
    const card = rail.cards.get(1)![0]!
    // the human hangs the card far below-left of its joint
    card.x = rail.joints[1]!.x - 300
    card.y = rail.joints[1]!.y + 250
    const dx = card.x - rail.joints[1]!.x
    const dy = card.y - rail.joints[1]!.y

    const g = rail.group
    resizeRail(data, rail, { x: g.x, y: g.y, width: 640, height: g.height }) // grow
    rail = findRails(data)[0]!
    expect(card.x - rail.joints[1]!.x).toBe(dx)
    expect(card.y - rail.joints[1]!.y).toBe(dy)

    // insert at its slot: the card shifts one pitch toward the tail, hang intact
    applyOps(data, [{ op: 'attach_to_rail', rail: rail.group.id, text: 'insert', slot: 2 }])
    rail = findRails(data)[0]!
    expect(rail.cards.get(2)![0]!.text).toBe('custom')
    expect(card.x - rail.joints[2]!.x).toBe(dx)
    expect(card.y - rail.joints[2]!.y).toBe(dy)
  })

  it('slides the origin with the dragged box', () => {
    const data = board()
    applyOps(data, [{ op: 'add_rail', label: 't', slots: 3, pitch: 100 }])
    const rail = findRails(data)[0]!
    const g = rail.group
    const firstBefore = rail.joints[0]!.x
    resizeRail(data, rail, { x: g.x - 200, y: g.y, width: g.width, height: g.height })
    expect(findRails(data)[0]!.joints[0]!.x).toBe(firstBefore - 200)
  })
})
