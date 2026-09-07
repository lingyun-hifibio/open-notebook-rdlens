import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TransformationRunsPanel } from './TransformationRunsPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import {
  resetGlobalModelStub,
} from '@/test/global-model-stub'
import * as researchApi from '@/lib/research/api'
import type { TransformationResultRecord } from '@/lib/types/research'

// RWV2-21（Issue #42）Red：Transformation Result 历史面板。
// - 历史来自 RDLens 服务端，服务端游标分页（首屏 20 + Load more 第 2 页），
//   模板与 result 实例分离（runs tab 不渲染模板卡）。
// - 0 行空态、Loading、Error+Retry、刷新（queryClient.clear）后仍可达
//   （Medium-6：证明服务端往返而非缓存）。
// - 点行打开只读详情（TransformationRunDetail）。

vi.mock('@/lib/research/api', () => ({
  listSources: vi.fn(),
  getSource: vi.fn(),
  listNotes: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  listInsights: vi.fn(),
  createInsight: vi.fn(),
  listTransformations: vi.fn(),
  createTransformation: vi.fn(),
  runTransformation: vi.fn(),
  listTransformationResults: vi.fn(),
  getTransformationResult: vi.fn(),
  createExport: vi.fn(),
  downloadExport: vi.fn(),
}))

vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

const P = 'proj_1'

const record = (i: number): TransformationResultRecord => ({
  result_id: `tres_${String(i).padStart(2, '0')}`,
  project_id: P,
  title: `Run ${i}`,
  transformation_id: 'trans_1',
  template_config_ref: 'cfg',
  generation_id: 'gen_1',
  model_id: 'm-local',
  status: 'completed',
  response_language: null,
  source_ids: ['src_1'],
  note_ids: [],
  source_refs: ['src_1'],
  output: `output ${i}`,
  citations: [],
  created_at: `2026-09-07T00:00:${String(i).padStart(2, '0')}Z`,
  updated_at: null,
})

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId={P} role={role}>
        <ResearchScopeProvider userId="u1" projectId={P}>
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('TransformationRunsPanel（RWV2-21 history）', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
    toastMock.mockClear()
    resetGlobalModelStub()
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
  })

  it('空历史 → 显示英文空态，无模板卡', async () => {
    vi.mocked(researchApi.listTransformationResults).mockResolvedValue({
      items: [], next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<TransformationRunsPanel />, { wrapper })
    await screen.findByTestId('runs-empty')
    expect(screen.getByTestId('runs-empty').textContent).toContain('historyEmpty')
    expect(screen.queryByText('transformations.run')).toBeNull()
  })

  it('Loading → 空态之前显示 loading', async () => {
    let resolver!: (value: { items: TransformationResultRecord[]; next_cursor: string | null }) => void
    vi.mocked(researchApi.listTransformationResults).mockReturnValue(
      new Promise((res) => { resolver = res }),
    )
    const { wrapper } = makeWrapper()
    render(<TransformationRunsPanel />, { wrapper })
    expect(screen.getByText('common.loading')).toBeTruthy()
    resolver({ items: [], next_cursor: null })
    await screen.findByTestId('runs-empty')
  })

  it('服务端分页：首屏 20 + Load more 第 2 页（2 次调用带 cursor，21 行无重复）', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => record(i + 1))
    vi.mocked(researchApi.listTransformationResults)
      .mockResolvedValueOnce({ items: rows.slice(0, 20), next_cursor: 'cursor-21' })
      .mockResolvedValueOnce({ items: rows.slice(20), next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<TransformationRunsPanel />, { wrapper })
    // 首屏 20
    await waitFor(() => {
      expect(screen.getAllByTestId(/^runs-row-/)).toHaveLength(20)
    })
    expect(researchApi.listTransformationResults).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('runs-load-more')).not.toBeNull()
    // Load more → 第 2 次带 cursor
    fireEvent.click(screen.getByTestId('runs-load-more'))
    await waitFor(() => {
      expect(screen.getAllByTestId(/^runs-row-/)).toHaveLength(21)
    })
    expect(researchApi.listTransformationResults).toHaveBeenCalledTimes(2)
    const secondCall = vi.mocked(researchApi.listTransformationResults).mock.calls[1]
    expect(secondCall[0]).toBe(P)
    expect(secondCall[1]).toEqual({ limit: 20, cursor: 'cursor-21' })
    // next_cursor null → 不再显示 Load more
    await waitFor(() => expect(screen.queryByTestId('runs-load-more')).toBeNull())
  })

  it('Error → 显示错误 + Retry；Retry 后恢复', async () => {
    vi.mocked(researchApi.listTransformationResults)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ items: [record(1)], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<TransformationRunsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('research.workbench.loadFailed')).toBeTruthy())
    fireEvent.click(screen.getByText('research.pagination.retry'))
    await waitFor(() => expect(screen.getAllByTestId(/^runs-row-/)).toHaveLength(1))
  })

  it('刷新（queryClient.clear）后历史仍可达，且重新请求服务端（Medium-6）', async () => {
    vi.mocked(researchApi.listTransformationResults).mockResolvedValue({
      items: [record(1), record(2)], next_cursor: null,
    })
    const { wrapper, queryClient } = makeWrapper()
    const { unmount } = render(<TransformationRunsPanel />, { wrapper })
    await waitFor(() => expect(screen.getAllByTestId(/^runs-row-/)).toHaveLength(2))
    expect(researchApi.listTransformationResults).toHaveBeenCalledTimes(1)
    // 模拟全量刷新：清缓存 + 重新挂载
    unmount()
    queryClient.clear()
    const before = vi.mocked(researchApi.listTransformationResults).mock.calls.length
    render(<TransformationRunsPanel />, { wrapper })
    await screen.findByTestId('runs-row-tres_01')
    const after = vi.mocked(researchApi.listTransformationResults).mock.calls.length
    expect(after).toBeGreaterThan(before)
  })

  it('response_language null（legacy/RWV2-31 前）→ meta 显示 — 而非误标 en（评审 Medium-1）', async () => {
    const r = record(1) // response_language: null
    vi.mocked(researchApi.listTransformationResults).mockResolvedValue({
      items: [r], next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<TransformationRunsPanel />, { wrapper })
    const meta = await screen.findByTestId('run-row-meta-tres_01')
    expect(meta.textContent).toContain('—')
    // 不能把未知历史语言冒充 'en'（旧实现 ?? 'en' 的回归红线）
    expect(meta.textContent).not.toContain('en')
  })

  it('response_language 有值 → meta 显示真实语言（评审 Medium-1 对照组）', async () => {
    const r = { ...record(1), response_language: 'zh' }
    vi.mocked(researchApi.listTransformationResults).mockResolvedValue({
      items: [r], next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<TransformationRunsPanel />, { wrapper })
    const meta = await screen.findByTestId('run-row-meta-tres_01')
    expect(meta.textContent).toContain('zh')
  })

  it('点行打开只读详情（TransformationRunDetail）并渲染冻结元数据', async () => {
    const r = record(1)
    vi.mocked(researchApi.listTransformationResults).mockResolvedValue({
      items: [r], next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<TransformationRunsPanel />, { wrapper })
    fireEvent.click(await screen.findByTestId('runs-row-tres_01'))
    await screen.findByTestId('run-detail')
    expect(screen.getByTestId('detail-model').textContent).toContain('m-local')
    expect(screen.getByTestId('detail-status').textContent).toContain('completed')
    expect(screen.getByTestId('rerun-btn')).toBeTruthy()
  })

  it('Admin 只读：列表可浏览、详情无 Rerun（W7）', async () => {
    const r = record(1)
    vi.mocked(researchApi.listTransformationResults).mockResolvedValue({
      items: [r], next_cursor: null,
    })
    const { wrapper } = makeWrapper('admin_readonly')
    render(<TransformationRunsPanel />, { wrapper })
    fireEvent.click(await screen.findByTestId('runs-row-tres_01'))
    await screen.findByTestId('run-detail')
    expect(screen.queryByTestId('rerun-btn')).toBeNull()
  })
})
