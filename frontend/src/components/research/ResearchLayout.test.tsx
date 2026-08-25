import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, useEffect, useLayoutEffect } from 'react'
import { ResearchLayout, type ResearchLayoutProps } from './ResearchLayout'

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []

  private readonly callback: ResizeObserverCallback
  private target: Element | null = null
  private lastTarget: Element | null = null
  observe = vi.fn((target: Element) => {
    this.target = target
    this.lastTarget = target
  })
  disconnect = vi.fn(() => { this.target = null })

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ResizeObserverMock.instances.push(this)
  }

  trigger() {
    if (!this.target) return
    this.callback([{ target: this.target } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }

  triggerQueuedCallback() {
    if (!this.lastTarget) return
    this.callback([{ target: this.lastTarget } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

const defaultProps: Omit<ResearchLayoutProps, 'children'> = {
  layoutId: 'global',
  axis: 'vertical',
  compact: false,
  defaultRatio: 40,
  minPrimary: 200,
  minSecondary: 300,
  primaryLabel: 'primary',
  secondaryLabel: 'secondary',
  separatorLabel: 'resize panels',
  expandSecondaryLabel: 'expand workspace',
  restoreLabel: 'restore layout',
  compactPrimaryLabel: 'artifacts',
  compactSecondaryLabel: 'workspace',
}

function layout(overrides: Partial<ResearchLayoutProps> = {}) {
  return (
    <ResearchLayout {...defaultProps} {...overrides}>
      {overrides.children ?? [
        <button key="one">primary action</button>,
        <button key="two">secondary action</button>,
      ]}
    </ResearchLayout>
  )
}

function renderLayout(overrides: Partial<ResearchLayoutProps> = {}) {
  return render(layout(overrides))
}

function pointerEvent(type: string, coordinate: number, pointerId = 1, axis: 'vertical' | 'horizontal' = 'vertical') {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: axis === 'horizontal' ? coordinate : 0,
    clientY: axis === 'vertical' ? coordinate : 0,
  })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

describe('ResearchLayout', () => {
  let width: number
  let height: number
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>
  let cancelFrame: ReturnType<typeof vi.fn>

  const flushAnimationFrames = () => {
    const pending = [...frames.entries()]
    frames.clear()
    act(() => pending.forEach(([, callback]) => callback(0)))
  }

  const triggerResize = () => {
    const observer = ResizeObserverMock.instances.at(-1)
    if (!observer) throw new Error('Expected a ResizeObserver instance')
    act(() => observer.trigger())
  }

  beforeEach(() => {
    width = 900
    height = 800
    nextFrameId = 1
    frames = new Map()
    ResizeObserverMock.instances = []
    cancelFrame = vi.fn((frameId: number) => { frames.delete(frameId) })
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const frameId = nextFrameId++
      frames.set(frameId, callback)
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses dynamic ARIA bounds and keeps Home and End within the reachable range', () => {
    renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    expect(separator).toHaveAttribute('aria-valuemin', '25')
    expect(separator).toHaveAttribute('aria-valuemax', '62')

    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '25')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '62')

    height = 600
    triggerResize()
    expect(separator).toHaveAttribute('aria-valuemin', '34')
    expect(separator).toHaveAttribute('aria-valuemax', '49')
    expect(separator).toHaveAttribute('aria-valuenow', '49')
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '34')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator).toHaveAttribute('aria-valuenow', '49')
  })

  it('defers pointer moves to RAF and commits the final coordinate over a pending frame', () => {
    renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 250))
    fireEvent(separator, pointerEvent('pointermove', 400))
    expect(frames).toHaveLength(1)
    expect(separator).toHaveAttribute('aria-valuenow', '40')

    flushAnimationFrames()
    expect(separator).toHaveAttribute('aria-valuenow', '51')

    fireEvent(separator, pointerEvent('pointermove', 450))
    expect(frames).toHaveLength(1)
    fireEvent(separator, pointerEvent('pointerup', 390))
    expect(separator).toHaveAttribute('aria-valuenow', '49')
    expect(cancelFrame).toHaveBeenCalled()
    expect(frames).toHaveLength(0)
    flushAnimationFrames()
    expect(separator).toHaveAttribute('aria-valuenow', '49')
  })

  it('keeps ratios independent when a layout switch also changes axis and minimums', () => {
    const { rerender } = renderLayout()
    const globalSeparator = screen.getByRole('separator', { name: 'resize panels' })
    fireEvent.keyDown(globalSeparator, { key: 'ArrowDown' })
    expect(globalSeparator).toHaveAttribute('aria-valuenow', '45')

    rerender(layout({
      layoutId: 'source',
      axis: 'horizontal',
      defaultRatio: 70,
      minPrimary: 600,
      minSecondary: 200,
    }))
    const sourceSeparator = screen.getByRole('separator', { name: 'resize panels' })
    expect(sourceSeparator).toHaveAttribute('aria-orientation', 'vertical')
    expect(sourceSeparator).toHaveAttribute('aria-valuenow', '70')
    fireEvent.keyDown(sourceSeparator, { key: 'ArrowRight' })
    expect(sourceSeparator).toHaveAttribute('aria-valuenow', '75')

    rerender(layout())
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '45')

    rerender(layout({
      layoutId: 'source',
      axis: 'horizontal',
      defaultRatio: 70,
      minPrimary: 600,
      minSecondary: 200,
    }))
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '75')
  })

  it('ignores queued resize callbacks from a previous non-compact layout', () => {
    const sourceProps = {
      layoutId: 'source',
      axis: 'horizontal' as const,
      defaultRatio: 70,
      minPrimary: 600,
      minSecondary: 200,
    }
    let callbackRanBeforePassiveCleanup = false
    function ResizeRaceHarness({ source }: { source: boolean }) {
      useLayoutEffect(() => {
        if (!source) return
        callbackRanBeforePassiveCleanup = globalObserver?.disconnect.mock.calls.length === 0
        height = 420
        globalObserver?.triggerQueuedCallback()
      }, [source])
      return layout(source ? sourceProps : {})
    }

    const { rerender } = render(<ResizeRaceHarness source={false} />)
    const globalObserver = ResizeObserverMock.instances.at(-1)

    // Parent layout effects run after the child's layout effects but before
    // passive cleanup. Trigger the queued old callback in that exact window.
    rerender(<ResizeRaceHarness source />)
    const sourceSeparator = screen.getByRole('separator', { name: 'resize panels' })
    expect(callbackRanBeforePassiveCleanup).toBe(true)
    expect(sourceSeparator).toHaveAttribute('aria-orientation', 'vertical')
    expect(sourceSeparator).toHaveAttribute('aria-valuemin', '67')
    expect(sourceSeparator).toHaveAttribute('aria-valuemax', '78')
    expect(sourceSeparator).toHaveAttribute('aria-valuenow', '70')
  })

  it('invalidates an already queued pointer frame during the layout commit', () => {
    const { rerender } = renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 400))
    const staleFrame = [...frames.values()][0]
    expect(staleFrame).toBeDefined()

    rerender(layout({
      layoutId: 'source',
      axis: 'horizontal',
      defaultRatio: 70,
      minPrimary: 600,
      minSecondary: 200,
    }))
    const sourceSeparator = screen.getByRole('separator', { name: 'resize panels' })
    expect(frames).toHaveLength(0)

    fireEvent(sourceSeparator, pointerEvent('pointerdown', 10, 2, 'horizontal'))
    fireEvent(sourceSeparator, pointerEvent('pointermove', 650, 2, 'horizontal'))
    expect(frames).toHaveLength(1)

    // A browser may already have dequeued the callback when cancellation
    // happens. Invoke that saved callback directly to prove generation, rather
    // than passive cleanup, protects the newly committed geometry and cannot
    // steal ownership of the new generation's frame.
    act(() => staleFrame?.(0))
    expect(frames).toHaveLength(1)
    expect(sourceSeparator).toHaveAttribute('aria-orientation', 'vertical')
    expect(sourceSeparator).toHaveAttribute('aria-valuemin', '67')
    expect(sourceSeparator).toHaveAttribute('aria-valuemax', '78')
    expect(sourceSeparator).toHaveAttribute('aria-valuenow', '70')
    expect(screen.getByTestId('research-layout').style.getPropertyValue('--research-primary-size')).toBe('624.4px')

    flushAnimationFrames()
    expect(sourceSeparator).toHaveAttribute('aria-valuenow', '73')
    fireEvent(sourceSeparator, pointerEvent('pointercancel', 650, 2, 'horizontal'))
  })

  it('preserves the desktop ratio across compact mode with a low-height host', () => {
    const { rerender } = renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    expect(separator).toHaveAttribute('aria-valuenow', '45')

    const desktopObserver = ResizeObserverMock.instances.at(-1)
    height = 420
    rerender(layout({ compact: true }))
    act(() => desktopObserver?.triggerQueuedCallback())

    height = 800
    rerender(layout())
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '45')
  })

  it('cancels an active drag in compact mode without measuring compact geometry', () => {
    const { rerender } = renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    let capturedPointer: number | null = null
    const setPointerCapture = vi.fn((pointerId: number) => { capturedPointer = pointerId })
    const hasPointerCapture = vi.fn((pointerId: number) => capturedPointer === pointerId)
    const releasePointerCapture = vi.fn(() => { capturedPointer = null })
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: hasPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })

    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    expect(separator).toHaveAttribute('aria-valuenow', '45')
    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 300))
    expect(frames).toHaveLength(1)
    expect(document.body.style.userSelect).toBe('none')

    height = 420
    rerender(layout({ compact: true }))
    expect(frames).toHaveLength(0)
    expect(releasePointerCapture).toHaveBeenCalledWith(1)
    expect(document.body.style.userSelect).toBe('')

    height = 800
    rerender(layout())
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '45')
  })

  it('keeps source and global ratios independent across source compact mode', () => {
    const { rerender } = renderLayout()
    fireEvent.keyDown(screen.getByRole('separator', { name: 'resize panels' }), { key: 'ArrowDown' })

    const sourceLayout = {
      layoutId: 'source',
      axis: 'horizontal' as const,
      defaultRatio: 70,
      minPrimary: 600,
      minSecondary: 200,
    }
    rerender(layout(sourceLayout))
    fireEvent.keyDown(screen.getByRole('separator', { name: 'resize panels' }), { key: 'ArrowRight' })
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '75')

    width = 500
    rerender(layout({ ...sourceLayout, compact: true }))
    triggerResize()
    rerender(layout({ compact: true }))
    rerender(layout({ ...sourceLayout, compact: true }))

    width = 900
    rerender(layout(sourceLayout))
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '75')

    rerender(layout())
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '45')
  })

  it('exits maximized mode safely when entering compact mode and preserves a recovery focus target', () => {
    const { rerender } = renderLayout()
    const primaryAction = screen.getByRole('button', { name: 'primary action' })
    primaryAction.focus()
    fireEvent.click(screen.getByRole('button', { name: 'expand workspace' }))
    expect(primaryAction.closest('section')).toHaveAttribute('hidden')
    expect(document.activeElement).toHaveTextContent('restore layout')

    rerender(layout({ compact: true }))
    expect(screen.getByRole('tablist', { name: 'resize panels' })).not.toHaveAttribute('hidden')
    expect(screen.getByLabelText('secondary')).not.toHaveAttribute('hidden')
    expect(screen.getByRole('tab', { name: 'workspace' })).toHaveFocus()

    rerender(layout())
    expect(screen.getByRole('button', { name: 'expand workspace' })).toBeVisible()
    expect(screen.getByLabelText('primary')).not.toHaveAttribute('hidden')
  })

  it('uses hidden for maximized content and returns focus to the restore control', () => {
    renderLayout()
    const primaryAction = screen.getByRole('button', { name: 'primary action' })
    const expandButton = screen.getByRole('button', { name: 'expand workspace' })
    expect(expandButton).toHaveClass('top-1/2', '-translate-y-1/2')
    expect(expandButton).not.toHaveClass('top-3')
    primaryAction.focus()
    fireEvent.click(expandButton)
    expect(primaryAction.closest('section')).toHaveAttribute('hidden')
    expect(document.activeElement).toHaveTextContent('restore layout')
  })

  it('moves separator focus to the restore control before maximizing', () => {
    renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    const expandButton = screen.getByRole('button', { name: 'expand workspace' })

    separator.focus()
    expect(separator).toHaveFocus()
    fireEvent.click(expandButton)

    expect(separator).toHaveAttribute('hidden')
    expect(expandButton).toHaveTextContent('restore layout')
    expect(expandButton).toHaveFocus()
  })

  it('cleans pending pointer work on cancel, lost capture, blur, and unmount', () => {
    const { unmount } = renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    let capturedPointer: number | null = null
    const setPointerCapture = vi.fn((pointerId: number) => { capturedPointer = pointerId })
    const hasPointerCapture = vi.fn((pointerId: number) => capturedPointer === pointerId)
    const releasePointerCapture = vi.fn(() => { capturedPointer = null })
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: hasPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })

    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 300))
    expect(document.body.style.userSelect).toBe('none')
    fireEvent(separator, pointerEvent('pointercancel', 10))
    expect(document.body.style.userSelect).toBe('')
    expect(frames).toHaveLength(0)
    expect(releasePointerCapture).toHaveBeenCalledWith(1)

    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 300))
    fireEvent(separator, pointerEvent('lostpointercapture', 10))
    expect(document.body.style.userSelect).toBe('')
    expect(frames).toHaveLength(0)

    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 300))
    fireEvent(window, new Event('blur'))
    expect(document.body.style.userSelect).toBe('')
    expect(frames).toHaveLength(0)

    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 300))
    const observer = ResizeObserverMock.instances.at(-1)
    unmount()
    expect(document.body.style.userSelect).toBe('')
    expect(frames).toHaveLength(0)
    expect(observer?.disconnect).toHaveBeenCalled()
    expect(setPointerCapture).toHaveBeenCalledTimes(4)
    expect(releasePointerCapture).toHaveBeenCalledTimes(4)
  })

  it('keeps exactly one active observer and blur cleanup through StrictMode effect replay', () => {
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    let capturedPointer: number | null = null
    const setPointerCapture = vi.fn((pointerId: number) => { capturedPointer = pointerId })
    const hasPointerCapture = vi.fn((pointerId: number) => capturedPointer === pointerId)
    const releasePointerCapture = vi.fn(() => { capturedPointer = null })
    let seededFirstEffect = false

    function SeedDragDuringFirstEffect() {
      useEffect(() => {
        if (seededFirstEffect) return
        seededFirstEffect = true
        const separator = document.querySelector<HTMLElement>('[role="separator"]')
        if (!separator) throw new Error('Expected the separator during StrictMode effect setup')
        Object.defineProperties(separator, {
          setPointerCapture: { configurable: true, value: setPointerCapture },
          hasPointerCapture: { configurable: true, value: hasPointerCapture },
          releasePointerCapture: { configurable: true, value: releasePointerCapture },
        })
        separator.dispatchEvent(pointerEvent('pointerdown', 10))
        separator.dispatchEvent(pointerEvent('pointermove', 300))
      }, [])
      return <button>strict child action</button>
    }

    document.body.style.cursor = 'crosshair'
    document.body.style.userSelect = 'text'
    const { unmount } = render(
      <StrictMode>
        {layout({
          children: [<SeedDragDuringFirstEffect key="one" />, <button key="two">secondary action</button>],
        })}
      </StrictMode>,
    )

    const blurAdds = addWindowListener.mock.calls.filter(([type]) => type === 'blur')
    const blurRemovals = removeWindowListener.mock.calls.filter(([type]) => type === 'blur')
    expect(ResizeObserverMock.instances).toHaveLength(2)
    expect(ResizeObserverMock.instances[0].observe).toHaveBeenCalledOnce()
    expect(ResizeObserverMock.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(ResizeObserverMock.instances[1].observe).toHaveBeenCalledOnce()
    expect(ResizeObserverMock.instances[1].disconnect).not.toHaveBeenCalled()
    expect(blurAdds).toHaveLength(2)
    expect(blurRemovals).toEqual([['blur', blurAdds[0][1]]])

    const separator = screen.getByRole('separator', { name: 'resize panels' })
    height = 600
    act(() => ResizeObserverMock.instances[0].triggerQueuedCallback())
    expect(separator).toHaveAttribute('aria-valuemin', '25')
    expect(separator).toHaveAttribute('aria-valuemax', '62')
    act(() => ResizeObserverMock.instances[1].trigger())
    expect(separator).toHaveAttribute('aria-valuemin', '34')
    expect(separator).toHaveAttribute('aria-valuemax', '49')
    height = 800
    act(() => ResizeObserverMock.instances[1].trigger())

    // The first child passive effect starts a real drag before StrictMode's
    // development-only setup -> cleanup -> setup replay. That simulated
    // cleanup must release capture, cancel its RAF, and restore body styles.
    expect(setPointerCapture).toHaveBeenCalledOnce()
    expect(releasePointerCapture).toHaveBeenCalledOnce()
    expect(releasePointerCapture).toHaveBeenCalledWith(1)
    expect(capturedPointer).toBeNull()
    expect(frames).toHaveLength(0)
    expect(cancelFrame).toHaveBeenCalledOnce()
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')

    fireEvent(separator, pointerEvent('pointerdown', 10, 2))
    fireEvent(separator, pointerEvent('pointermove', 320, 2))
    expect(frames).toHaveLength(1)
    fireEvent(window, new Event('blur'))
    expect(releasePointerCapture).toHaveBeenCalledTimes(2)
    expect(releasePointerCapture).toHaveBeenLastCalledWith(2)
    expect(frames).toHaveLength(0)
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')

    // Final unmount cleans the second setup without re-running the stale first
    // cleanup or removing the current listener with the wrong callback.
    fireEvent(separator, pointerEvent('pointerdown', 10, 3))
    fireEvent(separator, pointerEvent('pointermove', 340, 3))
    expect(frames).toHaveLength(1)
    unmount()
    const allBlurRemovals = removeWindowListener.mock.calls.filter(([type]) => type === 'blur')
    expect(allBlurRemovals).toEqual([
      ['blur', blurAdds[0][1]],
      ['blur', blurAdds[1][1]],
    ])
    expect(ResizeObserverMock.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(ResizeObserverMock.instances[1].disconnect).toHaveBeenCalledOnce()
    expect(releasePointerCapture).toHaveBeenCalledTimes(3)
    expect(releasePointerCapture).toHaveBeenLastCalledWith(3)
    expect(capturedPointer).toBeNull()
    expect(frames).toHaveLength(0)
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  it.each([
    ['pointercancel', (separator: HTMLElement) => fireEvent(separator, pointerEvent('pointercancel', 400))],
    ['lostpointercapture', (separator: HTMLElement) => fireEvent(separator, pointerEvent('lostpointercapture', 400))],
    ['window blur', () => fireEvent(window, new Event('blur'))],
  ])('accepts the painted ratio on %s and preserves it through later renders', (_name, terminate) => {
    const { rerender } = renderLayout()
    const host = screen.getByTestId('research-layout')
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 400))
    flushAnimationFrames()
    expect(separator).toHaveAttribute('aria-valuenow', '51')
    expect(host.style.getPropertyValue('--research-primary-size')).toBe('400px')

    terminate(separator)
    expect(document.body.style.userSelect).toBe('')
    expect(separator).toHaveAttribute('aria-valuenow', '51')
    expect(host.style.getPropertyValue('--research-primary-size')).toBe('400px')

    // An ordinary prop render and maximize/restore both reconcile from React
    // state. They must retain the ratio accepted by cancellation.
    rerender(layout({ primaryLabel: 'renamed primary' }))
    expect(separator).toHaveAttribute('aria-valuenow', '51')
    fireEvent.click(screen.getByRole('button', { name: 'expand workspace' }))
    fireEvent.click(screen.getByRole('button', { name: 'restore layout' }))
    expect(separator).toHaveAttribute('aria-valuenow', '51')
    expect(host.style.getPropertyValue('--research-primary-size')).toBe('400px')

    rerender(layout({
      layoutId: 'source',
      axis: 'horizontal',
      defaultRatio: 70,
      minPrimary: 600,
      minSecondary: 200,
    }))
    rerender(layout())
    expect(screen.getByRole('separator', { name: 'resize panels' })).toHaveAttribute('aria-valuenow', '51')
    expect(host.style.getPropertyValue('--research-primary-size')).toBe('400px')
  })

  it('ignores non-active pointers throughout an active drag', () => {
    renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    let capturedPointer: number | null = null
    const setPointerCapture = vi.fn((pointerId: number) => { capturedPointer = pointerId })
    const hasPointerCapture = vi.fn((pointerId: number) => capturedPointer === pointerId)
    const releasePointerCapture = vi.fn(() => { capturedPointer = null })
    Object.defineProperties(separator, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: hasPointerCapture },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })
    document.body.style.cursor = 'crosshair'
    document.body.style.userSelect = 'text'

    fireEvent(separator, pointerEvent('pointerdown', 10, 1))
    fireEvent(separator, pointerEvent('pointerdown', 700, 2))
    expect(setPointerCapture).toHaveBeenCalledTimes(1)
    expect(setPointerCapture).toHaveBeenCalledWith(1)
    expect(capturedPointer).toBe(1)
    expect(document.body.style.cursor).toBe('row-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent(separator, pointerEvent('pointermove', 700, 2))
    fireEvent(separator, pointerEvent('pointerup', 700, 2))
    fireEvent(separator, pointerEvent('pointercancel', 700, 2))
    fireEvent(separator, pointerEvent('lostpointercapture', 700, 2))
    expect(frames).toHaveLength(0)
    expect(releasePointerCapture).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('none')

    fireEvent(separator, pointerEvent('pointermove', 300, 1))
    expect(frames).toHaveLength(1)
    fireEvent(separator, pointerEvent('pointercancel', 300, 1))
    expect(separator).toHaveAttribute('aria-valuenow', '40')
    expect(releasePointerCapture).toHaveBeenCalledOnce()
    expect(releasePointerCapture).toHaveBeenCalledWith(1)
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')
  })

  it('does not rerender panel children for continuous pointer moves', () => {
    let childRenders = 0
    function StreamingChild() {
      childRenders += 1
      return <div>streaming child</div>
    }
    renderLayout({ children: [<StreamingChild key="one" />, <StreamingChild key="two" />] })
    childRenders = 0
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 250))
    fireEvent(separator, pointerEvent('pointermove', 300))
    flushAnimationFrames()
    expect(childRenders).toBe(0)
  })

  it('renders compact alternatives as mutually exclusive hidden panels', () => {
    const { rerender } = renderLayout()
    rerender(layout({
      compact: true,
      children: [<div key="one">first</div>, <div key="two">second</div>],
    }))
    expect(screen.getByLabelText('primary')).toHaveAttribute('hidden')
    expect(screen.getByLabelText('secondary')).not.toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('tab', { name: 'artifacts' }))
    expect(screen.getByLabelText('secondary')).toHaveAttribute('hidden')
  })
})
