import { describe, expect, it } from 'vitest'
import { diffBoards, isEmptyDiff, type CanvasData } from '../src/index.ts'

const base = (): CanvasData => ({
  nodes: [
    { id: 'a', type: 'text', text: 'one', x: 0, y: 0, width: 100, height: 50 },
    { id: 'b', type: 'text', text: 'two', x: 200, y: 0, width: 100, height: 50 },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
})

describe('diffBoards', () => {
  it('classifies moves, edits, adds, and removals', () => {
    const before = base()
    const after = structuredClone(before)
    after.nodes![0]!.x = 50 // moved
    after.nodes![1]!.text = 'TWO' // edited
    after.nodes!.push({ id: 'c', type: 'text', text: 'new', x: 0, y: 100, width: 100, height: 50 })
    after.edges = [] // edge removed

    const diff = diffBoards(before, after)
    expect(diff.movedNodes).toEqual(['a'])
    expect(diff.editedNodes).toEqual(['b'])
    expect(diff.addedNodes).toEqual(['c'])
    expect(diff.removedEdges).toEqual(['e1'])
    expect(isEmptyDiff(diff)).toBe(false)
  })

  it('reports identical boards as empty', () => {
    expect(isEmptyDiff(diffBoards(base(), base()))).toBe(true)
  })
})
