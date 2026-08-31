import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CoverageScopeSelector } from './CoverageScopeSelector'

// COV-09：合成范围选择器（§12.3）——显式二选一、Notes 禁用 + 可访问
// 文字说明（不只依赖颜色）、0/超限 Source 预检文案、onChange 契约。

describe('CoverageScopeSelector', () => {
  afterEach(cleanup)

  function renderSelector(overrides: Partial<{
    value: 'relevant' | 'all_selected'
    selectedSourceCount: number
    selectedNoteCount: number
  }> = {}) {
    const onChange = vi.fn()
    render(
      <CoverageScopeSelector
        value={overrides.value ?? 'relevant'}
        onChange={onChange}
        selectedSourceCount={overrides.selectedSourceCount ?? 0}
        selectedNoteCount={overrides.selectedNoteCount ?? 0}
      />,
    )
    return { onChange }
  }

  it('默认相关证据回答；点击可切到 all_selected', () => {
    const { onChange } = renderSelector()
    const radio = screen.getByTestId('scope-all-selected-option') as HTMLInputElement
    expect(screen.getByTestId('scope-all-selected-option')).toBeInTheDocument()
    fireEvent.click(radio)
    expect(onChange).toHaveBeenCalledWith('all_selected')
  })

  it('选择 Notes：all_selected 禁用 + 可访问文字说明', () => {
    renderSelector({ selectedNoteCount: 1 })
    expect(screen.getByTestId('scope-all-selected-option')).toBeDisabled()
    const notice = screen.getByTestId('coverage-scope-notice')
    expect(notice).toHaveTextContent('research.coverage.notesNotSupported')
    expect(notice).toHaveAttribute('id', 'coverage-scope-notice')
  })

  it('0 Source：提示选择来源（不阻止切换，由提交侧拦截）', () => {
    renderSelector()
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.noSourcesHint')
    expect(screen.getByTestId('scope-all-selected-option')).not.toBeDisabled()
  })

  it('51+ Source：前端预检错误文案', () => {
    renderSelector({ selectedSourceCount: 51 })
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.tooManySources')
  })

  it('正常选择（有 Source 无 Notes）：无提示', () => {
    renderSelector({ selectedSourceCount: 3 })
    expect(screen.queryByTestId('coverage-scope-notice')).not.toBeInTheDocument()
  })
})
