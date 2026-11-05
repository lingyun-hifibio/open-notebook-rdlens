import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope } from '@/lib/research/scope'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { ResearchScopeEditor } from './ResearchScopeEditor'
import type { ResearchSource } from '@/lib/types/research'

// Issue #1011 F09：会话 Scope 面承载「限定当前对话到单一来源」区块（§2.7）。
// `useResearchSources` 用受控替身（下拉数据只来自 ready/stale 且有 source_id 行）。
vi.mock('@/lib/hooks/use-research', () => ({
  useResearchSources: vi.fn(),
}))

// RWV2-13（Issue #34）：左栏唯一 Scope 编辑面的模式控件——all
// 显式可见（D2）；selected 需 ≥1 项选择（D3）；切换回 all 立即
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

function seedScope(mode: 'all' | 'selected', sourceIds: string[] = []) {
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
    expect(persisted.mode).toBe('all')
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

// ---------------------------------------------------------------------------
// Issue #1011 F09（计划 §2.7）：Source focus 与会话单篇限定分开——
// 「限定当前对话到单一来源」只发生在会话 Scope 编辑面：
//   scope-single-limit（区块）/ scope-single-limit-select（下拉）/
//   scope-single-limit-apply（应用）；生效后沿用既有 scope-single-pin +
//   scope-single-clear（取消）。数据只来自 ready/stale 且 source_id !== null。
// ---------------------------------------------------------------------------

const sourceRow = (
  overrides: Partial<ResearchSource> & { source_id: string | null },
): ResearchSource => ({
  document_id: 'doc_1',
  document_version: 'v1',
  status: 'ready',
  content_hash: null,
  synced_at: null,
  last_error: null,
  ...overrides,
})

const READY_SOURCES: ResearchSource[] = [
  sourceRow({ source_id: 'src_ready', document_id: 'doc_ready', status: 'ready' }),
  sourceRow({ source_id: 'src_stale', document_id: 'doc_stale', status: 'stale' }),
  sourceRow({ source_id: 'src_pending', document_id: 'doc_pending', status: 'pending' }),
  sourceRow({ source_id: 'src_failed', document_id: 'doc_failed', status: 'failed' }),
  sourceRow({ source_id: 'src_retiring', document_id: 'doc_retiring', status: 'retiring' }),
  sourceRow({ source_id: 'src_deleted', document_id: 'doc_deleted', status: 'deleted' }),
  sourceRow({ source_id: null, document_id: 'doc_no_identity', status: 'ready' }),
]

function mockSources(items: ResearchSource[]) {
  vi.mocked(useResearchSources).mockReturnValue({
    data: { items, next_cursor: null },
    isLoading: false,
    isError: false,
  } as never)
}

function workspaceWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId={PROJECT} role="owner">
        <ResearchScopeProvider userId={USER} projectId={PROJECT}>
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

function SinglePinProbe() {
  const { singlePin } = useResearchScope()
  return <span data-testid="probe-single-pin">{singlePin?.sourceId ?? 'none'}</span>
}

function renderLimitEditor() {
  return render(
    <>
      <ResearchScopeEditor />
      <SinglePinProbe />
    </>,
    { wrapper: workspaceWrapper },
  )
}

describe('ResearchScopeEditor · Issue #1011 F09 会话单篇限定区块（§2.7）', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockSources(READY_SOURCES)
  })

  it('渲染「限定当前对话到单一来源」区块：标题/影响范围说明/来源下拉/应用按钮', () => {
    renderLimitEditor()
    expect(screen.getByTestId('scope-single-limit')).toBeInTheDocument()
    expect(screen.getByTestId('scope-single-limit')).toHaveTextContent(
      'research.layout.scope.singleLimitTitle',
    )
    expect(screen.getByTestId('scope-single-limit')).toHaveTextContent(
      'research.layout.scope.singleLimitHint',
    )
    expect(screen.getByTestId('scope-single-limit-select').tagName).toBe('SELECT')
    expect(screen.getByTestId('scope-single-limit-apply').tagName).toBe('BUTTON')
    // 复用既有 pin/clear（不新增同义控件）
    expect(screen.queryByTestId('scope-single-pin')).toBeNull()
  })

  it('下拉只列 ready/stale 且 source_id !== null 的来源', () => {
    renderLimitEditor()
    const select = screen.getByTestId('scope-single-limit-select') as HTMLSelectElement
    const values = Array.from(select.options).map((option) => option.value)
    expect(values).toContain('src_ready')
    expect(values).toContain('src_stale')
    for (const excluded of ['src_pending', 'src_failed', 'src_retiring', 'src_deleted', '']) {
      // 空串是占位项（「选择一个来源」），不是候选来源
      if (excluded === '') continue
      expect(values).not.toContain(excluded)
    }
    // 无镜像身份行不可选
    expect(values.filter((value) => value === '')).toHaveLength(1)
    expect(values).toHaveLength(3)
  })

  it('选择来源 + 应用限定 → setSingle 生效：显示既有 pin 与「取消限定」', () => {
    renderLimitEditor()
    fireEvent.change(screen.getByTestId('scope-single-limit-select'), {
      target: { value: 'src_stale' },
    })
    fireEvent.click(screen.getByTestId('scope-single-limit-apply'))
    expect(screen.getByTestId('probe-single-pin')).toHaveTextContent('src_stale')
    expect(screen.getByTestId('scope-single-pin')).toBeInTheDocument()
    expect(screen.getByTestId('scope-single-clear')).toHaveTextContent(
      'research.layout.scope.singleClear',
    )
    // 未选择时应用按钮禁用（避免空来源限定）
    expect(screen.queryByTestId('scope-single-limit-empty')).toBeNull()
  })

  it('取消限定（既有 clear）→ pin 消失、恢复基础范围', () => {
    renderLimitEditor()
    fireEvent.change(screen.getByTestId('scope-single-limit-select'), {
      target: { value: 'src_ready' },
    })
    fireEvent.click(screen.getByTestId('scope-single-limit-apply'))
    expect(screen.getByTestId('scope-single-pin')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('scope-single-clear'))
    expect(screen.queryByTestId('scope-single-pin')).toBeNull()
    expect(screen.getByTestId('probe-single-pin')).toHaveTextContent('none')
  })

  it('键盘可达：原生 select + 可 Tab 的按钮；未选来源时应用按钮禁用', () => {
    renderLimitEditor()
    const select = screen.getByTestId('scope-single-limit-select')
    const apply = screen.getByTestId('scope-single-limit-apply')
    expect(select).toHaveAccessibleName('research.layout.scope.singleLimitSourceLabel')
    expect(apply).toBeDisabled()
    expect(select.getAttribute('aria-disabled')).toBeNull()
    act(() => {
      fireEvent.change(select, { target: { value: 'src_ready' } })
    })
    expect(apply).not.toBeDisabled()
  })

  it('没有 ready/stale 来源 → 空态说明，不渲染下拉/应用（不提供无效限定）', () => {
    mockSources([sourceRow({ source_id: 'src_pending', status: 'pending' })])
    renderLimitEditor()
    expect(screen.getByTestId('scope-single-limit-empty')).toHaveTextContent(
      'research.layout.scope.singleLimitEmpty',
    )
    expect(screen.queryByTestId('scope-single-limit-select')).toBeNull()
    expect(screen.queryByTestId('scope-single-limit-apply')).toBeNull()
  })

  it('已生效限定时下拉回显当前来源（pin 与控件单一真源）', async () => {
    const { rerender } = renderLimitEditor()
    fireEvent.change(screen.getByTestId('scope-single-limit-select'), {
      target: { value: 'src_ready' },
    })
    fireEvent.click(screen.getByTestId('scope-single-limit-apply'))
    await waitFor(() => {
      expect(
        (screen.getByTestId('scope-single-limit-select') as HTMLSelectElement).value,
      ).toBe('src_ready')
    })
    rerender(
      <>
        <ResearchScopeEditor />
        <SinglePinProbe />
      </>,
    )
    expect(screen.getByTestId('probe-single-pin')).toHaveTextContent('src_ready')
  })

  it('候选来源含 source_id 为空的镜像行时不崩溃（不可选）', () => {
    mockSources([
      sourceRow({ source_id: null, document_id: 'doc_x', status: 'ready' }),
      sourceRow({ source_id: 'src_ready', status: 'ready' }),
    ])
    renderLimitEditor()
    const select = screen.getByTestId('scope-single-limit-select') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '',
      'src_ready',
    ])
  })
})
