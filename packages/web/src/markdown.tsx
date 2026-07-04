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

type Part = { kind: 'md'; html: string } | { kind: 'mermaid'; code: string }

/** split ```mermaid fences out; parse+sanitize the rest to HTML up front */
function parseParts(text: string): Part[] {
  const md = (src: string): Part => ({
    kind: 'md',
    html: DOMPurify.sanitize(marked.parse(src, { async: false }) as string),
  })
  const parts: Part[] = []
  const fence = /```mermaid\s*\n([\s\S]*?)```/g
  let last = 0
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m.index > last) parts.push(md(text.slice(last, m.index)))
    parts.push({ kind: 'mermaid', code: m[1] ?? '' })
    last = fence.lastIndex
  }
  if (last < text.length) parts.push(md(text.slice(last)))
  return parts.length > 0 ? parts : [md('')]
}

/** Markdown card body; ```mermaid fences render as live diagrams (design D2). */
export function Markdown({ text }: { text: string }) {
  // parse once per text change — a dragged node re-renders every pointer
  // frame, and markdown parsing at frame rate janks the drag on phones
  const parts = useMemo(() => parseParts(text), [text])
  return (
    <div className="ps-md">
      {parts.map((part, index) =>
        part.kind === 'mermaid' ? (
          <MermaidBlock key={index} code={part.code} />
        ) : (
          <div key={index} dangerouslySetInnerHTML={{ __html: part.html }} />
        ),
      )}
    </div>
  )
}
