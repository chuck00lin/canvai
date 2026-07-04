import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

interface LongPressOptions {
  /** stationary touch held past `delay` */
  onLongPress?: (point: { x: number; y: number }) => void
  /** two quick taps in place (touch dblclick is unreliable across mobile browsers) */
  onDoubleTap?: (point: { x: number; y: number }) => void
  delay?: number
  /** finger drift beyond this cancels the press — it became a drag/pan */
  moveTolerance?: number
  /** filter which pointerdowns arm the gesture (e.g. only the empty pane) */
  accept?: (event: ReactPointerEvent) => boolean
}

/**
 * Touch-only long-press + double-tap recognizer, as spreadable pointer
 * handlers. Mouse/pen pass through untouched so desktop semantics stay
 * exactly as they are. Tolerances sit just above the node-drag threshold:
 * a press that starts dragging cancels the gesture, not the other way round.
 */
export function useLongPress({ onLongPress, onDoubleTap, delay = 450, moveTolerance = 10, accept }: LongPressOptions) {
  const timer = useRef<number | undefined>(undefined)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)

  const cancel = () => {
    window.clearTimeout(timer.current)
    origin.current = null
  }

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'touch') return
    if (accept && !accept(event)) return
    const point = { x: event.clientX, y: event.clientY }
    origin.current = point
    window.clearTimeout(timer.current)
    if (!onLongPress) return
    timer.current = window.setTimeout(() => {
      if (!origin.current) return
      origin.current = null
      lastTap.current = null
      onLongPress(point)
    }, delay)
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!origin.current || event.pointerType !== 'touch') return
    if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > moveTolerance) cancel()
  }

  const onPointerUp = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'touch') return
    if (origin.current && onDoubleTap) {
      const now = performance.now()
      const point = { x: event.clientX, y: event.clientY }
      const prev = lastTap.current
      if (prev && now - prev.t < 320 && Math.hypot(point.x - prev.x, point.y - prev.y) < 24) {
        lastTap.current = null
        cancel()
        onDoubleTap(point)
        return
      }
      lastTap.current = { t: now, x: point.x, y: point.y }
    }
    cancel()
  }

  const onPointerCancel = () => cancel()

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
