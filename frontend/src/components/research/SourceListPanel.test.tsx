import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SourceListPanel } from './SourceListPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import type { ResearchSource } from '@/lib/types/research'

// UI-02 Red：Sources 状态面板（REQ-SRC-04/05，契约 §6）——pending/ready/
// stale/failed 全部可见；failed 附 last_error；retry 可见性（Owner 无重试
// 入口，仅提示管理员可重试）；stale 提示内容更新中。
// RWV2-13（Issue #34）：行首复选框承担 Scope 选择（唯一编辑面）；选中写
// 入根级 ResearchScopeProvider；预览（Open）与选择互不干扰。

vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  listSources: vi.fn(),
  getSource: vi.fn(),
  listNotes: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.error ?? opts.page ?? opts.name ?? '')}` : key,
  }),
}))

const source = (overrides: Partial<ResearchSource> = {}): ResearchSource => ({
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: 'h',
  synced_at: '2026-08-06T02:00:00Z',
  last_error: null,
  ...overrides,
})

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner">
        <ResearchScopeProvider userId="u1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

function ScopeProbe() {
  const { mode, selectedSourceIds } = useResearchScope()
  return (
    <div>
      <span data-testid="probe-mode">{mode}</span>
      <span data-testid="probe-selected">{selectedSourceIds.join(',')}</span>
    </div>
  )
}

describe('SourceListPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('渲染全部四种状态（pending/ready/stale/failed）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [
        source({ source_id: 's1', status: 'pending' }),
        source({ source_id: 's2', status: 'ready' }),
        source({ source_id: 's3', status: 'stale' }),
        source({ source_id: 's4', status: 'failed', last_error: 'boom' }),
      ],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('research.sources.statusPending')).toBeInTheDocument()
      expect(screen.getByText('research.sources.statusReady')).toBeInTheDocument()
      expect(screen.getByText('research.sources.statusStale')).toBeInTheDocument()
      expect(screen.getByText('research.sources.statusFailed')).toBeInTheDocument()
    })
    // failed 附可审计错误（不含正文的 last_error）
    expect(screen.getByText(/research.sources.lastError:boom/)).toBeInTheDocument()
  })

  it('ready/stale 可选择，pending/failed 不可选择，stale 显示英文风险提示', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [
        source({ source_id: 'pending', status: 'pending' }),
        source({ source_id: 'ready', status: 'ready' }),
        source({ source_id: 'stale', status: 'stale' }),
        source({ source_id: 'failed', status: 'failed' }),
      ],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })

    expect(await screen.findByTestId('source-scope-pending')).toBeDisabled()
    expect(screen.getByTestId('source-scope-failed')).toBeDisabled()
    expect(screen.getByTestId('source-scope-ready')).not.toBeDisabled()
    expect(screen.getByTestId('source-scope-stale')).not.toBeDisabled()
    expect(screen.getByText('research.sources.staleSelectionWarning')).toBeInTheDocument()
  })

  it('failed 状态展示管理员可重试提示（retry-visible；Owner 无重试按钮）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source({ status: 'failed', last_error: 'x' })],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('research.sources.retryHint')).toBeInTheDocument()
    })
    // Owner 无 retry-sync 入口（契约 §6：仅 Admin 端点）
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('空态展示（无来源）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('research.sources.empty')).toBeInTheDocument())
  })

  it('紧凑单行列表：每来源一个 listitem（选择复选框 + 状态徽标 + 标题 + 打开按钮）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [
        source({ source_id: 's1', document_id: 'doc_a', status: 'ready' }),
        source({ source_id: 's2', document_id: 'doc_b', status: 'failed', last_error: 'e' }),
      ],
      next_cursor: null,
    })
    const onOpenSource = vi.fn()
    const { wrapper } = makeWrapper()
    render(<SourceListPanel onOpenSource={onOpenSource} />, { wrapper })
    const rows = await screen.findByTestId('source-list-rows')
    expect(rows).toBeInTheDocument()
    const items = within(rows).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // 状态徽标在行首，标题截断展示，每行一个打开按钮
    expect(within(items[0]).getByText('research.sources.statusReady')).toBeInTheDocument()
    expect(within(items[0]).getByText('doc_a')).toBeInTheDocument()
    expect(within(items[0]).getByRole('checkbox')).toBeInTheDocument()
    expect(within(items[1]).getByText(/research.sources.lastError:e/)).toBeInTheDocument()
    fireEvent.click(within(items[1]).getByRole('button', { name: /research.sources.open/ }))
    expect(onOpenSource).toHaveBeenCalledWith('s2')
  })

  it('点击来源行回调 onOpenSource(sourceId)，与选择复选框互不干扰', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source()],
      next_cursor: null,
    })
    const onOpenSource = vi.fn()
    const { wrapper } = makeWrapper()
    render(
      <>
        <SourceListPanel onOpenSource={onOpenSource} />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /research.sources.open/ }))
    })
    expect(onOpenSource).toHaveBeenCalledWith('src_1')
    // 打开预览不改变选择状态（选择仍空）
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('')
  })

  it('行首复选框进入/退出选中：写入 provider 并切换到 selected 模式（左栏编辑）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source(), source({ source_id: 's2', document_id: 'doc_2' })],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(
      <>
        <SourceListPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    fireEvent.click(checkboxes[0])
    expect(screen.getByTestId('probe-mode')).toHaveTextContent('selected')
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('src_1')
    expect(screen.getByTestId('source-scope-src_1')).toHaveAttribute('data-state', 'checked')
    // 再点取消（多选时移除一项）→ 选择更新为剩余项
    fireEvent.click(screen.getByTestId('source-scope-s2'))
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('s2')
    fireEvent.click(screen.getByTestId('source-scope-s2'))
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('src_1')
  })

  it('21 项分两批浏览，跨页选择保持且计数准确', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) =>
      source({ source_id: `s${index + 1}`, document_id: `doc_${index + 1}` }),
    )
    vi.mocked(researchApi.listSources).mockImplementation(async (_projectId, params = {}) => {
      if (params.cursor === 'cursor_20') {
        return {
          items: [source({ source_id: 's21', document_id: 'doc_21' })],
          next_cursor: null,
        }
      }
      return { items: firstPage, next_cursor: 'cursor_20' }
    })
    const { wrapper } = makeWrapper()
    render(
      <>
        <SourceListPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )

    const rows = await screen.findByTestId('source-list-rows')
    expect(within(rows).getAllByRole('listitem')).toHaveLength(20)
    fireEvent.click(screen.getByTestId('source-scope-s1'))
    fireEvent.click(screen.getByRole('button', { name: 'research.pagination.loadMore' }))
    expect(within(rows).getAllByRole('listitem')).toHaveLength(21)
    fireEvent.click(screen.getByTestId('source-scope-s21'))
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('s1,s21')
    expect(researchApi.listSources).toHaveBeenCalledWith('proj_1', {
      cursor: 'cursor_20',
      limit: 100,
    }, expect.any(AbortSignal))
  })

  it('恰好 20 项全部可见且不显示 Load more', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: Array.from({ length: 20 }, (_, index) =>
        source({ source_id: `exact-${index + 1}`, document_id: `doc-${index + 1}` }),
      ),
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })

    const rows = await screen.findByTestId('source-list-rows')
    await waitFor(() => expect(within(rows).getAllByRole('listitem')).toHaveLength(20))
    expect(screen.queryByRole('button', { name: 'research.pagination.loadMore' })).toBeNull()
  })

  it('selected 模式最后一项不可取消（复选框禁用，仍保持 ≥1 有效选择）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source()],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    // 预置 provider：selected 且选中 src_1
    localStorage.setItem(
      'rdlens.research.scope.v1/u1/proj_1',
      JSON.stringify({ version: 1, mode: 'selected', sourceIds: ['src_1'], noteIds: [] }),
    )
    render(
      <>
        <SourceListPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    const checkbox = await screen.findByTestId('source-scope-src_1')
    expect(checkbox).toBeDisabled()
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('src_1')
  })

  it('每行复选框带可访问名称（aria-label 含文档名，屏幕阅读器语义）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source({ document_id: 'doc_a' })],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    const checkbox = await screen.findByTestId('source-scope-src_1')
    expect(checkbox).toHaveAttribute('aria-label', 'research.sources.scopeSelect:doc_a')
    expect(checkbox).toHaveAttribute('role', 'checkbox')
  })

  it('加载失败展示错误状态与重试，绝不伪装为空数据', async () => {
    vi.mocked(researchApi.listSources)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    expect(await screen.findByText('research.workbench.loadFailed')).toBeInTheDocument()
    expect(screen.queryByText('research.sources.empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'research.retry' }))
    await waitFor(() => expect(screen.getByText('research.sources.empty')).toBeInTheDocument())
  })
})

// RWV2-43（fork #47）：Source 行 meta 可读化 + Open 动作可发现性（F13/C-M4/R2-1）
describe('SourceListPanel（RWV2-43 meta 可读化）', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('synced_at 非 null → meta 显示版本 + Synced 标签 + 格式化时间，无裸 ISO', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source({ document_version: 'v3', synced_at: '2026-08-06T02:00:00Z' })],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    const rows = await screen.findByTestId('source-list-rows')
    const row = within(rows).getAllByRole('listitem')[0]
    expect(row.textContent).toContain('v3')
    expect(row.textContent).toContain('research.sources.synced')
    // 可见文本不再出现原始 ISO（R2-6：只看文本，不看 <time dateTime> 属性）
    expect(row.textContent).not.toMatch(/T\d{2}:\d{2}/)
  })

  it('pending/failed（synced_at null）→ meta 不含 Synced 段（R2-1 回归红线）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [
        source({ source_id: 'p1', status: 'pending', synced_at: null }),
        source({ source_id: 'f1', status: 'failed', synced_at: null, last_error: 'e' }),
      ],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    const rows = await screen.findByTestId('source-list-rows')
    const items = within(rows).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.textContent).not.toContain('research.sources.synced')
    }
  })

  it('Open 动作：图标按钮 a11y 可达（role button + aria-label），与选择分离', async () => {
    const onOpenSource = vi.fn()
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source()],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(
      <>
        <SourceListPanel onOpenSource={onOpenSource} />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    const openButton = await screen.findByRole('button', { name: /research.sources.open/ })
    expect(openButton).toBeInTheDocument()
    fireEvent.click(openButton)
    expect(onOpenSource).toHaveBeenCalledWith('src_1')
    // 打开预览不改变选择状态（动作与 Scope 选择物理分离）
    expect(screen.getByTestId('probe-selected')).toHaveTextContent('')
  })
})
