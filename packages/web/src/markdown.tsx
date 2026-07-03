import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true })

let mermaidSeq = 0

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    const id = `ps-mermaid-${++mermaidSeq}`
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg
      })
      .catch((error: unknown) => {
        // show WHY it failed instead of silently degrading to raw text —
        // common trap: parentheses inside unquoted [] labels
        if (cancelled || !ref.current) return
        ref.current.innerHTML = ''
        const banner = document.createElement('div')
        banner.className = 'ps-mermaid-error'
        banner.textContent = `mermaid: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
        const pre = document.createElement('pre')
        pre.textContent = code
        ref.current.append(banner, pre)
        document.getElementById(`d${id}`)?.remove()
      })
    return () => {
      cancelled = true
    }
  }, [code])
  return <div className="ps-mermaid nodrag nowheel" ref={ref} />
}

type Part = { kind: 'md' | 'mermaid'; src: string }

function splitMermaid(text: string): Part[] {
  const parts: Part[] = []
  const fence = /```mermaid\s*\n([\s\S]*?)```/g
  let last = 0
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m.index > last) parts.push({ kind: 'md', src: text.slice(last, m.index) })
    parts.push({ kind: 'mermaid', src: m[1] ?? '' })
    last = fence.lastIndex
  }
  if (last < text.length) parts.push({ kind: 'md', src: text.slice(last) })
  return parts.length > 0 ? parts : [{ kind: 'md', src: '' }]
}

/** Markdown card body; ```mermaid fences render as live diagrams (design D2). */
export function Markdown({ text }: { text: string }) {
  const parts = useMemo(() => splitMermaid(text), [text])
  return (
    <div className="ps-md">
      {parts.map((part, index) =>
        part.kind === 'mermaid' ? (
          <MermaidBlock key={index} code={part.src} />
        ) : (
          <div
            key={index}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(part.src, { async: false }) as string) }}
          />
        ),
      )}
    </div>
  )
}
