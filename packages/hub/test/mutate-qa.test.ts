import { describe, expect, it } from 'vitest'
import { applyOps, findRails, type CanvasData } from '@canvai/canvas-kit'
import { applyMutations } from '../src/mutate.ts'

function board(): CanvasData {
  return { nodes: [], edges: [] }
}

describe('QA regressions (2026-07-10 review)', () => {
  it('delete_node is idempotent — a rail + its joints deleted in one batch succeeds', () => {
    const data = board()
    applyMutations(data, [{ kind: 'add_rail', orient: 'h', x: 0, y: 0, slots: 3 }])
    const rail = findRails(data)[0]!
    const batch = [rail.group.id, ...rail.joints.map((j) => j.id)].map((id) => ({ kind: 'delete_node' as const, id }))
    const outcome = applyMutations(data, batch) // React Flow sends group AND children
    expect(data.nodes).toHaveLength(0)
    expect(outcome.deletedIds).toContain(rail.joints[0]!.id)
  })

  it('set_geometry with pin:false moves the node without marking it human-arranged', () => {
    const data = board()
    applyOps(data, [{ op: 'add_node', text: 'rider' }])
    const id = data.nodes![0]!.id
    const outcome = applyMutations(data, [
      { kind: 'set_geometry', id, x: 500, y: 500, pin: false },
    ])
    expect(data.nodes![0]).toMatchObject({ x: 500, y: 500 })
    expect(outcome.movedIds).toHaveLength(0)
  })
})
