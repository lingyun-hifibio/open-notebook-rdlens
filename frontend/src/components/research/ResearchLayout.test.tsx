import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    fireEvent(separator, new Event('lostpointercapture', { bubbles: true }))
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
    expect(frames).toHaveLength(0)
    expect(releasePointerCapture).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('none')

    fireEvent(separator, pointerEvent('pointermove', 300, 1))
    expect(frames).toHaveLength(1)
    fireEvent(separator, pointerEvent('pointerup', 300, 1))
    expect(separator).toHaveAttribute('aria-valuenow', '38')
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
