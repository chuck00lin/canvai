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
