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

/** Phone-sized viewport: panels become overlays, editing moves into a modal. */
export const PHONE_QUERY = '(max-width: 767px)'
/** Touch-first device (phone or tablet): selection gets a floating action toolbar. */
export const COARSE_QUERY = '(pointer: coarse)'
