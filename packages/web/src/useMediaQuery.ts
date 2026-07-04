import { useEffect, useState } from 'react'

/** Reactive matchMedia — drives the phone layout and touch-only affordances. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Canvas-first viewport (phones AND tablets): the desktop 3-column grid
 * leaves iPad portrait a ~200px canvas strip — cards at working zoom are
 * wider than the strip and their centers sit under the side panels
 * (hit-map audit 2026-07-04). Panels become overlays, editing is modal. */
export const PHONE_QUERY = '(max-width: 1024px)'
/** Touch-first device (phone or tablet): selection gets a floating action toolbar. */
export const COARSE_QUERY = '(pointer: coarse)'
