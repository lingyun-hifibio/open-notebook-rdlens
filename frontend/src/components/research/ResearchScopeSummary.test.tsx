import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope } from '@/lib/research/scope'
import { ResearchScopeSummary } from './ResearchScopeSummary'

// RWV2-13（Issue #34）：右栏只保留紧凑 Scope Summary + Edit scope，
// 不再渲染完整 Sources/Notes 选择器（唯一编辑面在左栏）。

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts === undefined) return key
      return `${key}:${String(opts.sources ?? '')}:${String(opts.notes ?? '')}`
    },
  }),
}))

const USER = 'u1'
const PROJECT = 'proj_1'

function summaryWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ResearchScopeProvider userId={USER} projectId={PROJECT}>
      {children}
    </ResearchScopeProvider>
  )
}

function seedScope(mode: 'entire_project' | 'selected', sourceIds: string[] = [], noteIds: string[] = []) {
  localStorage.setItem(
    scopeStorageKey(USER, PROJECT),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds }),
  )
}

/** 读取 provider 的探针：等价于左栏复选框对 provider 的写入路径。 */
function ScopeToggleProbe({ sourceId }: { sourceId: string }) {
  const { toggleSource } = useResearchScope()
  return <button type="button" onClick={() => toggleSource(sourceId)}>toggle-{sourceId}</button>
}

describe('ResearchScopeSummary', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('entire_project 模式显示显式范围标签（不隐式推导）', () => {
    seedScope('entire_project')
    render(<ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={vi.fn()} />, {
      wrapper: summaryWrapper,
    })
    expect(screen.getByTestId('research-scope-summary')).toBeInTheDocument()
    expect(screen.getByTestId('research-context-scope')).toHaveTextContent('research.layout.scope.entireProject')
  })

  it('selected 模式显示来源与笔记计数摘要', () => {
    seedScope('selected', ['src_1', 'src_2'], ['note_1'])
    render(<ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={vi.fn()} />, {
      wrapper: summaryWrapper,
    })
    expect(screen.getByTestId('research-context-scope')).toHaveTextContent(
      'research.layout.scope.selectedSummary:2:1',
    )
  })

  it('Edit scope 按钮触发 onEditScope 回调（右栏不持有第二套编辑状态）', () => {
    const onEditScope = vi.fn()
    render(<ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={onEditScope} />, {
      wrapper: summaryWrapper,
    })
    fireEvent.click(screen.getByTestId('scope-edit-button'))
    expect(onEditScope).toHaveBeenCalledTimes(1)
  })

  it('左栏选择写入 provider 后摘要计数即时更新（无第二套状态）', () => {
    seedScope('selected', ['src_1'])
    render(
      <>
        <ScopeToggleProbe sourceId="src_2" />
        <ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={vi.fn()} />
      </>,
      { wrapper: summaryWrapper },
    )
    expect(screen.getByTestId('research-context-scope')).toHaveTextContent(
      'research.layout.scope.selectedSummary:1:0',
    )
    fireEvent.click(screen.getByRole('button', { name: 'toggle-src_2' }))
    expect(screen.getByTestId('research-context-scope')).toHaveTextContent(
      'research.layout.scope.selectedSummary:2:0',
    )
  })

  it('summary 标签声明 aria-live（屏幕阅读器感知左栏选择变化）', () => {
    seedScope('entire_project')
    render(<ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={vi.fn()} />, {
      wrapper: summaryWrapper,
    })
    const label = screen.getByTestId('research-context-scope')
    expect(label).toHaveAttribute('role', 'status')
    expect(label).toHaveAttribute('aria-live', 'polite')
  })

  it('加载中/加载失败展示状态与重试入口', () => {
    const onRetry = vi.fn()
    const { rerender } = render(
      <ResearchScopeSummary loading loadError={null} onRetry={onRetry} onEditScope={vi.fn()} />,
      { wrapper: summaryWrapper },
    )
    expect(screen.getByText('research.loading')).toBeInTheDocument()

    rerender(
      <ResearchScopeSummary loading={false} loadError="boom" onRetry={onRetry} onEditScope={vi.fn()} />,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'research.retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('右栏摘要不包含任何完整选择器（无复选框/无模式单选）——唯一编辑面在左栏', () => {
    seedScope('selected', ['src_1'], ['note_1'])
    render(<ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={vi.fn()} />, {
      wrapper: summaryWrapper,
    })
    const summary = screen.getByTestId('research-scope-summary')
    expect(within(summary).queryByRole('checkbox')).toBeNull()
    expect(within(summary).queryByRole('radio')).toBeNull()
    expect(within(summary).queryByTestId('source-selection-list')).toBeNull()
    expect(within(summary).queryByTestId('note-selection-list')).toBeNull()
  })

  it('窄桌面分栏位置不隐藏标题/不横向溢出：summary flex-wrap + min-w-0', () => {
    seedScope('selected', ['src_1'], ['note_1'])
    render(<ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={vi.fn()} />, {
      wrapper: summaryWrapper,
    })
    const summary = screen.getByTestId('research-scope-summary')
    expect(summary).toHaveClass('flex-wrap', 'min-w-0')
    expect(screen.getByTestId('research-context-scope')).toHaveClass('min-w-0')
  })

  it('UIOPT-A：摘要不再自带底边框与外层 padding（Header 统一负责唯一视觉边界）', () => {
    seedScope('entire_project')
    render(<ResearchScopeSummary loading={false} loadError={null} onRetry={vi.fn()} onEditScope={vi.fn()} />, {
      wrapper: summaryWrapper,
    })
    const summary = screen.getByTestId('research-scope-summary')
    expect(summary).not.toHaveClass('border-b')
    expect(summary).not.toHaveClass('px-3')
    expect(summary).not.toHaveClass('py-2')
    // 评审 L3：长文本视觉截断 + title 保留完整语义
    const label = screen.getByTestId('research-context-scope')
    expect(label).toHaveClass('truncate')
    expect(label).toHaveAttribute('title', 'research.layout.scope.entireProject')
  })
})
