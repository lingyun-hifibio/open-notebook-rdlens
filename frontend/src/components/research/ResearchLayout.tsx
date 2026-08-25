'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  clampPrimaryPixels,
  getPrimaryPercentBounds,
  percentToPixels,
  pixelsToPercent,
} from './research-layout-utils'

const HANDLE_SIZE = 8
const KEYBOARD_STEP = 5

export interface ResearchLayoutProps {
  layoutId: string
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
  compactPanel?: 'primary' | 'secondary'
  onCompactPanelChange?: (panel: 'primary' | 'secondary') => void
  children: [React.ReactNode, React.ReactNode]
}

/**
 * Keeps both panels in a single DOM tree. Pointer moves update CSS variables
 * directly and only commit React state when the gesture ends, protecting the
 * streaming chat subtrees from high-frequency renders.
 */
export function ResearchLayout({
  layoutId,
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
  compactPanel: controlledCompactPanel,
  onCompactPanelChange,
  children,
}: ResearchLayoutProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const separatorRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLElement>(null)
  const secondaryRef = useRef<HTMLElement>(null)
  const restoreRef = useRef<HTMLButtonElement>(null)
  const compactPrimaryTabRef = useRef<HTMLButtonElement>(null)
  const compactSecondaryTabRef = useRef<HTMLButtonElement>(null)
  const ratioRef = useRef(defaultRatio)
  const boundsRef = useRef({ min: 0, max: 100 })
  const layoutIdRef = useRef(layoutId)
  const compactRef = useRef(compact)
  const ratiosRef = useRef<Record<string, number>>({ [layoutId]: defaultRatio })
  const pointerIdRef = useRef<number | null>(null)
  const pointerTargetRef = useRef<HTMLDivElement | null>(null)
  const latestCoordinateRef = useRef<number | null>(null)
  const draggingRef = useRef(false)
  const resizeDuringDragRef = useRef(false)
  const frameRef = useRef<number | null>(null)
  const bodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null)
  const [ratio, setRatio] = useState(defaultRatio)
  const [bounds, setBounds] = useState({ min: 0, max: 100 })
  const [maximized, setMaximized] = useState(false)
  const [uncontrolledCompactPanel, setUncontrolledCompactPanel] = useState<'primary' | 'secondary'>('secondary')
  const compactPanel = controlledCompactPanel ?? uncontrolledCompactPanel
  const activeMaximized = maximized && !compact
  const setCompactPanel = (panel: 'primary' | 'secondary') => {
    if (controlledCompactPanel === undefined) setUncontrolledCompactPanel(panel)
    onCompactPanelChange?.(panel)
  }

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
    if (!host) return { ratio: ratioRef.current, bounds: boundsRef.current }
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
    const nextBounds = getPrimaryPercentBounds(containerSize, HANDLE_SIZE, minPrimary, minSecondary)
    host.style.setProperty('--research-primary-size', `${pixels}px`)
    separatorRef.current?.setAttribute('aria-valuemin', String(Math.round(nextBounds.min)))
    separatorRef.current?.setAttribute('aria-valuemax', String(Math.round(nextBounds.max)))
    separatorRef.current?.setAttribute('aria-valuenow', String(Math.round(clampedRatio)))
    ratioRef.current = clampedRatio
    boundsRef.current = nextBounds
    return { ratio: clampedRatio, bounds: nextBounds }
  }, [getContainerSize, minPrimary, minSecondary])

  const syncMeasurement = useCallback((measurement: ReturnType<typeof applyRatio>) => {
    ratiosRef.current[layoutIdRef.current] = measurement.ratio
    setRatio((current) => Math.abs(current - measurement.ratio) > 0.01 ? measurement.ratio : current)
    setBounds((current) => (
      Math.abs(current.min - measurement.bounds.min) > 0.01
      || Math.abs(current.max - measurement.bounds.max) > 0.01
    ) ? measurement.bounds : current)
  }, [])

  const finishDragging = useCallback((commit: boolean) => {
    const wasDragging = draggingRef.current
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    const separator = pointerTargetRef.current ?? separatorRef.current
    if (pointerIdRef.current !== null && separator?.hasPointerCapture?.(pointerIdRef.current)) {
      separator.releasePointerCapture?.(pointerIdRef.current)
    }
    pointerIdRef.current = null
    pointerTargetRef.current = null
    latestCoordinateRef.current = null
    draggingRef.current = false
    if (bodyStyleRef.current) {
      document.body.style.cursor = bodyStyleRef.current.cursor
      document.body.style.userSelect = bodyStyleRef.current.userSelect
      bodyStyleRef.current = null
    }
    if (wasDragging) {
      const measurement = applyRatio(ratioRef.current)
      if (commit) syncMeasurement(measurement)
    }
    resizeDuringDragRef.current = false
  }, [applyRatio, syncMeasurement])

  const applyPointerCoordinate = useCallback((clientCoordinate: number) => {
    const rect = hostRef.current?.getBoundingClientRect()
    if (!rect) return
    const local = clientCoordinate - (isVertical ? rect.top : rect.left)
    const available = Math.max(0, getContainerSize() - HANDLE_SIZE)
    const ratioFromPointer = pixelsToPercent(local, available)
    applyRatio(ratioFromPointer)
  }, [applyRatio, getContainerSize, isVertical])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      draggingRef.current
      || pointerIdRef.current !== null
      || compact
      || activeMaximized
      || (event.button !== 0 && event.button !== undefined)
    ) return
    const separator = separatorRef.current
    if (!separator) return
    event.preventDefault()
    pointerIdRef.current = event.pointerId
    pointerTargetRef.current = separator
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
    if (!activeMaximized) focusRestoreIfNeeded()
    setMaximized((value) => !value)
  }

  useLayoutEffect(() => {
    const enteringCompact = compact && !compactRef.current

    if (enteringCompact) {
      // Compact mode has no meaningful split measurement. Preserve the last
      // desktop ratio before the host changes to its single-panel geometry.
      ratiosRef.current[layoutIdRef.current] = ratioRef.current
    }
    if (layoutIdRef.current !== layoutId) {
      // Save the outgoing layout before applying the incoming layout's axis and
      // minimums. Otherwise the new constraints can overwrite the old ratio.
      ratiosRef.current[layoutIdRef.current] = ratioRef.current
      layoutIdRef.current = layoutId
      ratioRef.current = ratiosRef.current[layoutId] ?? defaultRatio
    }
    compactRef.current = compact
    if (compact) return
    syncMeasurement(applyRatio(ratioRef.current))
  }, [applyRatio, compact, defaultRatio, layoutId, syncMeasurement])

  useLayoutEffect(() => {
    if (!compact) return

    const active = document.activeElement
    const activePanelIsHidden = compactPanel === 'primary'
      ? Boolean(active && secondaryRef.current?.contains(active))
      : Boolean(active && primaryRef.current?.contains(active))
    if (active === restoreRef.current || activePanelIsHidden) {
      const selectedTab = compactPanel === 'primary' ? compactPrimaryTabRef.current : compactSecondaryTabRef.current
      selectedTab?.focus()
    }
    if (maximized) setMaximized(false)
  }, [compact, compactPanel, maximized])

  useEffect(() => {
    const host = hostRef.current
    if (compact || !host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      // A callback queued by the desktop observer can still arrive while its
      // compact-mode cleanup is running. Never let that stale measurement
      // replace the saved desktop ratio.
      if (compactRef.current) return
      if (draggingRef.current) {
        resizeDuringDragRef.current = true
        return
      }
      syncMeasurement(applyRatio(ratioRef.current))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [applyRatio, compact, syncMeasurement])

  useEffect(() => {
    const cancel = () => finishDragging(false)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      finishDragging(false)
    }
  }, [finishDragging])

  useEffect(() => {
    if (compact || activeMaximized) finishDragging(false)
  }, [activeMaximized, compact, finishDragging])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (compact || activeMaximized) return
    const decrement = isVertical ? 'ArrowUp' : 'ArrowLeft'
    const increment = isVertical ? 'ArrowDown' : 'ArrowRight'
    let nextRatio: number | null = null
    if (event.key === decrement) nextRatio = ratioRef.current - KEYBOARD_STEP
    if (event.key === increment) nextRatio = ratioRef.current + KEYBOARD_STEP
    if (event.key === 'Home') nextRatio = boundsRef.current.min
    if (event.key === 'End') nextRatio = boundsRef.current.max
    if (nextRatio === null) return
    event.preventDefault()
    syncMeasurement(applyRatio(nextRatio))
  }

  const gridStyle = isVertical
    ? { gridTemplateRows: activeMaximized ? '0px 0px minmax(0, 1fr)' : 'minmax(0, var(--research-primary-size)) 8px minmax(0, 1fr)' }
    : { gridTemplateColumns: activeMaximized ? '0px 0px minmax(0, 1fr)' : 'minmax(0, var(--research-primary-size)) 8px minmax(0, 1fr)' }

  return (
    <div
      ref={hostRef}
      className={compact
        ? 'relative flex h-full min-h-0 flex-col'
        : `relative grid h-full min-h-0 ${isVertical ? 'grid-rows-[minmax(0,var(--research-primary-size))_8px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,var(--research-primary-size))_8px_minmax(0,1fr)]'}`}
      style={compact ? undefined : gridStyle}
      data-testid="research-layout"
      data-axis={axis}
    >
      <section
        ref={primaryRef}
        hidden={activeMaximized || (compact && compactPanel !== 'primary')}
        aria-label={primaryLabel}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {children[0]}
      </section>
      <div
        ref={separatorRef}
        hidden={activeMaximized}
        {...(compact ? {
          role: 'tablist' as const,
          'aria-label': separatorLabel,
          className: 'flex shrink-0 gap-2 border-b p-2',
        } : {
          role: 'separator' as const,
          tabIndex: 0,
          'aria-label': separatorLabel,
          'aria-orientation': isVertical ? 'horizontal' : 'vertical',
          'aria-valuemin': Math.round(bounds.min),
          'aria-valuemax': Math.round(bounds.max),
          'aria-valuenow': Math.round(ratio),
          className: isVertical ? 'cursor-row-resize touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring' : 'cursor-col-resize touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: () => finishDragging(false),
          onLostPointerCapture: () => finishDragging(false),
          onKeyDown,
          onDoubleClick: () => {
            syncMeasurement(applyRatio(defaultRatio))
          },
        })}
      >
        {compact && (
          <>
            <button ref={compactPrimaryTabRef} type="button" role="tab" aria-selected={compactPanel === 'primary'} onClick={() => setCompactPanel('primary')}>
              {compactPrimaryLabel}
            </button>
            <button ref={compactSecondaryTabRef} type="button" role="tab" aria-selected={compactPanel === 'secondary'} onClick={() => setCompactPanel('secondary')}>
              {compactSecondaryLabel}
            </button>
          </>
        )}
      </div>
      <section
        ref={secondaryRef}
        hidden={compact && compactPanel !== 'secondary'}
        aria-label={secondaryLabel}
        className="min-h-0 flex-1 overflow-hidden"
        style={compact ? undefined : (isVertical ? { gridRow: 3 } : { gridColumn: 3 })}
      >
        {children[1]}
      </section>
      <button
        ref={restoreRef}
        hidden={compact}
        type="button"
        className={`absolute z-10 rounded border bg-background px-2 py-1 text-xs shadow-sm ${
          isVertical
            ? 'right-3 top-1/2 -translate-y-1/2'
            : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
        }`}
        onClick={toggleMaximized}
      >
        {activeMaximized ? restoreLabel : expandSecondaryLabel}
      </button>
    </div>
  )
}
