import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ResearchLayout } from './ResearchLayout'

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
}

function renderLayout() {
  return render(
    <ResearchLayout
      axis="vertical"
      compact={false}
      defaultRatio={40}
      minPrimary={200}
      minSecondary={300}
      primaryLabel="primary"
      secondaryLabel="secondary"
      separatorLabel="resize panels"
      expandSecondaryLabel="expand workspace"
      restoreLabel="restore layout"
      compactPrimaryLabel="artifacts"
      compactSecondaryLabel="workspace"
    >
      {[<button key="one">primary action</button>, <button key="two">secondary action</button>]}
    </ResearchLayout>,
  )
}

function pointerEvent(type: string, clientY: number) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY })
}

describe('ResearchLayout', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 900, height: 800, top: 0, left: 0, right: 900, bottom: 800, x: 0, y: 0, toJSON: () => ({}),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses a labelled keyboard-operable separator and commits the final pointer coordinate', () => {
    renderLayout()
    const separator = screen.getByRole('separator', { name: 'resize panels' })
    fireEvent(separator, pointerEvent('pointerdown', 10))
    fireEvent(separator, pointerEvent('pointermove', 320))
    fireEvent(separator, pointerEvent('pointerup', 390))
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    expect(separator).toHaveAttribute('aria-valuenow', '49')
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator).toHaveAttribute('aria-valuenow', '25')
    fireEvent.doubleClick(separator)
    expect(separator).toHaveAttribute('aria-valuenow', '40')
  })

  it('uses hidden for maximized content and returns focus to the restore control', () => {
    renderLayout()
    const primaryAction = screen.getByRole('button', { name: 'primary action' })
    primaryAction.focus()
    fireEvent.click(screen.getByRole('button', { name: 'expand workspace' }))
    expect(primaryAction.closest('section')).toHaveAttribute('hidden')
    expect(document.activeElement).toHaveTextContent('restore layout')
  })

  it('renders compact alternatives as mutually exclusive hidden panels', () => {
    const { rerender } = renderLayout()
    rerender(
      <ResearchLayout axis="vertical" compact defaultRatio={40} minPrimary={200} minSecondary={300} primaryLabel="primary" secondaryLabel="secondary" separatorLabel="resize panels" expandSecondaryLabel="expand workspace" restoreLabel="restore layout" compactPrimaryLabel="artifacts" compactSecondaryLabel="workspace">
        {[<div key="one">first</div>, <div key="two">second</div>]}
      </ResearchLayout>,
    )
    expect(screen.getByLabelText('primary')).toHaveAttribute('hidden')
    expect(screen.getByLabelText('secondary')).not.toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('tab', { name: 'artifacts' }))
    expect(screen.getByLabelText('secondary')).toHaveAttribute('hidden')
  })
})
