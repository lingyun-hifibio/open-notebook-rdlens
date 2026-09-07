import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TransformationRunDetail } from './TransformationRunDetail'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'
import * as researchApi from '@/lib/research/api'
import type { TransformationResultRecord } from '@/lib/types/research'

// RWV2-21 Red：Transformation Run 只读详情 + Rerun。
// - AC-3/AC-5：从选中 result 的不可变数据渲染冻结元数据，改当前
//   Scope/模型不改写详情。
// - AC-6/High-5：source 失效（缺失/版本/页码）悄悄降级但保留原文；runs
//   面板已挂 sources（本组件经 sources prop 复用）。
// - 不可编辑（无 input/写按钮）。
// - Rerun（AC-4/5/7；High-4/Medium-3/9/11/12）：新幂等键 + v1 头；legacy
//   transformation_id=null → 禁用；!canExecute → 禁用+提示；成功回调
//   新 result_id（父层关详情/高亮）；非 200 reject → 不 invalidate、toast。

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
  newIdempotencyKey: vi.fn(() => 'ui-42-xxx'),
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
const USER = 'u1'

const record = (overrides: Partial<TransformationResultRecord> = {}): TransformationResultRecord => ({
  result_id: 'tres_1',
  project_id: P,
  title: 'Summarizer',
  transformation_id: 'trans_1',
  template_config_ref: 'cfg_1',
  generation_id: 'gen_1',
  model_id: 'm-local',
  status: 'completed',
  response_language: null,
  source_ids: ['src_1'],
  note_ids: [],
  source_refs: ['src_1'],
  output: 'ORR was 45%.',
  citations: [],
  created_at: '2026-09-07T00:00:00Z',
  updated_at: null,
  ...overrides,
})

const snapshotCitation = (overrides: Record<string, unknown> = {}) => ({
  project_id: P,
  doc_id: 'doc_1',
  doc_version: 'v3',
  chunk_id: 'chunk_1',
  page_idx: 3,
  claim: '引用声明',
  original_text: '引用原文',
  citation_type: 'direct',
  confidence: 'high',
  ...overrides,
})

function seedScope(mode: 'entire_project' | 'selected', sourceIds: string[] = [], noteIds: string[] = []) {
  localStorage.setItem(
    scopeStorageKey(USER, P),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds }),
  )
}

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner', showRerun = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId={USER} projectId={P} role={role}>
        <ResearchScopeProvider userId={USER} projectId={P}>
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  const rerenderWith = (rec: TransformationResultRecord) => (
    <TransformationRunDetail
      record={rec}
      sources={[]}
      showRerun={showRerun}
    />
  )
  return { wrapper, queryClient, rerenderWith }
}

describe('TransformationRunDetail（RWV2-21 detail + rerun）', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
    toastMock.mockClear()
    resetGlobalModelStub()
  })

  it('渲染冻结元数据：provenance/model/status/language/time/输入计数/output', async () => {
    const rec = record()
    const { wrapper } = makeWrapper()
    render(<TransformationRunDetail record={rec} sources={[]} showRerun={false} />, { wrapper })
    expect(screen.getByText('Summarizer')).toBeTruthy()
    expect(screen.getByTestId('detail-transformation-id').textContent).toContain('trans_1')
    expect(screen.getByTestId('detail-config-ref').textContent).toContain('cfg_1')
    expect(screen.getByTestId('detail-model').textContent).toContain('m-local')
    expect(screen.getByTestId('detail-status').textContent).toContain('completed')
    expect(screen.getByTestId('detail-language').textContent).toContain('—') // null → 占位
    expect(screen.getByTestId('detail-output').textContent).toContain('ORR was 45%')
    // 输入计数经 i18n sourceNoteCount（评审 Low：不硬编码 sources/notes）
    expect(screen.getByTestId('detail-inputs-summary').textContent).toContain(
      'research.transformations.sourceNoteCount',
    )
    // 不可编辑：无注入
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('0/1/多 citation：归一化稳定 key + source 失效悄悄降级但保留原文', async () => {
    const rec = record({
      citations: [snapshotCitation({ doc_id: 'doc_1' }), snapshotCitation({ doc_id: 'doc_X' })],
    })
    const { wrapper } = makeWrapper()
    // sources 为空 → 所有 citation source_unavailable（High-5 假若漏挂）
    render(<TransformationRunDetail record={rec} sources={[]} showRerun={false} />, { wrapper })
    const cards = screen.getAllByTestId('citation-card')
    expect(cards.length).toBe(2)
    // 原文保留（两条同原文 → getAllByText）
    expect(screen.getAllByText('引用原文').length).toBe(2)
    expect(screen.getAllByText('引用声明').length).toBe(2)
    // 无跳转入口（source 缺失 → degraded，无 Jump to source 按钮）
    expect(screen.queryByText('research.citation.jump')).toBeNull()
  })

  it('legacy transformation_id=null（Medium-9）：ShowRerun 时显示不可重跑说明 + Rerun 按钮禁用', async () => {
    const rec = record({ transformation_id: null })
    const { wrapper } = makeWrapper()
    render(<TransformationRunDetail record={rec} sources={[]} showRerun />, { wrapper })
    expect(screen.getByTestId('rerun-unavailable').textContent).toContain('rerunUnavailable')
    const btn = screen.getByTestId('rerun-btn')
    expect(btn.hasAttribute('disabled')).toBe(true)
    fireEvent.click(btn)
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
  })

  it('Rerun：新幂等键 + v1 契约头 + 正确 body；成功回调新 result_id（AC-4/High-4/Medium-12）', async () => {
    seedScope('selected', ['src_1'], [])
    vi.mocked(researchApi.runTransformation).mockResolvedValue({
      request_id: 'req_2',
      transformation_id: 'trans_1',
      requires_job: false,
      degradation_reason: null,
      result_id: 'tres_2',
      model_id: 'm-local',
      source_refs: ['src_1'],
      usage: { input_tokens: 1, output_tokens: 1 },
      citations: [],
      output: 'new out',
    })
    const onSuccess = vi.fn()
    const rec = record()
    const { wrapper } = makeWrapper()
    render(
      <TransformationRunDetail record={rec} sources={[]} showRerun onRerunSuccess={onSuccess} />,
      { wrapper },
    )
    fireEvent.click(screen.getByTestId('rerun-btn'))
    await waitFor(() => {
      expect(researchApi.runTransformation).toHaveBeenCalledTimes(1)
    })
    const call = vi.mocked(researchApi.runTransformation).mock.calls[0]
    expect(call[1]).toBe('trans_1')
    expect(call[2]).toEqual({ source_ids: ['src_1'], note_ids: [], model_id: 'm-local' })
    // 新幂等键（非复用）由调用方传入；v1 头在 api 层恒有
    expect(vi.mocked(researchApi.newIdempotencyKey)).toHaveBeenCalled()
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('tres_2'))
  })

  it('Rerun 非 200 失败（422/403）→ mutation onError toast，不回调成功（High-4/Medium-3）', async () => {
    seedScope('selected', ['src_1'], [])
    vi.mocked(researchApi.runTransformation).mockRejectedValue({
      response: { status: 422 },
    })
    const onSuccess = vi.fn()
    const { wrapper } = makeWrapper()
    render(
      <TransformationRunDetail record={record()} sources={[]} showRerun onRerunSuccess={onSuccess} />,
      { wrapper },
    )
    fireEvent.click(screen.getByTestId('rerun-btn'))
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
    })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('Rerun requires_job job 化成功（result_id null）→ 可见 degraded/job 提示，不回调成功（评审 Medium-2）', async () => {
    seedScope('selected', ['src_1'], [])
    vi.mocked(researchApi.runTransformation).mockResolvedValue({
      request_id: 'req_2',
      transformation_id: 'trans_1',
      requires_job: true,
      degradation_reason: 'output_too_large',
      result_id: null,
      model_id: 'm-local',
      source_refs: ['src_1'],
      usage: { input_tokens: 1, output_tokens: 1 },
      citations: [],
      output: null,
    })
    const onSuccess = vi.fn()
    const { wrapper } = makeWrapper()
    render(
      <TransformationRunDetail record={record()} sources={[]} showRerun onRerunSuccess={onSuccess} />,
      { wrapper },
    )
    fireEvent.click(screen.getByTestId('rerun-btn'))
    // degraded 提示可见（与既有 run flow 一致），成功回调不被触发（无新行可高亮）
    await waitFor(() => {
      const degraded = screen.getByTestId('rerun-degraded')
      expect(degraded.textContent).toContain('degraded')
      expect(degraded.textContent).toContain('output_too_large')
    })
    expect(onSuccess).not.toHaveBeenCalled()
    expect(screen.queryByText('research.transformations.rerunSuccess')).toBeNull()
  })

  it('详情在 scope 解析在途时关闭/卸载 → 不派发（评审 Medium-3 生命周期守卫）', async () => {
    seedScope('entire_project')
    const { wrapper } = makeWrapper()
    let resolveSources!: (v: { items: never[]; next_cursor: string | null }) => void
    // 先挂起 sources 枚举（resolveScopeSelection 第一段）
    vi.mocked(researchApi.listSources).mockReturnValue(
      new Promise((res) => { resolveSources = res }),
    )
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    const { unmount } = render(
      <TransformationRunDetail record={record()} sources={[]} showRerun />,
      { wrapper },
    )
    fireEvent.click(screen.getByTestId('rerun-btn'))
    // 枚举在途（listSources 已被调用但未返回）
    await waitFor(() =>
      expect(researchApi.listSources).toHaveBeenCalledWith('proj_1', { limit: 100 }),
    )
    // 详情关闭 → 组件卸载 → cleanup 使令牌失效
    unmount()
    // 枚举返回后：令牌失效 → 不派发（修复前此路径会继续 mutateAsync）
    resolveSources({ items: [], next_cursor: null })
    await new Promise((r) => setTimeout(r, 50))
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
  })

  it('!canExecute（无 confirmed 模型）→ Rerun 禁用 + 提示，点按零派发（Medium-11）', async () => {
    seedScope('selected', ['src_1'], [])
    setGlobalModelStub({ canExecute: false, blockedReason: 'no-model' })
    const { wrapper } = makeWrapper()
    render(<TransformationRunDetail record={record()} sources={[]} showRerun />, { wrapper })
    const btn = screen.getByTestId('rerun-btn')
    expect(btn.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('rerun-blocked-hint')).toBeTruthy()
    fireEvent.click(btn)
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
  })

  it('Admin showRerun=false → 无 Rerun 按钮（W7）', async () => {
    const { wrapper } = makeWrapper('admin_readonly', false)
    render(<TransformationRunDetail record={record()} sources={[]} showRerun={false} />, { wrapper })
    expect(screen.queryByTestId('rerun-btn')).toBeNull()
  })
})
