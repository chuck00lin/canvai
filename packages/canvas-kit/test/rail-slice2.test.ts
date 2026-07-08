import { describe, expect, it } from 'vitest'
import type { CanvasData } from '../src/types.ts'
import { applyOps } from '../src/ops.ts'
import { findRails } from '../src/rail.ts'

function board(): CanvasData {
  return { nodes: [], edges: [] }
}

describe('bidirectional attachments', () => {
  it('counts a human-drawn joint→card edge as an attachment', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'add_node', text: 'reverse card', ref: 'c' },
    ])
    const rail = findRails(data)[0]!
    // human draws from the dot to the card (joint → card)
    data.edges!.push({ id: 'human-edge', fromNode: rail.joints[1]!.id, toNode: data.nodes!.at(-1)!.id })
    const rebuilt = findRails(data)[0]!
    expect(rebuilt.cards.get(1)![0]!.text).toBe('reverse card')
  })

  it('rail_detach removes reverse-direction attach edges too', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'add_node', text: 'c', ref: 'c' },
    ])
    const rail = findRails(data)[0]!
    const card = data.nodes!.at(-1)!
    data.edges!.push({ id: 'human-edge', fromNode: rail.joints[0]!.id, toNode: card.id })
    applyOps(data, [{ op: 'rail_detach', rail: rail.group.id, card: card.id }])
    expect(findRails(data)[0]!.cards.size).toBe(0)
    expect(data.edges!.some((e) => e.id === 'human-edge')).toBe(false)
  })

  it('does not classify a joint→group edge as an attachment', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 2, ref: 'r' },
      { op: 'add_node', text: 'x', ref: 'x' },
      { op: 'add_group', label: 'g', around: ['$x'], ref: 'g' },
    ])
    const rail = findRails(data)[0]!
    const group = data.nodes!.find((n) => n.type === 'group' && n.label === 'g')!
    data.edges!.push({ id: 'to-group', fromNode: rail.joints[0]!.id, toNode: group.id })
    expect(findRails(data)[0]!.cards.size).toBe(0)
  })
})

describe('delete cascade', () => {
  it('deleting a rail group removes its joints and every rail edge', () => {
    const data = board()
    applyOps(data, [
      { op: 'add_rail', label: 't', slots: 3, ref: 'r' },
      { op: 'attach_to_rail', rail: '$r', text: 'card' },
    ])
    const rail = findRails(data)[0]!
    const card = [...rail.cards.values()][0]![0]!
    const result = applyOps(data, [{ op: 'delete_node', id: rail.group.id }])
    expect(findRails(data)).toHaveLength(0)
    expect(data.nodes!.map((n) => n.id)).toEqual([card.id]) // the card survives
    expect(data.edges).toHaveLength(0)
    expect(result.deleted).toContain(rail.joints[0]!.id)
  })
})
