import { describe, expect, it } from 'vitest'
import { applyOps, findRails, type CanvasData } from '@canvai/canvas-kit'
import { applyMutations } from '../src/mutate.ts'

function board(): CanvasData {
  return { nodes: [], edges: [] }
}

describe('human rail mutations', () => {
  it('add_rail builds a rail at the drawn origin with the requested slots', () => {
    const data = board()
    applyMutations(data, [{ kind: 'add_rail', orient: 'h', x: 100, y: 200, slots: 4 }])
    const rail = findRails(data)[0]!
    expect(rail.joints).toHaveLength(4)
    expect(rail.joints[0]).toMatchObject({ x: 100, y: 200 })
    expect(rail.orient).toBe('h')
  })

  it('rail_attach seats a free card, reorders an attached one, and steals from another rail', () => {
    const data = board()
    applyMutations(data, [{ kind: 'add_rail', orient: 'h', x: 0, y: 0, slots: 3 }])
    applyMutations(data, [{ kind: 'add_rail', orient: 'h', x: 0, y: 1000, slots: 3 }])
    const [railA, railB] = findRails(data)
    applyOps(data, [{ op: 'add_node', text: 'wanderer' }])
    const card = data.nodes!.at(-1)!

    applyMutations(data, [{ kind: 'rail_attach', rail: railA!.group.id, card: card.id, slot: 1 }])
    expect(findRails(data)[0]!.cards.get(0)![0]!.id).toBe(card.id)

    applyMutations(data, [{ kind: 'rail_attach', rail: railA!.group.id, card: card.id, slot: 3 }])
    const after = findRails(data)[0]!
    expect(after.cards.get(2)![0]!.id).toBe(card.id)
    expect(after.cards.has(0)).toBe(false)

    applyMutations(data, [{ kind: 'rail_attach', rail: railB!.group.id, card: card.id, slot: 2 }])
    const [a2, b2] = findRails(data)
    expect(a2!.cards.size).toBe(0) // released from the first rail
    expect(b2!.cards.get(1)![0]!.id).toBe(card.id)
  })

  it('rail_detach releases the card and delete_node on a rail cascades to joints', () => {
    const data = board()
    applyMutations(data, [{ kind: 'add_rail', orient: 'v', x: 0, y: 0, slots: 2 }])
    const rail = findRails(data)[0]!
    applyOps(data, [{ op: 'add_node', text: 'c' }])
    const card = data.nodes!.at(-1)!
    applyMutations(data, [{ kind: 'rail_attach', rail: rail.group.id, card: card.id, slot: 1 }])
    applyMutations(data, [{ kind: 'rail_detach', rail: rail.group.id, card: card.id }])
    expect(findRails(data)[0]!.cards.size).toBe(0)

    const outcome = applyMutations(data, [{ kind: 'delete_node', id: rail.group.id }])
    expect(findRails(data)).toHaveLength(0)
    expect(data.nodes!.map((n) => n.id)).toEqual([card.id])
    expect(outcome.deletedIds.length).toBe(3) // group + 2 joints
  })
})
