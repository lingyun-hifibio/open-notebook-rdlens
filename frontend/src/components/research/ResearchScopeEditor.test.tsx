import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope } from '@/lib/research/scope'
import { ResearchScopeEditor } from './ResearchScopeEditor'

// RWV2-13（Issue #34）：左栏唯一 Scope 编辑面的模式控件——entire_project
// 显式可见（D2）；selected 需 ≥1 项选择（D3）；切换回 entire_project 立即
// 反映到 provider（D5 持久化）。

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const USER = 'u1'
const PROJECT = 'proj_1'

function editorWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ResearchScopeProvider userId={USER} projectId={PROJECT}>
      {children}
    </ResearchScopeProvider>
  )
}

function seedScope(mode: 'entire_project' | 'selected', sourceIds: string[] = []) {
  localStorage.setItem(
    scopeStorageKey(USER, PROJECT),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds: [] }),
  )
}

function ScopeProbe() {
  const { mode, selectedSourceIds, toggleSource } = useResearchScope()
  return (
    <div>
      <span data-testid="probe-mode">{mode}</span>
      <span data-testid="probe-selected">{selectedSourceIds.join(',')}</span>
      <button type="button" onClick={() => toggleSource('src_1')}>toggle-src_1</button>
    </div>
  )
}

describe('ResearchScopeEditor', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('渲染模式单选：首次显式 Entire project 选中，selected 无选项时禁用', () => {
    render(
      <>
        <ResearchScopeEditor />
        <ScopeProbe />
      </>,
      { wrapper: editorWrapper },
    )
    expect(screen.getByTestId('research-scope-editor')).toBeInTheDocument()
    expect(screen.getByTestId('scope-entire-project')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('scope-selected')).toBeDisabled()
  })

  it('selected 单选在 ≥1 项选择后可进入（经左栏复选框写入 provider）', () => {
    seedScope('selected', ['src_1'])
    render(
      <>
        <ResearchScopeEditor />
        <ScopeProbe />
      </>,
      { wrapper: editorWrapper },
    )
    expect(screen.getByTestId('scope-selected')).not.toBeDisabled()
    expect(screen.getByTestId('scope-selected')).toHaveAttribute('data-state', 'checked')
  })

  it('切换回 Entire project 立即清空选择并持久化（provider 单一真源）', () => {
    seedScope('selected', ['src_1'])
    render(
      <>
        <ResearchScopeEditor />
        <ScopeProbe />
      </>,
      { wrapper: editorWrapper },
    )
    fireEvent.click(screen.getByTestId('scope-entire-project'))
    expect(screen.getByTestId('scope-entire-project')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('')
    const persisted = JSON.parse(localStorage.getItem(scopeStorageKey(USER, PROJECT)) ?? '{}')
    expect(persisted.mode).toBe('entire_project')
    expect(persisted.sourceIds).toEqual([])
  })

  it('选择进入后点击 selected 单选保持 selected 模式', () => {
    seedScope('selected', ['src_1'])
    render(
      <>
        <ResearchScopeEditor />
        <ScopeProbe />
      </>,
      { wrapper: editorWrapper },
    )
    fireEvent.click(screen.getByTestId('scope-selected'))
    expect(screen.getByTestId('probe-mode')).toHaveTextContent('selected')
  })

  it('0 项选择时展示英文空范围引导（D3：0 选择不隐式扩大数据范围）', () => {
    render(<ResearchScopeEditor />, { wrapper: editorWrapper })
    expect(screen.getByTestId('scope-selection-required')).toHaveTextContent(
      'research.layout.scope.selectItemRequired',
    )
  })

  it('窄栏不横向溢出：单选组 flex-wrap 且容器 min-w-0（1024-1920 桌面最小栏宽）', () => {
    const { container } = render(<ResearchScopeEditor />, { wrapper: editorWrapper })
    const radioGroup = container.querySelector('[data-slot="radio-group"]') ?? container.querySelector('[role="radiogroup"]')
    expect(radioGroup).not.toBeNull()
    expect(radioGroup).toHaveClass('flex-wrap')
    expect(screen.getByTestId('research-scope-editor')).toHaveClass('min-w-0')
  })
})