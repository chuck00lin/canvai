import { describe, expect, it } from 'vitest'
import type { CanvasData, CanvasNode } from '../src/types.ts'
import { applyOps } from '../src/ops.ts'
import { autoLayout } from '../src/layout.ts'
import { findRails, railMemberIds, RAIL_MARK } from '../src/rail.ts'
import { structuralProjection } from '../src/projection.ts'

function board(): CanvasData {
  return { nodes: [], edges: [] }
}

function railParts(data: CanvasData) {
  const rail = findRails(data)[0]!
  const jointIds = new Set(rail.joints.map((j) => j.id))
  const shaft = data.edges!.filter((e) => jointIds.has(e.fromNode) && jointIds.has(e.toNode))
  const attach = data.edges!.filter((e) => jointIds.has(e.toNode) && !jointIds.has(e.fromNode))
  return { rail, shaft, attach }
}

describe('add_rail', () => {
  it('creates a marked group, aligned joints, and a shaft with one arrowhead at the end', () => {
    const data = board()
    applyOps(data, [{ op: 'add_rail', label: 'timeline', slots: 4, pitch: 100 }])
    const { rail, shaft } = railParts(data)
    expect(rail.group.label).toBe(`${RAIL_MARK} timeline`)
    expect(rail.joints).toHaveLength(4)
    expect(new Set(rail.joints.map((j) => j.y)).size).toBe(1) // horizontal: same y
    expect(rail.joints[1]!.x - rail.joints[0]!.x).toBe(100)
    expect(shaft).toHaveLength(3)
    expect(shaft.filter((e) => e.toEnd === 'arrow')).toHaveLength(1)
    expect(shaft.find((e) => e.toNode === rail.joints[3]!.id)?.toEnd).toBe('arrow')
  })

  it('lays a vertical rail down the y axis', () => {
    const data = board()
    applyOps(data, [{ op: 'add_rail', orient: 'v', label: 'flow', slots: 3 }])
    const { rail } = railParts(data)
    expect(rail.orient).toBe('v')
    expect(new Set(rail.joints.map((j) => j.x)).size).toBe(1)
    expect(rail.joints[2]!.y).toBeGreaterThan(rail.joints[0]!.y)
  })
})

describe('attach_to_rail', () => {
  it('fills the first free slot, alternating sides, with arrowless deterministic edges', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'one' },
      { op: 'attach_to_rail', rail: '$r', text: 'two' },
    ])
    const { rail, attach } = railParts(data)
    const one = rail.cards.get(0)![0]!
    const two = rail.cards.get(1)![0]!
    expect(one.y + one.height).toBeLessThan(rail.joints[0]!.y) // slot 1 above
    expect(two.y).toBeGreaterThan(rail.joints[1]!.y) // slot 2 below (alternating)
    expect(attach.every((e) => e.toEnd === 'none')).toBe(true)
    expect(attach.find((e) => e.fromNode === one.id)).toMatchObject({ fromSide: 'bottom', toSide: 'top' })
    expect(attach.find((e) => e.fromNode === two.id)).toMatchObject({ fromSide: 'top', toSide: 'bottom' })
  })

  it('attaches an existing card and centres it on the slot joint', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_node', text: 'existing', ref: 'c' },
      { op: 'add_rail', label: 't', ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', card: '$c' },
    ])
    const { rail } = railParts(data)
    const card = rail.cards.get(0)![0]!
    const joint = rail.joints[0]!
    expect(card.x + card.width / 2).toBeCloseTo(joint.x + joint.width / 2, 0)
  })

  it('treats an occupied slot as insert: later cards shift toward the tail', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'A' },
      { op: 'attach_to_rail', rail: '$r', text: 'B' },
      { op: 'attach_to_rail', rail: '$r', text: 'INSERTED', slot: 1 },
    ])
    const { rail } = railParts(data)
    expect(rail.cards.get(0)![0]!.text).toBe('INSERTED')
    expect(rail.cards.get(1)![0]!.text).toBe('A')
    expect(rail.cards.get(2)![0]!.text).toBe('B')
  })

  it('grows the rail when it runs out of slots', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 2, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'a' },
      { op: 'attach_to_rail', rail: '$r', text: 'b' },
      { op: 'attach_to_rail', rail: '$r', text: 'c' },
    ])
    const { rail, shaft } = railParts(data)
    expect(rail.joints).toHaveLength(3)
    expect(shaft.filter((e) => e.toEnd === 'arrow')).toHaveLength(1) // arrowhead moved, not duplicated
    expect(rail.cards.get(2)![0]!.text).toBe('c')
  })
})

describe('rail_detach / rail_reorder / set_rail', () => {
  function threeCards(): CanvasData {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 4, pitch: 100, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'A' },
      { op: 'attach_to_rail', rail: '$r', text: 'B' },
      { op: 'attach_to_rail', rail: '$r', text: 'C' },
    ])
    return data
  }

  it('detach removes only the attachment — joint and card survive', () => {
    const data = threeCards()
    const { rail } = railParts(data)
    const b = rail.cards.get(1)![0]!
    applyOps(data, [{ op: 'rail_detach', rail: rail.group.id, card: b.id }])
    const after = railParts(data)
    expect(after.rail.joints).toHaveLength(4)
    expect(after.rail.cards.has(1)).toBe(false)
    expect(data.nodes!.some((n) => n.id === b.id)).toBe(true)
  })

  it('reorder moves a card with insert semantics', () => {
    const data = threeCards()
    const { rail } = railParts(data)
    const c = rail.cards.get(2)![0]!
    applyOps(data, [{ op: 'rail_reorder', rail: rail.group.id, card: c.id, slot: 1 }])
    const after = railParts(data).rail
    expect(after.cards.get(0)![0]!.text).toBe('C')
    expect(after.cards.get(1)![0]!.text).toBe('A')
    expect(after.cards.get(2)![0]!.text).toBe('B')
  })

  it('set_rail re-projects joints and attached cards onto the new pitch', () => {
    const data = threeCards()
    const { rail } = railParts(data)
    applyOps(data, [{ op: 'set_rail', rail: rail.group.id, pitch: 200 }])
    const after = railParts(data).rail
    expect(after.joints[1]!.x - after.joints[0]!.x).toBe(200)
    const a = after.cards.get(0)![0]!
    expect(a.x + a.width / 2).toBeCloseTo(after.joints[0]!.x + after.joints[0]!.width / 2, 0)
  })
})

describe('durability', () => {
  it('rebuilds order, orient and attachments from geometry when the cache is stripped', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, pitch: 90, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'first' },
      { op: 'attach_to_rail', rail: '$r', text: 'second' },
    ])
    for (const n of data.nodes!) delete n.canvai // a client stripped unknown fields
    const rail = findRails(data)[0]!
    expect(rail.orient).toBe('h')
    expect(rail.joints).toHaveLength(3)
    expect(rail.pitch).toBe(90) // recovered from joint spacing
    expect(rail.cards.get(0)![0]!.text).toBe('first')
    expect(rail.cards.get(1)![0]!.text).toBe('second')
  })
})

describe('layout rigidity', () => {
  it('auto_layout with rail members pinned leaves the rail untouched', async () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'on rail' },
      { op: 'add_node', text: 'free one' },
      { op: 'add_node', text: 'free two' },
    ])
    const before = new Map(data.nodes!.map((n) => [n.id, { x: n.x, y: n.y }]))
    const members = railMemberIds(data)
    await autoLayout(data, { pinned: members })
    for (const id of members) {
      const n = data.nodes!.find((x) => x.id === id)!
      expect({ x: n.x, y: n.y }).toEqual(before.get(id))
    }
  })
})

describe('move', () => {
  it('moving the rail group carries joints and attached cards together', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'card' },
    ])
    const { rail } = railParts(data)
    const card = rail.cards.get(0)![0]!
    const cardBefore = { x: card.x, y: card.y }
    const jointBefore = { x: rail.joints[0]!.x, y: rail.joints[0]!.y }
    applyOps(data, [{ op: 'move', id: rail.group.id, dx: 30, dy: -20 }])
    expect(card.x).toBe(cardBefore.x + 30)
    expect(card.y).toBe(cardBefore.y - 20)
    expect(rail.joints[0]!.x).toBe(jointBefore.x + 30)
    expect(rail.joints[0]!.y).toBe(jointBefore.y - 20)
  })
})

describe('connect arrows / pin', () => {
  it('supports arrowless and reversed arrowheads', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_node', text: 'a', ref: 'a' },
      { op: 'add_node', text: 'b', ref: 'b' },
      { op: 'connect', from: '$a', to: '$b', arrows: 'none' },
      { op: 'connect', from: '$a', to: '$b', arrows: 'both' },
    ])
    expect(data.edges![0]).toMatchObject({ toEnd: 'none' })
    expect(data.edges![0]!.fromEnd).toBeUndefined()
    expect(data.edges![1]).toMatchObject({ fromEnd: 'arrow' })
    expect(data.edges![1]!.toEnd).toBeUndefined()
  })

  it('reports pin/unpin targets for the caller to persist', () => {
    const data = board()
    const result = applyOps(data, [
      { op: 'add_node', text: 'a', ref: 'a' },
      { op: 'pin', id: '$a' },
    ])
    expect(result.pins).toEqual([data.nodes![0]!.id])
  })
})

describe('projection', () => {
  it('renders rails as ordered slots and hides the plumbing', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 'roadmap', slots: 3, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'ship it' },
      { op: 'add_node', text: 'unrelated' },
    ])
    const { text } = structuralProjection(data, 'test')
    expect(text).toContain('"roadmap" (h, 3 slots)')
    expect(text).toContain('1: [')
    expect(text).toContain('ship it')
    expect(text).toContain('2: (empty)')
    expect(text).toContain('unrelated')
    expect(text).toContain('1 rails')
    // joints are 10×10 empty text nodes — none may leak into the nodes section
    expect(text).not.toMatch(/\] text(?: \(in [^)]*\))?: *$/m)
    // shaft/attach edges hidden
    expect(text).not.toContain('edges:')
  })
})
