import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CoverageScopeSelector } from './CoverageScopeSelector'

// COV-09：合成范围选择器（§12.3）——显式二选一、Notes 禁用 + 可访问
// 文字说明（不只依赖颜色）、0/超限 Source 预检文案、onChange 契约。
// RWV2-11（K3/W4）：entire_project 模式显示专属说明（优先级高于通用
// noSourcesHint）；提交闸门在 ChatPanel，本组件只出通知。
// #358：后端能力关闭时禁用 all_selected 并展示能力说明（fail-closed）。

describe('CoverageScopeSelector', () => {
  afterEach(cleanup)

  function renderSelector(overrides: Partial<{
    value: 'relevant' | 'all_selected'
    scopeMode: 'entire_project' | 'selected'
    capabilityEnabled: boolean
    selectedSourceCount: number
    selectedNoteCount: number
  }> = {}) {
    const onChange = vi.fn()
    render(
      <CoverageScopeSelector
        value={overrides.value ?? 'relevant'}
        onChange={onChange}
        scopeMode={overrides.scopeMode ?? 'selected'}
        capabilityEnabled={overrides.capabilityEnabled}
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

  it('#358：能力关闭 → all_selected 禁用 + 能力说明（优先于其他提示）', () => {
    renderSelector({ capabilityEnabled: false, selectedSourceCount: 3 })
    expect(screen.getByTestId('scope-all-selected-option')).toBeDisabled()
    const notice = screen.getByTestId('coverage-scope-notice')
    expect(notice).toHaveTextContent('research.coverage.capabilityDisabled')
    expect(notice).toHaveAttribute('id', 'coverage-scope-notice')
    // 即使有 Notes/超限等其他条件，能力说明优先
    cleanup()
    renderSelector({ capabilityEnabled: false, selectedNoteCount: 1, selectedSourceCount: 60 })
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.capabilityDisabled')
  })

  it('选择 Notes：all_selected 禁用 + 可访问文字说明', () => {
    renderSelector({ selectedNoteCount: 1 })
    expect(screen.getByTestId('scope-all-selected-option')).toBeDisabled()
    const notice = screen.getByTestId('coverage-scope-notice')
    expect(notice).toHaveTextContent('research.coverage.notesNotSupported')
    expect(notice).toHaveAttribute('id', 'coverage-scope-notice')
  })

  it('RWV2-11（W4）：entire_project 模式显示专属说明，优先级高于 noSourcesHint', () => {
    renderSelector({ scopeMode: 'entire_project' })
    const notice = screen.getByTestId('coverage-scope-notice')
    expect(notice).toHaveTextContent('research.coverage.entireProjectNotice')
    expect(notice).not.toHaveTextContent('research.coverage.noSourcesHint')
    expect(screen.getByTestId('scope-all-selected-option')).not.toBeDisabled()
  })

  it('0 Source（selected 模式）：提示选择来源（不阻止切换，由提交侧拦截）', () => {
    renderSelector()
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.noSourcesHint')
    expect(screen.getByTestId('scope-all-selected-option')).not.toBeDisabled()
  })

  it('51+ Source：前端预检错误文案', () => {
    renderSelector({ selectedSourceCount: 51 })
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.tooManySources')
  })

  it('正常选择（有 Source 无 Notes，selected 模式）：无提示', () => {
    renderSelector({ selectedSourceCount: 3 })
    expect(screen.queryByTestId('coverage-scope-notice')).not.toBeInTheDocument()
  })
})