/**
 * ResearchSearchPanel 集成测试（Issue #200 Phase 2b §14.3；Issue #243
 * GMOD-FE-01 §6.3/§6.7/§6.8）。
 *
 * 覆盖：
 * - 模型来自 Research 顶层 confirmed 全局模型，本面板不再有模型选择器；
 * - 无 confirmed 模型时 Run 禁用并给出引导（不自动改选）；
 * - Preview 与执行都显式携带 confirmed model_id（§6.7 required）；
 * - Search 局部档位可未经保存直接使用；保存档位只 PATCH context；
 * - 当前模型 interactive_context_levels 不支持已选档位时收敛到 focused；
 * - 外部模型未经确认时 Run 不发出请求，由根级弹窗确认后才执行，取消则
 *   零副作用（不变量 9）；
 * - 幂等键语义（§7.2）与后台受理展示不受全局模型改造影响。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import { ResearchEgressConsentDialog } from './ResearchEgressConsentDialog'
import { ResearchGlobalModelProvider } from '@/lib/hooks/use-research-global-model'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'

vi.mock('@/lib/hooks/use-translation', () => ({
  // 插值参数一并拼进返回值，便于断言 i18n 占位符实际取值
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}|${JSON.stringify(opts)}`,
  }),
}))

// MarkdownRenderer 依赖 window.matchMedia（jsdom 未实现），与本文断言无关
vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

const prefs = {
  project_id: 'p1',
  default_context_level: 'focused' as const,
  preferred_model_id: 'm-local',
  updated_by: 1,
  updated_at: '2026-08-26T00:00:00+00:00',
}

const noPrefs = {
  project_id: 'p1',
  default_context_level: 'focused' as const,
  preferred_model_id: null,
  updated_by: null,
  updated_at: null,
}

const validConsentResponse = {
  consent: {
    project_id: 'p1',
    acknowledged_by: 1,
    acknowledged_at: '2026-08-27T00:00:00+00:00',
    policy_version: '1',
    scope_hash: 'hash-current',
    revoked_at: null,
    revoked_by: null,
    valid: true,
  },
  required_scope: {
    policy_version: '1',
    provider_destinations: [
      { provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' },
    ],
    data_categories: ['focused_context'],
    scope_hash: 'hash-current',
  },
}

const noConsentResponse = {
  consent: null,
  required_scope: validConsentResponse.required_scope,
}

const MODELS: ResearchModelOption[] = [
  {
    model_id: 'm-local',
    display_name: 'Local M',
    data_egress: false,
    interactive_context_levels: ['focused', 'document', 'workspace'],
  },
  {
    model_id: 'm-ext',
    display_name: 'Ext M',
    provider_id: 'ext-1',
    data_egress: true,
    // §5.2：外部模型只声明 focused
    interactive_context_levels: ['focused'],
  },
]

vi.mock('@/lib/research/api', () => ({
  listModels: vi.fn(async () => ({ models: MODELS })),
  getExecutionPreferences: vi.fn(async () => noPrefs),
  patchExecutionPreferences: vi.fn(async (_projectId, input) => ({ ...noPrefs, ...input })),
  fetchContextPreview: vi.fn(async () => ({
    source_count: 1,
    chunk_count: 3,
    note_count: 0,
    token_estimate: 120,
    direct_or_background: 'direct',
    needs_consent: false,
    coverage: {},
    warnings: [],
  })),
  getExternalEgressConsent: vi.fn(async () => validConsentResponse),
  acknowledgeExternalEgressConsent: vi.fn(async () => validConsentResponse),
  searchV1: vi.fn(),
  newIdempotencyKey: vi.fn(() => `ui-${++keySeq}`),
}))

import {
  acknowledgeExternalEgressConsent,
  fetchContextPreview,
  getExecutionPreferences,
  getExternalEgressConsent,
  listModels,
  newIdempotencyKey,
  patchExecutionPreferences,
  searchV1,
} from '@/lib/research/api'
import type { ResearchModelOption } from '@/lib/research/types'

let keySeq = 0

/** 复现页面真实结构：provider → 面板 + 根级确认弹窗。 */
function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="p1" role="owner">
        <ResearchGlobalModelProvider>
          <ResearchSearchPanel
            projectId="p1"
            selectedSourceIds={['d1']}
            selectedNoteIds={[]}
          />
          <ResearchEgressConsentDialog />
        </ResearchGlobalModelProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

const runButton = () =>
  screen.getByRole('button', { name: 'research.searchRun' }) as HTMLButtonElement

/**
 * 等 confirmed 模型到位。Run 同时受空查询约束，因此先输入查询词再等按钮
 * 可用——两者都满足才说明 confirmed 模型已就绪且入口未被冻结。
 */
async function typeAndWaitReady(value: string) {
  fireEvent.change(screen.getByTestId('search-input'), { target: { value } })
  await waitFor(() => expect(runButton().disabled).toBe(false))
}

describe('ResearchSearchPanel（GMOD §6.3 全局模型接线）', () => {
  beforeEach(() => {
    // reset 后重建默认实现：clearAllMocks 在本仓库 Vitest 版本下会清掉实现
    vi.resetAllMocks()
    keySeq = 0
    vi.mocked(listModels).mockResolvedValue({ models: MODELS })
    vi.mocked(getExecutionPreferences).mockResolvedValue(noPrefs)
    vi.mocked(patchExecutionPreferences).mockImplementation(async (_projectId, input) => ({
      ...noPrefs,
      ...input,
    }))
    vi.mocked(fetchContextPreview).mockResolvedValue({
      source_count: 1,
      chunk_count: 3,
      note_count: 0,
      token_estimate: 120,
      direct_or_background: 'direct',
      needs_consent: false,
      coverage: {},
      warnings: [],
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(validConsentResponse)
    vi.mocked(acknowledgeExternalEgressConsent).mockResolvedValue(
      validConsentResponse,
    )
    vi.mocked(newIdempotencyKey).mockImplementation(() => `ui-${++keySeq}`)
  })

  it('面板内不再有模型选择器（页面内唯一入口在 Research 顶层）', async () => {
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId('search-context-selector')).toBeTruthy(),
    )
    expect(screen.queryByTestId('model-select')).toBeNull()
  })

  it('无 confirmed 模型时 Run 禁用并给出引导，不自动改选', async () => {
    renderPanel()
    // noPrefs：confirmed 为空 → 入口不可用（不变量 7 的 UI 对应）
    await waitFor(() =>
      expect(screen.getByTestId('model-blocked-hint')).toBeTruthy(),
    )
    expect(runButton().disabled).toBe(true)
    expect(searchV1).not.toHaveBeenCalled()
  })

  it('Preview 与执行都以显式 confirmed model_id 发送（§6.7 required）', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    vi.mocked(searchV1).mockResolvedValue({
      kind: 'direct',
      result: {
        request_id: 'r1',
        resolved_mode: 'direct_context',
        evidence: [],
        citations: [],
        usage: { input_tokens: 10, output_tokens: 5, estimated: true },
        degradation_reason: null,
        conclusion: 'ok',
        model_id: 'm-local',
        provider_id: 'local-sglang',
        context_level: 'focused',
        context_coverage: {
          context_level: 'focused',
          relevant_extra: 2,
          trimmed: 1,
          input_budget: 65536,
        },
      },
    })
    renderPanel()
    await typeAndWaitReady('what is ORR?')
    await waitFor(() =>
      expect(screen.getByTestId('context-preview')).toBeTruthy(),
    )
    expect(fetchContextPreview).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ model_id: 'm-local' }),
    )
    fireEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('search-result')).toBeTruthy())
    expect(searchV1).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ query: 'what is ORR?', model_id: 'm-local' }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^ui-/) }),
    )
    expect(screen.getByTestId('search-model').textContent).toContain('m-local')
  })

  it('局部档位未经保存也直接进入请求体；保存档位只 PATCH context', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    vi.mocked(searchV1).mockResolvedValue({
      kind: 'background',
      generation_id: 'gen_u',
      job_id: 'job_u',
      status: 'queued',
    })
    renderPanel()
    await typeAndWaitReady('unsaved level')
    fireEvent.change(screen.getByTestId('context-select'), {
      target: { value: 'workspace' },
    })
    fireEvent.click(runButton())
    await waitFor(() =>
      expect(screen.getByTestId('background-queued')).toBeTruthy(),
    )
    expect(searchV1).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ model_id: 'm-local', context_level: 'workspace' }),
      expect.anything(),
    )
    // 保存档位：只 PATCH default_context_level，不触碰模型（不变量 8）
    fireEvent.click(screen.getByTestId('save-search-context'))
    await waitFor(() =>
      expect(patchExecutionPreferences).toHaveBeenCalledWith('p1', {
        default_context_level: 'workspace',
      }),
    )
    const payload = vi.mocked(patchExecutionPreferences).mock.calls[0]?.[1]
    expect(Object.keys(payload ?? {})).toEqual(['default_context_level'])
  })

  it('模型不支持已选档位时收敛到 focused 并提示，不静默写回服务端', async () => {
    // 服务端默认档位 workspace，但 confirmed 外部模型只声明 focused
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...prefs,
      preferred_model_id: 'm-ext',
      default_context_level: 'workspace',
    })
    renderPanel()
    await typeAndWaitReady('context probe')
    await waitFor(() =>
      expect(
        (screen.getByTestId('context-select') as HTMLSelectElement).value,
      ).toBe('focused'),
    )
    expect(screen.getByTestId('context-auto-adjusted').textContent).toContain(
      'workspace',
    )
    // 收敛只发生在本地：不产生任何保存请求（不静默写回服务端）
    expect(patchExecutionPreferences).not.toHaveBeenCalled()
  })

  it('失败后立即重试复用同一幂等键（§7.2 网络层结果未知）', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    vi.mocked(searchV1)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        kind: 'direct',
        result: {
          request_id: 'r9',
          resolved_mode: 'direct_context',
          evidence: [],
          citations: [],
          usage: { input_tokens: 1, output_tokens: 1 },
          degradation_reason: null,
          conclusion: 'ok',
        },
      })
    renderPanel()
    await typeAndWaitReady('retry me')
    fireEvent.click(runButton())
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy())
    fireEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('search-result')).toBeTruthy())
    expect(vi.mocked(searchV1).mock.calls[1][2]?.idempotencyKey).toBe(
      vi.mocked(searchV1).mock.calls[0][2]?.idempotencyKey,
    )
  })

  it('服务端已给结局的错误后重试使用新幂等键（§7.2 终态需新 key）', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    const serverError = Object.assign(new Error('engine unavailable'), {
      response: { status: 503 },
    })
    vi.mocked(searchV1)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce({
        kind: 'direct',
        result: {
          request_id: 'r10',
          resolved_mode: 'direct_context',
          evidence: [],
          citations: [],
          usage: { input_tokens: 1, output_tokens: 1 },
          degradation_reason: null,
          conclusion: 'ok',
        },
      })
    renderPanel()
    await typeAndWaitReady('q')
    fireEvent.click(runButton())
    await waitFor(() =>
      expect(screen.getByText('engine unavailable')).toBeTruthy(),
    )
    fireEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('search-result')).toBeTruthy())
    expect(vi.mocked(searchV1).mock.calls[1][2]?.idempotencyKey).not.toBe(
      vi.mocked(searchV1).mock.calls[0][2]?.idempotencyKey,
    )
  })

  it('202 后台受理展示排队提示而非结果', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    vi.mocked(searchV1).mockResolvedValue({
      kind: 'background',
      generation_id: 'gen_bg_1',
      job_id: 'job_bg_9',
      status: 'queued',
    })
    renderPanel()
    await typeAndWaitReady('long research')
    fireEvent.click(runButton())
    await waitFor(() =>
      expect(screen.getByTestId('background-queued')).toBeTruthy(),
    )
    expect(screen.queryByTestId('search-result')).toBeNull()
  })

  it('外部模型无有效确认：Run 不发出请求，确认后执行；取消零副作用', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...prefs,
      preferred_model_id: 'm-ext',
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(noConsentResponse)
    vi.mocked(searchV1).mockResolvedValue({
      kind: 'direct',
      result: {
        request_id: 'r1',
        resolved_mode: 'hybrid_rag',
        evidence: [],
        citations: [],
        usage: { input_tokens: 10, output_tokens: 5, estimated: true },
        degradation_reason: null,
        conclusion: 'ok',
      },
    })
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId('consent-required-hint')).toBeTruthy(),
    )
    fireEvent.change(screen.getByTestId('search-input'), {
      target: { value: 'external question' },
    })
    // 入口仍可点击：禁用会让用户无法触发确认（§6.8 第 3 步）
    expect(runButton().disabled).toBe(false)
    fireEvent.click(runButton())

    // 不变量 9：确认前不发出任何搜索请求
    await waitFor(() =>
      expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy(),
    )
    expect(searchV1).not.toHaveBeenCalled()
    expect(screen.getByTestId('egress-consent-destination').textContent).toContain(
      'ext-1',
    )
    expect(screen.getByTestId('egress-consent-categories').textContent).toContain(
      'focused_context',
    )

    // 取消：查询保留，不执行、不 acknowledge、无排队/结果状态
    fireEvent.click(screen.getByTestId('egress-consent-cancel'))
    await waitFor(() =>
      expect(screen.queryByTestId('egress-consent-dialog')).toBeNull(),
    )
    expect(searchV1).not.toHaveBeenCalled()
    expect(acknowledgeExternalEgressConsent).not.toHaveBeenCalled()
    expect(screen.queryByTestId('background-queued')).toBeNull()
    expect(
      (screen.getByTestId('search-input') as HTMLInputElement).value,
    ).toBe('external question')

    // 再次 Run → 确认 → 执行
    fireEvent.click(runButton())
    await waitFor(() =>
      expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('egress-consent-confirm'))
    await waitFor(() => expect(searchV1).toHaveBeenCalled())
    expect(acknowledgeExternalEgressConsent).toHaveBeenCalledWith('p1')
    await waitFor(() =>
      expect(screen.getByTestId('search-result')).toBeTruthy(),
    )
  })

  it('外部模型已有有效确认时 Run 直接执行，不弹确认框', async () => {    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...prefs,
      preferred_model_id: 'm-ext',
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(validConsentResponse)
    vi.mocked(searchV1).mockResolvedValue({
      kind: 'direct',
      result: {
        request_id: 'r2',
        resolved_mode: 'hybrid_rag',
        evidence: [],
        citations: [],
        usage: { input_tokens: 10, output_tokens: 5, estimated: false },
        degradation_reason: null,
        conclusion: 'ok',
      },
    })
    renderPanel()
    await typeAndWaitReady('external question 2')
    fireEvent.click(runButton())
    await waitFor(() => expect(searchV1).toHaveBeenCalled())
    expect(screen.queryByTestId('egress-consent-dialog')).toBeNull()
  })

  it('后端 dispatch 侧判定 consent_required → 让 consent 重新生效判定（§9.2 第 4 步）', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...prefs,
      preferred_model_id: 'm-ext',
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(validConsentResponse)
    vi.mocked(searchV1).mockRejectedValue({
      response: { data: { detail: { code: 'consent_required', message: 'x' } } },
    })
    renderPanel()
    await typeAndWaitReady('external question 3')
    const before = vi.mocked(getExternalEgressConsent).mock.calls.length
    fireEvent.click(runButton())
    // 后端是最终权威：前端不自行重试或改模型，只让 consent 重新判定，
    // 下一次执行由根级 guard 重新弹确认
    await waitFor(() =>
      expect(vi.mocked(getExternalEgressConsent).mock.calls.length).toBeGreaterThan(
        before,
      ),
    )
    expect(searchV1).toHaveBeenCalledTimes(1)
  })
})
