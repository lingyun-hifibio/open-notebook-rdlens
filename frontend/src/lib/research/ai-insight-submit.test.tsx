import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useAiInsightSubmit, type AiInsightSubmitInput } from './ai-insight-submit'
import { aiInsightRiskMarkerKey, listAiInsightRiskMarkers } from './ai-insight-risk'
import { QUERY_KEYS } from '@/lib/api/query-client'
import type { ResearchInsight, ResearchPage } from '@/lib/types/research'

// Issue #54 S4（R-02/R-06/R-08/C-06/C-09）：AI Insight 提交编排——
// 幂等键生成时机、marker 先写后发、同 key 重试复用冻结请求、
// 200/202 分流与缓存合并、生命周期与身份约束。

vi.mock('./ai-insight', () => ({
  createAiInsight: vi.fn(),
  aiInsightOutcomeFromResponse: vi.fn(),
}))
// 只替换键工厂——其余导出（researchApiErrorDetail 等）保持真实实现，
// 否则失败分类会拿到 undefined 并抛错（测试假象）
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  newIdempotencyKey: vi.fn(() => 'ui-key-1'),
}))

import { createAiInsight, aiInsightOutcomeFromResponse } from './ai-insight'
import { newIdempotencyKey } from './api'

const PROJECT = 'proj_1'
const USER = 'u1'
const scopeLabel = '1 sources · 0 notes'

const insight = (id = 'ins_1'): ResearchInsight => ({
  insight_id: id, project_id: PROJECT, title: 'AI Insight', content: 'generated',
  insight_type: 'ai', model_id: 'm-ext', created_at: null, updated_at: null,
})

const input = (overrides: Partial<AiInsightSubmitInput> = {}): AiInsightSubmitInput => ({
  title: 'AI Insight', content: 'Summarize the materials.',
  sourceIds: ['src_1'], noteIds: [], responseLanguage: 'en',
  modelId: 'm-ext', scopeLabel,
  ...overrides,
})

function http(status: number, envelope: unknown, headers: Record<string, string> = { 'x-research-contract': 'v1' }) {
  return { status, envelope, headers }
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  }
}

/** 默认 dispatch：本地模型语义（直接执行 operation）。 */
const run = <T,>(operation: (modelId: string) => Promise<T>) => operation('m-ext')

function setup(overrides: Partial<Parameters<typeof useAiInsightSubmit>[0]> = {}) {
  const { queryClient, wrapper } = makeWrapper()
  const onCreated = vi.fn()
  const onQueued = vi.fn()
  const onOutcomeUnknown = vi.fn()
  const onProtocolConflict = vi.fn()
  const onFailed = vi.fn()
  const onBlockedEmptyScope = vi.fn()
  const hook = renderHook(
    () => useAiInsightSubmit({
      projectId: PROJECT, userId: USER, dispatch: run,
      onCreated, onQueued, onOutcomeUnknown, onProtocolConflict, onFailed, onBlockedEmptyScope,
      ...overrides,
    }),
    { wrapper },
  )
  return { ...hook, queryClient, onCreated, onQueued, onOutcomeUnknown, onProtocolConflict, onFailed, onBlockedEmptyScope }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(aiInsightOutcomeFromResponse).mockReturnValue({
    kind: 'created', insight: insight(), generationId: 'gen_1',
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('提交与成功路径', () => {
  it('200：合并进原项目缓存（不 invalidate）+ 清 marker + 回调 generationId', async () => {
    const { result, queryClient, onCreated } = setup()
    // 预置缓存页（派发时项目）
    queryClient.setQueryData<ResearchPage<ResearchInsight>>(
      QUERY_KEYS.researchInsights(PROJECT),
      { items: [{ ...insight('ins_old') }], next_cursor: null },
    )
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}) as never)

    let status = ''
    await act(async () => { status = await result.current.submit(input()) })

    expect(status).toBe('created')
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ insight_id: 'ins_1' }), 'gen_1')
    const cached = queryClient.getQueryData<ResearchPage<ResearchInsight>>(
      QUERY_KEYS.researchInsights(PROJECT),
    )
    expect(cached?.items.map((item) => item.insight_id)).toEqual(['ins_1', 'ins_old'])
    // 成功即清 marker（合法 200/202 才允许 clear）
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toEqual([])
  })

  it('同 insight_id 重复返回不产生重复行（按 id 合并幂等）', async () => {
    const { result, queryClient } = setup()
    queryClient.setQueryData<ResearchPage<ResearchInsight>>(
      QUERY_KEYS.researchInsights(PROJECT),
      { items: [insight('ins_1')], next_cursor: null },
    )
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}) as never)
    await act(async () => { await result.current.submit(input()) })
    const cached = queryClient.getQueryData<ResearchPage<ResearchInsight>>(
      QUERY_KEYS.researchInsights(PROJECT),
    )
    expect(cached?.items).toHaveLength(1)
  })

  it('202：登记 jobId（不宣称 Insight 已创建）+ 清 marker', async () => {
    const { result, onQueued, onCreated } = setup()
    vi.mocked(aiInsightOutcomeFromResponse).mockReturnValue({
      kind: 'queued', jobId: 'job_1', generationId: 'gen_2',
    })
    vi.mocked(createAiInsight).mockResolvedValue(http(202, {}) as never)

    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('queued')
    expect(onQueued).toHaveBeenCalledWith('job_1', 'gen_2')
    expect(onCreated).not.toHaveBeenCalled()
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toEqual([])
  })

  it('请求携带冻结 Scope/model/语言 + consent Scope 行同源', async () => {
    const { result } = setup()
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}) as never)
    await act(async () => { await result.current.submit(input({ sourceIds: ['s1', 's2'], noteIds: ['n1'], responseLanguage: 'zh' })) })
    expect(createAiInsight).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({
        insight_type: 'ai',
        context_level: 'focused',
        source_ids: ['s1', 's2'],
        note_ids: ['n1'],
        response_language: 'zh',
        model_id: 'm-ext',
      }),
      { idempotencyKey: 'ui-key-1' },
    )
  })

  it('空有效范围 → typed 阻断，零 POST、零 key、零 marker', async () => {
    const { result, onBlockedEmptyScope } = setup()
    let status = ''
    await act(async () => { status = await result.current.submit(input({ sourceIds: [], noteIds: [] })) })
    expect(status).toBe('blocked_empty_scope')
    expect(onBlockedEmptyScope).toHaveBeenCalled()
    expect(createAiInsight).not.toHaveBeenCalled()
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toEqual([])
  })
})

describe('marker 先写后发与失败分类', () => {
  it('marker 写入失败 → 不发送请求（FR-03）', async () => {
    const { result, onFailed } = setup()
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      let status = ''
      await act(async () => { status = await result.current.submit(input()) })
      expect(status).toBe('failed')
      expect(createAiInsight).not.toHaveBeenCalled()
      // 恰好一次：操作内通知 + submit 尾部重复通知曾造成两条相同 toast
      expect(onFailed).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('POST 前 marker 已存在（值只含四字段）', async () => {
    const { result } = setup()
    vi.mocked(createAiInsight).mockImplementation(async () => {
      // 请求发出时 marker 必须已在存储中
      const markers = listAiInsightRiskMarkers(USER, PROJECT)
      expect(markers).toHaveLength(1)
      expect(Object.keys(markers[0] as object).sort()).toEqual(['kind', 'markerId', 'recordedAt'])
      return http(200, {}) as never
    })
    await act(async () => { await result.current.submit(input()) })
    expect(createAiInsight).toHaveBeenCalledTimes(1)
  })

  it('未知结果（缺契约头 → outcome_unknown）→ 保留 marker 且暴露可重试 attempt', async () => {
    const { result, onOutcomeUnknown } = setup()
    vi.mocked(aiInsightOutcomeFromResponse).mockReturnValue({
      kind: 'outcome_unknown', reason: 'missing_contract_header',
    })
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}, {}) as never)

    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('outcome_unknown')
    expect(onOutcomeUnknown).toHaveBeenCalled()
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toHaveLength(1)
    expect(result.current.result.retryableAttempt).not.toBeNull()
  })

  it('幂等冲突（409）→ protocol_conflict，marker 升级为 recovery 且禁止自动重发', async () => {
    const { result, onProtocolConflict } = setup()
    vi.mocked(createAiInsight).mockRejectedValue({
      isAxiosError: true, response: { status: 409, data: { detail: 'idempotency conflict' }, headers: {} },
    })
    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('protocol_conflict')
    expect(onProtocolConflict).toHaveBeenCalled()
    const markers = listAiInsightRiskMarkers(USER, PROJECT)
    expect(markers.map((m) => m.kind)).toEqual(['recovery'])
    // 再次提交被 gate 拦住（未经确认不得开新执行）
    let again = ''
    await act(async () => { again = await result.current.submit(input()) })
    expect(again).toBe('protocol_conflict')
    expect(createAiInsight).toHaveBeenCalledTimes(1)
    expect(result.current.result.pendingMarker?.kind).toBe('recovery')
  })

  it('consent 失效（403 consent_scope_changed）→ 清 marker、丢弃 attempt（下次新 key）', async () => {
    const { result, onFailed } = setup()
    vi.mocked(createAiInsight).mockRejectedValue({
      isAxiosError: true, response: { status: 403, data: { detail: { code: 'consent_scope_changed' } }, headers: {} },
    })
    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('failed')
    expect(onFailed).toHaveBeenCalledWith('consent_scope_changed')
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toEqual([])
    expect(result.current.result.retryableAttempt).toBeNull()
  })

  it('网络失败（无响应）→ outcome_unknown，保留 marker 与 attempt 供同 key 重试', async () => {
    const { result } = setup()
    vi.mocked(createAiInsight).mockRejectedValueOnce({ isAxiosError: true, message: 'Network Error' })
    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('outcome_unknown')
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toHaveLength(1)

    // 同 key 重试：复用冻结请求与键（调用方可在表单上改动，不影响载荷）
    vi.mocked(createAiInsight).mockResolvedValueOnce(http(200, {}) as never)
    await act(async () => { await result.current.submit(input({ content: 'EDITED AFTER FAILURE' })) })
    expect(createAiInsight).toHaveBeenCalledTimes(2)
    const lastBody = vi.mocked(createAiInsight).mock.calls[1]?.[1]
    expect(lastBody?.content).toBe('Summarize the materials.')
    expect(vi.mocked(createAiInsight).mock.calls[1]?.[2]).toEqual({ idempotencyKey: 'ui-key-1' })
  })

  it('同 key 年龄 ≥24h → 拒绝重试并给出重复风险 marker', async () => {
    let clock = 0
    const { result } = setup({ now: () => clock })
    vi.mocked(createAiInsight).mockRejectedValueOnce({ isAxiosError: true, message: 'Network Error' })
    await act(async () => { await result.current.submit(input()) })
    expect(result.current.result.retryableAttempt).not.toBeNull()

    clock = 24 * 60 * 60 * 1000 // 到边界
    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('protocol_conflict')
    expect(result.current.result.pendingMarker).not.toBeNull()
    expect(createAiInsight).toHaveBeenCalledTimes(1)
  })
})

describe('consent 与生命周期', () => {
  it('consent 取消（dispatch 未执行 operation）→ 零 POST、零 key、零 marker', async () => {
    const deferredDispatch = vi.fn(async () => undefined)
    const { result } = setup({ dispatch: deferredDispatch as never })
    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('idle')
    expect(createAiInsight).not.toHaveBeenCalled()
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toEqual([])
  })

  it('consent 弹窗携带与请求同源的 Scope 摘要', async () => {
    const dispatch = vi.fn(async (operation: (modelId: string) => Promise<unknown>, options?: { scopeLabel?: string }) => {
      expect(options?.scopeLabel).toBe(scopeLabel)
      return operation('m-ext')
    })
    const { result } = setup({ dispatch: dispatch as never })
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}) as never)
    await act(async () => { await result.current.submit(input()) })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('已确认重复风险的旧 marker：新执行写入成功后清除（否则刷新后再次误拦）', async () => {
    const { result } = setup()
    // 预置他人 marker（模拟另一标签页/上次崩溃）+ 本项目另一枚未确认 marker
    localStorage.setItem(
      aiInsightRiskMarkerKey(USER, PROJECT, 'old-tab'),
      JSON.stringify({ version: 1, markerId: 'old-tab', kind: 'fresh', recordedAt: 1 }),
    )
    localStorage.setItem(
      aiInsightRiskMarkerKey(USER, PROJECT, 'other-tab'),
      JSON.stringify({ version: 1, markerId: 'other-tab', kind: 'fresh', recordedAt: 2 }),
    )
    let blocked = ''
    await act(async () => { blocked = await result.current.submit(input()) })
    expect(blocked).toBe('protocol_conflict')
    expect(createAiInsight).not.toHaveBeenCalled()

    act(() => { result.current.result.confirmDuplicateRisk() })
    // 多枚未确认 marker：确认第一枚后继续展示下一枚（不静默再拦）
    expect(result.current.result.pendingMarker?.markerId).toBe('other-tab')
    act(() => { result.current.result.confirmDuplicateRisk() })
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}) as never)
    let status = ''
    await act(async () => { status = await result.current.submit(input()) })
    expect(status).toBe('created')
    // H-2：已确认承担风险的 marker 在本轮新执行写入成功后清除（旧行为会让它
    // 永久残留；刷新后 riskAcknowledgedRef 归零 → 每次会话首派发都被误拦）
    // （未被确认过的 marker 本用例已一并纳入确认，故此处清空）
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toEqual([])
  })

  it('放弃重复风险 → 清除旧 marker 回到空闲', async () => {
    const { result } = setup()
    localStorage.setItem(
      aiInsightRiskMarkerKey(USER, PROJECT, 'old-tab'),
      JSON.stringify({ version: 1, markerId: 'old-tab', kind: 'fresh', recordedAt: 1 }),
    )
    await act(async () => { await result.current.submit(input()) })
    expect(result.current.result.pendingMarker?.markerId).toBe('old-tab')
    act(() => { result.current.result.discardDuplicateRisk() })
    expect(listAiInsightRiskMarkers(USER, PROJECT)).toEqual([])
    expect(result.current.result.status).toBe('idle')
  })

  it('卸载后返回的迟到 200 仍合并缓存，但不写组件状态', async () => {
    let resolveGate!: () => void
    const gate = new Promise<void>((resolve) => { resolveGate = resolve })
    const dispatch = vi.fn(async (operation: (modelId: string) => Promise<unknown>) => {
      await gate
      return operation('m-ext')
    })
    const { result, queryClient, unmount } = setup({ dispatch: dispatch as never })
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}) as never)

    let pending: Promise<string> | null = null
    await act(async () => { pending = result.current.submit(input()) })
    const statusBeforeUnmount = result.current.result.status
    expect(statusBeforeUnmount).toBe('dispatching')
    unmount()
    resolveGate()
    let finalStatus = ''
    await act(async () => { finalStatus = await (pending as unknown as Promise<string>) })
    expect(finalStatus).toBe('created')
    const cached = queryClient.getQueryData<ResearchPage<ResearchInsight>>(
      QUERY_KEYS.researchInsights(PROJECT),
    )
    expect(cached?.items.map((item) => item.insight_id)).toEqual(['ins_1'])
  })
})

describe('身份切换与跨标签页（评审 M-1 / L-5）', () => {
  it('M-1：切换项目后不得复用上一项目的冻结 attempt（载荷与目标都必须换新）', async () => {
    const { wrapper, queryClient } = makeWrapper()
    const dispatch = async <T,>(operation: (modelId: string) => Promise<T>) => operation('m-ext')
    const onCreated = vi.fn()
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useAiInsightSubmit({
          projectId, userId: USER, dispatch: dispatch as never, onCreated,
        }),
      { wrapper, initialProps: { projectId: 'proj_A' } },
    )
    vi.mocked(createAiInsight).mockResolvedValue(http(200, {}) as never)
    // 键工厂递增：否则两次尝试拿到同一个 mock 常量，无法判别是否重用了旧 key
    let keySeq = 0
    vi.mocked(newIdempotencyKey).mockImplementation(() => `ui-key-${++keySeq}`)

    await act(async () => {
      await result.current.submit(input({ sourceIds: ['src_A'] }))
    })
    expect(vi.mocked(createAiInsight).mock.calls[0]?.[0]).toBe('proj_A')
    expect(vi.mocked(createAiInsight).mock.calls[0]?.[1]?.source_ids).toEqual(['src_A'])

    // 切项目（同实例 rerender，不卸载）→ 旧 attempt 必须丢弃
    rerender({ projectId: 'proj_B' })
    await act(async () => {
      await result.current.submit(input({ sourceIds: ['src_B'] }))
    })
    const second = vi.mocked(createAiInsight).mock.calls[1]
    expect(second?.[0]).toBe('proj_B')
    expect(second?.[1]?.source_ids).toEqual(['src_B'])
    expect(second?.[2]?.idempotencyKey).not.toBe(
      vi.mocked(createAiInsight).mock.calls[0]?.[2]?.idempotencyKey,
    )
    void queryClient
  })

  it('L-5：他标签页写入 marker → storage 事件后 pendingMarker 实时可见', async () => {
    const { result } = setup()
    expect(result.current.result.pendingMarker).toBeNull()

    localStorage.setItem(
      aiInsightRiskMarkerKey(USER, PROJECT, 'other-tab'),
      JSON.stringify({ version: 1, markerId: 'other-tab', kind: 'fresh', recordedAt: 5 }),
    )
    act(() => { window.dispatchEvent(new StorageEvent('storage')) })

    expect(result.current.result.pendingMarker?.markerId).toBe('other-tab')
  })
})
