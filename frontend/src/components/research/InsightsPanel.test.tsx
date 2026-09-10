import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InsightsPanel } from './InsightsPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import { ResearchScopeProvider } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import { apiClient } from '@/lib/api/client'
import type { ResearchInsight } from '@/lib/types/research'

// UI-02 Red：Insights 工作台（REQ-SCOPE-04/REQ-API-01，契约 §7.2）——
// manual/ai 两类创建；Owner 可写，Admin 只读（无写入口）；保存不触发
// Embedding（REQ-DIS-01 语义延伸）。
// #243 §6.5：AI 类型不再有本面板的模型输入框——模型来自顶层全局设置
// （测试替身提供 confirmed 模型），本文件断言「ai 创建携带顶层快照」。

// ai-insight adapter 直接走 apiClient.post（非 api 模块函数）——只 mock HTTP 边界
vi.mock('@/lib/api/client', () => ({ apiClient: { post: vi.fn(), get: vi.fn() } }))
vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  listInsights: vi.fn(),
  createInsight: vi.fn(),
  // S4：AI 派发与新依赖（唯一 Jobs Provider / 唯一 Scope resolver）
  createAiInsight: vi.fn(),
  listJobs: vi.fn(async () => ({ items: [], next_cursor: null })),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
  retryCoverageJob: vi.fn(),
  listSources: vi.fn(async () => ({ items: [], next_cursor: null })),
  listNotes: vi.fn(async () => ({ items: [], next_cursor: null })),
  newIdempotencyKey: vi.fn(() => 'ui-test-key'),
}))

// 被测对象不是全局模型本身：用测试替身提供 confirmed 模型（本地、可执行）
vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

// RWV2-42（M7）：覆盖模型态（saving/unavailable）只阻断 AI 生成的锚用例
import { setGlobalModelStub } from '@/test/global-model-stub'
import { aiInsightRiskMarkerKey } from '@/lib/research/ai-insight-risk'

const insight = (overrides: Partial<ResearchInsight> = {}): ResearchInsight => ({
  insight_id: 'ins_1',
  project_id: 'proj_1',
  title: '关键发现',
  content: 'A 与 B 显著相关',
  insight_type: 'manual',
  model_id: null,
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
  ...overrides,
})

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role={role} userId="u1">
        <ResearchJobsProvider>
          <ResearchScopeProvider userId="u1" projectId="proj_1">
            {children}
          </ResearchScopeProvider>
        </ResearchJobsProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('InsightsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 每个用例从干净的持久面开始（Jobs Provider 的 localStorage 登记）
    localStorage.clear()
    // radix Select 在 jsdom 中调用 scrollIntoView（无实现）
    Element.prototype.scrollIntoView = vi.fn()
    // Issue #311 同款：裸 vi.fn() 返回 undefined 会让 Jobs Provider 回源抛错被吞
    vi.mocked(researchApi.getJob).mockResolvedValue({
      job_id: 'job_x', project_id: 'proj_1', job_type: 'research_coverage',
      status: 'completed', stage: null, progress: 1, model_id: null,
      generation_epoch: 1, retry_count: 0, last_error: null, result_ref: null,
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    })
  })

  it('Owner：列表 + 手动 Insight 创建（manual 不带 model_id）', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [insight()], next_cursor: null })
    vi.mocked(researchApi.createInsight).mockResolvedValue(insight({ insight_id: 'ins_2' }))
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('关键发现')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: '新发现' },
    })
    fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), {
      target: { value: '新内容' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() =>
      expect(researchApi.createInsight).toHaveBeenCalledWith('proj_1', {
        title: '新发现',
        content: '新内容',
        insight_type: 'manual',
      }),
    )
  })

  it('AI 类型创建走专用 adapter：契约头 + 冻结 Scope/focused/语言（S4 重写）', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    // S2 resolver：entire_project 需至少一个可派发 Source，否则空有效范围会被阻断
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [{
        source_id: 'src_1',
        document_id: 'doc_1',
        document_version: 'v1',
        status: 'ready',
        content_hash: null,
        synced_at: null,
        last_error: null,
      }],
      next_cursor: null,
    })
    vi.mocked(apiClient.post).mockResolvedValue({
      status: 200,
      data: { ...insight({ insight_type: 'ai' }), generation_id: 'gen_1' },
      headers: { 'x-research-contract': 'v1' },
    } as never)
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listInsights).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: 'AI 发现' },
    })
    fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), {
      target: { value: '生成内容' },
    })
    // 选择 AI 类型（radix Select：点击触发器 → 点击选项）
    fireEvent.click(screen.getByLabelText('research.insights.typeLabel'))
    fireEvent.click(await screen.findByRole('option', { name: 'research.insights.typeAi' }))
    // #243 §6.5：模型输入已移除，面板内不再有第二处模型入口
    expect(screen.queryByLabelText('research.insights.modelLabel')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    // AI 新契约：专用 adapter + 调用方幂等键（而非 createInsight）
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        '/v1/research/projects/proj_1/insights',
        {
          title: 'AI 发现',
          content: '生成内容',
          insight_type: 'ai',
          // 顶层 confirmed 全局模型快照（替身值）
          model_id: 'm-local',
          context_level: 'focused',
          source_ids: ['src_1'],
          note_ids: [],
          // content 为中文 → zh（派发时刻检出并冻结）
          response_language: 'zh',
        },
        {
          headers: {
            'X-Research-Contract': 'v1',
            'Idempotency-Key': 'ui-test-key',
          },
        },
      ),
    )
    // 旧的 manual 端点未被 AI 路径使用
    expect(researchApi.createInsight).not.toHaveBeenCalled()
  })


  const readySource = () => ({
    source_id: 'src_1', document_id: 'doc_1', document_version: 'v1', status: 'ready' as const,
    content_hash: null, synced_at: null, last_error: null,
  })

  /** 打开表单 → 选 AI → 提交（S4 派发路径的公共前置） */
  async function submitAiForm() {
    fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), { target: { value: 'AI 发现' } })
    fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), { target: { value: '生成内容' } })
    fireEvent.click(screen.getByLabelText('research.insights.typeLabel'))
    fireEvent.click(await screen.findByRole('option', { name: 'research.insights.typeAi' }))
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
  }

  it('S4-202：Job 由唯一 Jobs Provider 登记（localStorage 可见）+ truthful queued 提示', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [readySource()], next_cursor: null })
    vi.mocked(apiClient.post).mockResolvedValue({
      status: 202,
      data: { generation_id: 'gen_9', job_id: 'job_ai_1', status: 'queued' },
      headers: { 'x-research-contract': 'v1' },
    } as never)
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listInsights).toHaveBeenCalled())
    await submitAiForm()

    // 202 反馈走 toast（成功路径会关闭表单，内联提示不可见）——不宣称已创建
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'research.insights.aiQueued',
        }),
      ),
    )
    // 登记进唯一 Jobs Provider（其 localStorage 形态是权威副作用）
    await waitFor(() =>
      expect(localStorage.getItem('rdlens.research.jobs.proj_1')).toContain('job_ai_1'),
    )
    // 不宣称 Insight 已创建
    expect(screen.queryByText('research.insights.empty')).not.toBeNull()
  })

  it('S4-200：返回的 Insight 合并进列表（不依赖 refetch）', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [readySource()], next_cursor: null })
    vi.mocked(apiClient.post).mockResolvedValue({
      status: 200,
      data: { ...insight({ insight_id: 'ins_new', title: '新洞察' }), generation_id: 'gen_1' },
      headers: { 'x-research-contract': 'v1' },
    } as never)
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listInsights).toHaveBeenCalled())
    await submitAiForm()

    await waitFor(() => expect(screen.getByTestId('insight-row-ins_new')).toBeInTheDocument())
    // 表单重置（派发成功）
    expect(screen.queryByLabelText('research.notes.titleLabel')).toBeNull()
  })

  it('S4：未确认的旧 marker 拦截派发，确认后可放行', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [readySource()], next_cursor: null })
    localStorage.setItem(
      aiInsightRiskMarkerKey('u1', 'proj_1', 'old-tab'),
      JSON.stringify({ version: 1, markerId: 'old-tab', kind: 'fresh', recordedAt: 1 }),
    )
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listInsights).toHaveBeenCalled())
    await submitAiForm()

    await waitFor(() => expect(screen.getByTestId('insight-ai-notice-protocol_conflict')).toBeInTheDocument())
    expect(apiClient.post).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'research.insights.aiProtocolConflict' }),
    )
    // 用户确认承担重复风险 → 再次提交放行
    vi.mocked(apiClient.post).mockResolvedValue({
      status: 200,
      data: { ...insight({ insight_id: 'ins_ok' }), generation_id: 'gen_1' },
      headers: { 'x-research-contract': 'v1' },
    } as never)
    fireEvent.click(screen.getByTestId('insight-confirm-duplicate-risk'))
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() => expect(screen.getByTestId('insight-row-ins_ok')).toBeInTheDocument())
  })

  it('Admin：只读——列表可见、无新建入口', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [insight()], next_cursor: null })
    const { wrapper } = makeWrapper('admin_readonly')
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('关键发现')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.insights.newInsight' })).toBeNull()
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()
  })

  it('RWV2-42（M7）：模型保存中只阻断 AI 生成，Manual Insight 创建仍可用', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.createInsight).mockResolvedValue(insight({ insight_id: 'ins_m' }))
    setGlobalModelStub({
      confirmedModelId: 'm-local',
      isSavingModel: true,
      canExecute: false,
      blockedReason: 'saving',
    })
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listInsights).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: '手动记录' },
    })
    fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), {
      target: { value: '人工内容' },
    })
    // Manual 不受模型态影响：可提交
    const save = screen.getByRole('button', { name: 'research.notes.save' })
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    await waitFor(() =>
      expect(researchApi.createInsight).toHaveBeenCalledWith('proj_1', {
        title: '手动记录',
        content: '人工内容',
        insight_type: 'manual',
      }),
    )

    // 切到 AI：生成被阻断（按钮禁用 + blockedHint 可见）
    fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
    fireEvent.click(screen.getByLabelText('research.insights.typeLabel'))
    fireEvent.click(await screen.findByRole('option', { name: 'research.insights.typeAi' }))
    expect(screen.getByRole('button', { name: 'research.notes.save' })).toBeDisabled()
    expect(screen.getByTestId('insight-model-blocked').textContent).toContain(
      'research.globalModel.saving',
    )
  })
})
