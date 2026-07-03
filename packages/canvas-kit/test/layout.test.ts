import { describe, expect, it } from 'vitest'
import { autoLayout, type CanvasData } from '../src/index.ts'

describe('autoLayout', () => {
  it('untangles a chain left-to-right and keeps the board anchored', async () => {
    const data: CanvasData = {
      nodes: [
        { id: 'n1aaaaaaaaaaaaaa', type: 'text', text: 'a', x: 500, y: 500, width: 200, height: 80 },
        { id: 'n2aaaaaaaaaaaaaa', type: 'text', text: 'b', x: 480, y: 520, width: 200, height: 80 },
        { id: 'n3aaaaaaaaaaaaaa', type: 'text', text: 'c', x: 510, y: 490, width: 200, height: 80 },
      ],
      edges: [
        { id: 'e1', fromNode: 'n1aaaaaaaaaaaaaa', toNode: 'n2aaaaaaaaaaaaaa' },
        { id: 'e2', fromNode: 'n2aaaaaaaaaaaaaa', toNode: 'n3aaaaaaaaaaaaaa' },
      ],
    }
    await autoLayout(data)
    const [a, b, c] = data.nodes!
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x)
    expect(b!.x + b!.width).toBeLessThanOrEqual(c!.x)
    // board stays roughly where it was (no viewport jump)
    const minX = Math.min(a!.x, b!.x, c!.x)
    const minY = Math.min(a!.y, b!.y, c!.y)
    expect(Math.abs(minX - 480)).toBeLessThanOrEqual(1)
    expect(Math.abs(minY - 490)).toBeLessThanOrEqual(1)
  })

  it('leaves pinned nodes in place and flows the rest around them', async () => {
    const data: CanvasData = {
      nodes: [
        { id: 'free1aaaaaaaaaaa', type: 'text', text: 'a', x: 0, y: 0, width: 200, height: 80 },
        { id: 'pinnedaaaaaaaaaa', type: 'text', text: 'human put me here', x: 40, y: 20, width: 200, height: 80 },
        { id: 'free2aaaaaaaaaaa', type: 'text', text: 'c', x: 10, y: 30, width: 200, height: 80 },
      ],
      edges: [{ id: 'e1', fromNode: 'free1aaaaaaaaaaa', toNode: 'free2aaaaaaaaaaa' }],
    }
    await autoLayout(data, { pinned: new Set(['pinnedaaaaaaaaaa']) })
    const pinnedNode = data.nodes!.find((n) => n.id.startsWith('pinned'))!
    expect(pinnedNode.x).toBe(40)
    expect(pinnedNode.y).toBe(20)
    for (const n of data.nodes!) {
      if (n.id === pinnedNode.id) continue
      const overlap =
        n.x < pinnedNode.x + pinnedNode.width &&
        n.x + n.width > pinnedNode.x &&
        n.y < pinnedNode.y + pinnedNode.height &&
        n.y + n.height > pinnedNode.y
      expect(overlap).toBe(false)
    }
  })

  it('moves groups as blocks, preserving internal arrangement', async () => {
    const data: CanvasData = {
      nodes: [
        { id: 'aaaa000000000000', type: 'text', text: 'solo', x: 0, y: 0, width: 200, height: 80 },
        { id: 'gggg000000000000', type: 'group', label: 'G', x: 10, y: 10, width: 400, height: 300 },
        { id: 'mmmm000000000000', type: 'text', text: 'member', x: 50, y: 60, width: 200, height: 80 },
      ],
      edges: [{ id: 'e1', fromNode: 'aaaa000000000000', toNode: 'mmmm000000000000' }],
    }
    const before = data.nodes!.find((n) => n.id.startsWith('mmmm'))!
    const beforeOffset = { x: before.x - 10, y: before.y - 10 }
    await autoLayout(data)
    const group = data.nodes!.find((n) => n.id.startsWith('gggg'))!
    const member = data.nodes!.find((n) => n.id.startsWith('mmmm'))!
    expect(member.x - group.x).toBe(beforeOffset.x)
    expect(member.y - group.y).toBe(beforeOffset.y)
  })
})
