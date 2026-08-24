'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampPrimaryPixels, percentToPixels, pixelsToPercent } from './research-layout-utils'

const HANDLE_SIZE = 8
const KEYBOARD_STEP = 5

export interface ResearchLayoutProps {
  axis: 'vertical' | 'horizontal'
  compact: boolean
  defaultRatio: number
  minPrimary: number
  minSecondary: number
  primaryLabel: string
  secondaryLabel: string
  separatorLabel: string
  expandSecondaryLabel: string
  restoreLabel: string
  compactPrimaryLabel: string
  compactSecondaryLabel: string
  children: [React.ReactNode, React.ReactNode]
}

/**
 * Keeps both panels in a single DOM tree. Pointer moves update CSS variables
 * directly and only commit React state when the gesture ends, protecting the
 * streaming chat subtrees from high-frequency renders.
 */
export function ResearchLayout({
  axis,
  compact,
  defaultRatio,
  minPrimary,
  minSecondary,
  primaryLabel,
  secondaryLabel,
  separatorLabel,
  expandSecondaryLabel,
  restoreLabel,
  compactPrimaryLabel,
  compactSecondaryLabel,
  children,
}: ResearchLayoutProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const separatorRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLElement>(null)
  const secondaryRef = useRef<HTMLElement>(null)
  const restoreRef = useRef<HTMLButtonElement>(null)
  const ratioRef = useRef(defaultRatio)
  const pointerIdRef = useRef<number | null>(null)
  const latestCoordinateRef = useRef<number | null>(null)
  const draggingRef = useRef(false)
  const resizeDuringDragRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const bodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null)
  const [ratio, setRatio] = useState(defaultRatio)
  const [maximized, setMaximized] = useState(false)
  const [compactPanel, setCompactPanel] = useState<'primary' | 'secondary'>('secondary')

  const isVertical = axis === 'vertical'
  const coordinate = useCallback((event: Pick<PointerEvent, 'clientX' | 'clientY'>) => (
    isVertical ? event.clientY : event.clientX
  ), [isVertical])

  const getContainerSize = useCallback(() => {
    const rect = hostRef.current?.getBoundingClientRect()
    return isVertical ? (rect?.height ?? 0) : (rect?.width ?? 0)
  }, [isVertical])

  const applyRatio = useCallback((nextRatio: number) => {
    const host = hostRef.current
    if (!host) return defaultRatio
    const containerSize = getContainerSize()
    const available = Math.max(0, containerSize - HANDLE_SIZE)
    const pixels = clampPrimaryPixels(
      containerSize,
      percentToPixels(nextRatio, available),
      HANDLE_SIZE,
      minPrimary,
      minSecondary,
    )
    const clampedRatio = pixelsToPercent(pixels, available)
    host.style.setProperty('--research-primary-size', `${pixels}px`)
    separatorRef.current?.setAttribute('aria-valuenow', String(Math.round(clampedRatio)))
    ratioRef.current = clampedRatio
    return clampedRatio
  }, [defaultRatio, getContainerSize, minPrimary, minSecondary])

  const finishDragging = useCallback((commit: boolean) => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    const separator = separatorRef.current
    if (pointerIdRef.current !== null && separator?.hasPointerCapture?.(pointerIdRef.current)) {
      separator.releasePointerCapture?.(pointerIdRef.current)
    }
    pointerIdRef.current = null
    latestCoordinateRef.current = null
    draggingRef.current = false
    if (bodyStyleRef.current) {
      document.body.style.cursor = bodyStyleRef.current.cursor
      document.body.style.userSelect = bodyStyleRef.current.userSelect
      bodyStyleRef.current = null
    }
    const clamped = applyRatio(ratioRef.current)
    if (commit) setRatio(clamped)
    resizeDuringDragRef.current = false
  }, [applyRatio])

  const applyPointerCoordinate = useCallback((clientCoordinate: number) => {
    const rect = hostRef.current?.getBoundingClientRect()
    if (!rect) return
    const local = clientCoordinate - (isVertical ? rect.top : rect.left)
    const available = Math.max(0, getContainerSize() - HANDLE_SIZE)
    const ratioFromPointer = pixelsToPercent(local, available)
    applyRatio(ratioFromPointer)
  }, [applyRatio, getContainerSize, isVertical])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (compact || maximized || (event.button !== 0 && event.button !== undefined)) return
    const separator = separatorRef.current
    if (!separator) return
    event.preventDefault()
    pointerIdRef.current = event.pointerId
    latestCoordinateRef.current = coordinate(event.nativeEvent)
    draggingRef.current = true
    bodyStyleRef.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    separator.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || event.pointerId !== pointerIdRef.current) return
    latestCoordinateRef.current = coordinate(event.nativeEvent)
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (latestCoordinateRef.current !== null) applyPointerCoordinate(latestCoordinateRef.current)
    })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || event.pointerId !== pointerIdRef.current) return
    // Ensure the final, possibly not-yet-framed coordinate is committed.
    applyPointerCoordinate(coordinate(event.nativeEvent))
    finishDragging(true)
  }

  const focusRestoreIfNeeded = useCallback(() => {
    const active = document.activeElement
    if (active && primaryRef.current?.contains(active)) restoreRef.current?.focus()
  }, [])

  const toggleMaximized = () => {
    if (!maximized) focusRestoreIfNeeded()
    setMaximized((value) => !value)
  }

  useLayoutEffect(() => {
    applyRatio(ratio)
  }, [applyRatio, ratio])

  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (draggingRef.current) {
        resizeDuringDragRef.current = true
        return
      }
      const clamped = applyRatio(ratioRef.current)
      if (Math.abs(clamped - ratioRef.current) > 0.01) setRatio(clamped)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [applyRatio])

  useEffect(() => {
    const cancel = () => finishDragging(false)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      finishDragging(false)
    }
  }, [finishDragging])

  useEffect(() => {
    if (compact || maximized) finishDragging(false)
  }, [compact, maximized, finishDragging])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (compact || maximized) return
    const decrement = isVertical ? 'ArrowUp' : 'ArrowLeft'
    const increment = isVertical ? 'ArrowDown' : 'ArrowRight'
    let nextRatio: number | null = null
    if (event.key === decrement) nextRatio = ratioRef.current - KEYBOARD_STEP
    if (event.key === increment) nextRatio = ratioRef.current + KEYBOARD_STEP
    if (event.key === 'Home') nextRatio = -Infinity
    if (event.key === 'End') nextRatio = Infinity
    if (nextRatio === null) return
    event.preventDefault()
    const clamped = applyRatio(nextRatio)
    setRatio(clamped)
  }

  const gridStyle = isVertical
    ? { gridTemplateRows: maximized ? '0px minmax(0, 1fr)' : 'minmax(0, var(--research-primary-size)) 8px minmax(0, 1fr)' }
    : { gridTemplateColumns: maximized ? '0px minmax(0, 1fr)' : 'minmax(0, var(--research-primary-size)) 8px minmax(0, 1fr)' }

  if (compact) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="research-layout-compact">
        <div className="flex shrink-0 gap-2 border-b p-2" role="tablist" aria-label={separatorLabel}>
          <button type="button" role="tab" aria-selected={compactPanel === 'primary'} onClick={() => setCompactPanel('primary')}>
            {compactPrimaryLabel}
          </button>
          <button type="button" role="tab" aria-selected={compactPanel === 'secondary'} onClick={() => setCompactPanel('secondary')}>
            {compactSecondaryLabel}
          </button>
        </div>
        <section ref={primaryRef} hidden={compactPanel !== 'primary'} aria-label={primaryLabel} className="min-h-0 flex-1">
          {children[0]}
        </section>
        <section ref={secondaryRef} hidden={compactPanel !== 'secondary'} aria-label={secondaryLabel} className="min-h-0 flex-1">
          {children[1]}
        </section>
      </div>
    )
  }

  return (
    <div
      ref={hostRef}
      className={`relative grid h-full min-h-0 ${isVertical ? 'grid-rows-[minmax(0,var(--research-primary-size))_8px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,var(--research-primary-size))_8px_minmax(0,1fr)]'}`}
      style={gridStyle}
      data-testid="research-layout"
      data-axis={axis}
    >
      <section ref={primaryRef} hidden={maximized} aria-label={primaryLabel} className="min-h-0 overflow-hidden">
        {children[0]}
      </section>
      {!maximized && (
        <div
          ref={separatorRef}
          role="separator"
          tabIndex={0}
          aria-label={separatorLabel}
          aria-orientation={isVertical ? 'horizontal' : 'vertical'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio)}
          className={isVertical ? 'cursor-row-resize touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring' : 'cursor-col-resize touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => finishDragging(false)}
          onLostPointerCapture={() => finishDragging(false)}
          onKeyDown={onKeyDown}
          onDoubleClick={() => {
            const clamped = applyRatio(defaultRatio)
            setRatio(clamped)
          }}
        />
      )}
      <section ref={secondaryRef} aria-label={secondaryLabel} className="min-h-0 overflow-hidden">
        {children[1]}
      </section>
      <button ref={restoreRef} type="button" className="absolute right-3 top-3 z-10" onClick={toggleMaximized}>
        {maximized ? restoreLabel : expandSecondaryLabel}
      </button>
    </div>
  )
}
