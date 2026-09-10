/**
 * Issue #54 S4（评审 C-1 回归锁）：**真实** GlobalModel Provider + consent 弹窗，
 * 只 mock HTTP 边界。
 *
 * 为什么必须单列：其余用例用 global-model 替身（runGuarded 同步执行），而真实
 * `runGuarded` 在需要 consent 时**只登记不执行**、由 `confirmConsent` 稍后 await
 * 捕获的 operation。若「派发后处理」写在 dispatch 之后而非 operation 之内，
 * 外部模型路径就会出现：付费外发已发生，但结果不合并、Job 不登记、marker 不清、
 * 无任何提示。本文件锁死该路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InsightsPanel } from './InsightsPanel'
import { ResearchEgressConsentDialog } from './ResearchEgressConsentDialog'
import { ResearchGlobalModelProvider } from '@/lib/hooks/use-research-global-model'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import { apiClient } from '@/lib/api/client'
import { listAiInsightRiskMarkers } from '@/lib/research/ai-insight-risk'
import { QUERY_KEYS } from '@/lib/api/query-client'

vi.mock('@/lib/api/client', () => ({ apiClient: { post: vi.fn(), get: vi.fn() } }))
vi.mock('@/lib/research/api', () => ({
  listInsights: vi.fn(),
  createInsight: vi.fn(),
  listSources: vi.fn(),
  listNotes: vi.fn(),
  listJobs: vi.fn(async () => ({ items: [], next_cursor: null })),
  getJob: vi.fn(async () => ({
    job_id: 'job_x', project_id: 'proj_1', job_type: 'research_coverage',
    status: 'completed', stage: null, progress: 1, model_id: null,
    generation_epoch: 1, retry_count: 0, last_error: null, result_ref: null,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  })),
  cancelJob: vi.fn(),
  retryCoverageJob: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'ui-consent-key'),
  // 真实 GlobalModel Provider 的查询面
  listModels: vi.fn(),
  getExecutionPreferences: vi.fn(),
  getExternalEgressConsent: vi.fn(),
  acknowledgeExternalEgressConsent: vi.fn(),
  saveExecutionPreferences: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }))

const PROJECT = 'proj_1'
const EXTERNAL_MODEL = 'm-ext'

const readySource = {
  source_id: 'src_1', document_id: 'doc_1', document_version: 'v1',
  status: 'ready' as const, content_hash: null, synced_at: null, last_error: null,
}

function makeTree() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    queryClient,
    ui: (
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId="u1" projectId={PROJECT} role="owner">
          <ResearchGlobalModelProvider>
            <ResearchJobsProvider>
              <ResearchScopeProvider userId="u1" projectId={PROJECT}>
                <InsightsPanel />
                <ResearchEgressConsentDialog />
              </ResearchScopeProvider>
            </ResearchJobsProvider>
          </ResearchGlobalModelProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>
    ),
  }
}

/** 外部模型 + 尚未确认（服务端 consent.valid=false）→ needsConsent=true */
function stubExternalModelPendingConsent() {
  vi.mocked(researchApi.listModels).mockResolvedValue({
    models: [{
      model_id: EXTERNAL_MODEL, display_name: 'Ext M', data_egress: true,
      interactive_context_levels: ['focused'],
    }],
    capabilities: {},
  } as never)
  vi.mocked(researchApi.getExecutionPreferences).mockResolvedValue({
    preferred_model_id: EXTERNAL_MODEL, default_context_level: 'focused',
  } as never)
  vi.mocked(researchApi.getExternalEgressConsent).mockResolvedValue({
    consent: null,
    required_scope: {
      policy_version: '1',
      provider_destinations: [{ provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' }],
      data_categories: ['focused_context'],
      scope_hash: 'h',
    },
  } as never)
  vi.mocked(researchApi.acknowledgeExternalEgressConsent).mockResolvedValue({
    consent: {
      policy_version: '1', scope_hash: 'h', acknowledged_at: '2026-09-01T00:00:00Z',
      acknowledged_by_user_id: 1, destination_ids: ['ext-1'], data_categories: ['focused_context'],
      valid: true,
    },
    // 注意：required_scope 是弹窗渲染的必需字段——mock 也要给（真实响应恒有）
    required_scope: {
      policy_version: '1',
      provider_destinations: [{ provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' }],
      data_categories: ['focused_context'],
      scope_hash: 'h',
    },
  } as never)
}

async function fillAndSubmit() {
  fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
  fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), { target: { value: 'AI 发现' } })
  fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), { target: { value: '总结这些材料' } })
  fireEvent.click(screen.getByLabelText('research.insights.typeLabel'))
  fireEvent.click(await screen.findByRole('option', { name: 'research.insights.typeAi' }))
  fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
  vi.mocked(researchApi.listSources).mockResolvedValue({ items: [readySource], next_cursor: null })
  vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
})

describe('InsightsPanel × 真实 consent 流程（C-1 回归）', () => {
  it('外部模型：确认后 200 必须合并缓存、清 marker、重置表单', async () => {
    stubExternalModelPendingConsent()
    vi.mocked(apiClient.post).mockResolvedValue({
      status: 200,
      data: {
        insight_id: 'ins_ext', project_id: PROJECT, title: 'AI 发现', content: 'out',
        insight_type: 'ai', model_id: EXTERNAL_MODEL, created_at: null, updated_at: null,
        generation_id: 'gen_ext',
      },
      headers: { 'x-research-contract': 'v1' },
    } as never)
    const { ui, queryClient } = makeTree()
    render(ui)

    await fillAndSubmit()
    // 需要 consent：弹窗出现，尚未外发
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    expect(apiClient.post).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('egress-consent-confirm'))

    // C-1：外发已发生（返回 200）后，结果必须被处理——缓存合并 + 表单重置 + marker 清空
    await waitFor(() =>
      expect(queryClient.getQueryData(QUERY_KEYS.researchInsights(PROJECT))).toBeDefined(),
    )
    await waitFor(() =>
      expect(screen.getByTestId('insight-row-ins_ext')).toBeInTheDocument(),
    )
    // 成功回调（表单重置）在 merge 之后的微任务里落地
    await waitFor(() =>
      expect(screen.queryByLabelText('research.notes.titleLabel')).toBeNull(),
    )
    expect(listAiInsightRiskMarkers('u1', PROJECT)).toEqual([])
  })

  it('外部模型：确认后 202 必须登记 Job（唯一 Provider）且不宣称已创建', async () => {
    stubExternalModelPendingConsent()
    vi.mocked(apiClient.post).mockResolvedValue({
      status: 202,
      data: { generation_id: 'gen_q', job_id: 'job_ext', status: 'queued' },
      headers: { 'x-research-contract': 'v1' },
    } as never)
    const { ui } = makeTree()
    render(ui)

    await fillAndSubmit()
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    fireEvent.click(screen.getByTestId('egress-consent-confirm'))

    await waitFor(() =>
      expect(localStorage.getItem('rdlens.research.jobs.proj_1')).toContain('job_ext'),
    )
    // 202 之后 marker 清空（成功受理）且无 Insight 行
    await waitFor(() => expect(listAiInsightRiskMarkers('u1', PROJECT)).toEqual([]))
    expect(screen.queryByTestId('insight-row-ins_ext')).toBeNull()
  })

  it('外部模型：取消 consent → 零 POST、零 marker', async () => {
    stubExternalModelPendingConsent()
    const { ui } = makeTree()
    render(ui)

    await fillAndSubmit()
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    fireEvent.click(screen.getByTestId('egress-consent-cancel'))

    await waitFor(() => expect(screen.queryByTestId('egress-consent-dialog')).toBeNull())
    expect(apiClient.post).not.toHaveBeenCalled()
    expect(listAiInsightRiskMarkers('u1', PROJECT)).toEqual([])
  })
})
