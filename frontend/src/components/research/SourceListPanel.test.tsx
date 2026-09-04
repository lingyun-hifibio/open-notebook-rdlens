import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SourceListPanel } from './SourceListPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import * as researchApi from '@/lib/research/api'
import type { ResearchSource } from '@/lib/types/research'

// UI-02 Red：Sources 状态面板（REQ-SRC-04/05，契约 §6）——pending/ready/
// stale/failed 全部可见；failed 附 last_error；retry 可见性（Owner 无重试
// 入口，仅提示管理员可重试）；stale 提示内容更新中。

vi.mock('@/lib/research/api', () => ({
  listSources: vi.fn(),
  getSource: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.error ?? opts.page ?? '')}` : key,
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
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('SourceListPanel', () => {
  beforeEach(() => {
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

  it('紧凑单行列表：每来源一个 listitem（状态徽标 + 标题 + 打开按钮）', async () => {
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
    expect(within(items[1]).getByText(/research.sources.lastError:e/)).toBeInTheDocument()
    fireEvent.click(within(items[1]).getByRole('button', { name: /research.sources.open/ }))
    expect(onOpenSource).toHaveBeenCalledWith('s2')
  })

  it('点击来源行回调 onOpenSource(sourceId)', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source()],
      next_cursor: null,
    })
    const onOpenSource = vi.fn()
    const { wrapper } = makeWrapper()
    render(<SourceListPanel onOpenSource={onOpenSource} />, { wrapper })
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /research.sources.open/ }))
    })
    expect(onOpenSource).toHaveBeenCalledWith('src_1')
  })

  it('紧凑单行列表：每来源一个 listitem，badge 与标题同行', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source(), source({ source_id: 's2', document_id: 'doc_2' })],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    const rows = await screen.findByTestId('source-list-rows')
    expect(rows).toBeInTheDocument()
    const items = within(rows).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // 每行内 badge 与 open 按钮同处一个 listitem（单行密度契约）
    expect(within(items[0]).getByText('research.sources.statusReady')).toBeInTheDocument()
    expect(within(items[0]).getByText('doc_1')).toBeInTheDocument()
    expect(within(items[0]).getByRole('button', { name: /research.sources.open/ })).toBeInTheDocument()
  })

  it('加载失败展示错误状态（不静默）', async () => {
    vi.mocked(researchApi.listSources).mockRejectedValue(new Error('network'))
    const { wrapper } = makeWrapper()
    render(<SourceListPanel />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('research.workbench.loadFailed')).toBeInTheDocument()
    })
  })
})
