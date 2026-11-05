/**
 * Issue #1016（D1-G）主题概览读/写 hook 测试（计划 §2.9/§4.2 step 2、
 * §5.2 F-01/F-03/F-03b/F-07/F-09）。
 *
 * 替身位置：**axios adapter 级**（沿 `api.v1.test.ts` 先例）。hooks 走真实
 * `@/lib/research/api` 与真实 wire 解析器，因此同一文件同时覆盖 API 层契约：
 * - `getTopicOverview`：404 `topic_overview_not_found` → `null`（空态，不算
 *   error）；其它 404 / 503 → 抛错（不把故障伪装成空态）；
 * - `createTopicOverview`：`X-Research-Contract: c05-v1` + `Idempotency-Key`；
 *   无 202 分支（200 JSON 直接归一，畸形/非法体 fail-closed）；
 * - hooks：能力位严格 `=== true` 且与模型目录共享 query key/缓存；读面
 *   `staleTime: 0`、`retry: false`、尾随身份段 query key；mutation 每次新幂等键、
 *   失败不自动重试（即使全局 mutation 默认 retry>0）、成功后刷新读缓存。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { InternalAxiosRequestConfig } from 'axios'
import type { ReactNode } from 'react'
import { apiClient } from '@/lib/api/client'
import {
  QUERY_KEYS,
  ownerResearchIdentity,
  researchModelCatalogIdentityKey,
  researchTopicOverviewIdentityKey,
} from '@/lib/api/query-client'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import type { C05RequestScope } from '@/lib/research/c05-request'
import {
  useGenerateTopicOverview,
  useResearchTopicOverview,
  useResearchTopicOverviewCapability,
} from './use-research-topic-overview'

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: vi.fn(() => true),
  getEmbeddedGatewayUrl: vi.fn(() => 'https://gateway.example.com'),
}))

vi.mock('@/lib/embedded/token-store', () => ({
  getResearchToken: vi.fn(() => 'memory-token'),
}))

const PROJECT = 'p1'
const MODELS_URL = `/v1/research/projects/${PROJECT}/models`
const OVERVIEW_URL = `/v1/research/projects/${PROJECT}/topic-overview`

interface Captured {
  url: string
  method: string
  data?: unknown
  headers: Record<string, unknown>
}

interface AdapterOutcome {
  status: number
  data: unknown
}

const calls: Captured[] = []
let responder: (config: InternalAxiosRequestConfig) => AdapterOutcome

/** 非 2xx：抛带 `response.status/data` 的错误（供 `researchApiErrorDetail` 读取）。 */
function httpError(status: number, data: unknown): Error {
  const error = new Error(`http_${status}`) as Error & { response?: unknown }
  error.response = {
    status,
    statusText: '',
    data,
    headers: { 'content-type': 'application/json' },
    config: {},
  }
  return error
}

/** GET .../topic-overview */
function getOverviewCalls(): Captured[] {
  return calls.filter((call) => call.method === 'GET' && call.url === OVERVIEW_URL)
}

/** POST .../topic-overview */
function postOverviewCalls(): Captured[] {
  return calls.filter((call) => call.method === 'POST' && call.url === OVERVIEW_URL)
}

function getModelsCalls(): Captured[] {
  return calls.filter((call) => call.method === 'GET' && call.url === MODELS_URL)
}

/** 最小合法 wire（解析器容错缺失可选键；身份键齐全）。 */
function overviewEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'd1g-topic-overview-v1',
    request_id: 'req_h',
    overview: {
      overview_id: 'ovw_h',
      generation_id: 'gen_h',
      generated_at: '2026-11-05T10:00:00+00:00',
      generation_created_at: '2026-11-05T09:55:00+00:00',
      focus: null,
      visibility: 'ready',
      content_markdown: '正文',
      sections: null,
      citations: [],
      scope: {
        mode: 'selected',
        contract_version: 'c05-v1',
        includes_exact_versions: true,
        captured_at: '2026-11-05T09:55:00+00:00',
        source_count: 1,
        refs_truncated: false,
        sources: [{ document_id: 'doc_a', document_version: 'v1', source_id: 'src_a' }],
        missing_source_ids: [],
        single_source_id: null,
      },
      processing: {
        resolved_mode: 'hybrid_rag',
        evidence_chunk_count: 1,
        citation_count: 0,
        citations_total: 0,
        citations_dropped: 0,
        evidence_modalities: { text: 1, table: 0, figure: 0, mixed: 0 },
        coverage: null,
        included_sources: [],
        degradations: [],
        degradation_reason: null,
        evidence_degraded: null,
        full_text_read: false,
      },
      model: { model_id: 'm_local', provider_id: 'p_local' },
      purpose: { work_purpose: 'document_qa', work_purpose_source: 'default_legacy' },
      limitations: ['full_text_not_read'],
      warnings: [],
      ...overrides,
    },
  }
}

let queryClient: QueryClient

function ownerWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider
        projectId={PROJECT}
        role="owner"
        userId="u1"
        authGeneration={3}
      >
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

function plainWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const SELECTED_SCOPE: C05RequestScope = {
  mode: 'selected',
  sourceIds: ['s1', 's2'],
  noteIds: [],
}

function cacheKeys(): readonly (readonly unknown[])[] {
  return queryClient.getQueryCache().getAll().map((query) => query.queryKey)
}

beforeEach(() => {
  calls.length = 0
  responder = () => ({ status: 200, data: { models: [] } })
  apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const raw = config.data
    calls.push({
      url: String(config.url),
      method: String(config.method ?? 'get').toUpperCase(),
      data: typeof raw === 'string' ? JSON.parse(raw) : raw,
      headers: (config.headers ?? {}) as Record<string, unknown>,
    })
    const outcome = responder(config)
    if (outcome.status >= 400) throw httpError(outcome.status, outcome.data)
    return {
      data: outcome.data,
      status: outcome.status,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      config,
    }
  }
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

describe('useResearchTopicOverviewCapability', () => {
  it('capabilities.topic_overview 严格 true → 启用；与模型目录共享 query key/缓存', async () => {
    responder = () => ({
      status: 200,
      data: { models: [], capabilities: { topic_overview: true } },
    })
    // 两个消费方（入口 + Dialog）挂载同一 capability hook：只发一次 models 请求。
    const first = renderHook(() => useResearchTopicOverviewCapability(PROJECT), {
      wrapper: ownerWrapper,
    })
    const second = renderHook(() => useResearchTopicOverviewCapability(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(first.result.current).toBe(true))
    await waitFor(() => expect(second.result.current).toBe(true))
    expect(getModelsCalls()).toHaveLength(1)

    // 与模型目录同 key（尾随身份段），不新增请求、不新增缓存分区。
    expect(cacheKeys()).toContainEqual(
      researchModelCatalogIdentityKey(ownerResearchIdentity(PROJECT, 'u1', 3)),
    )
  })

  it('缺失 / 字符串 / 数字 / false → 关闭（fail-closed）', async () => {
    const cases: unknown[] = [
      { models: [] },
      { models: [], capabilities: {} },
      { models: [], capabilities: { topic_overview: 'true' } },
      { models: [], capabilities: { topic_overview: 1 } },
      { models: [], capabilities: { topic_overview: false } },
    ]
    for (const data of cases) {
      responder = () => ({ status: 200, data })
      const { result, unmount } = renderHook(
        () => useResearchTopicOverviewCapability(PROJECT),
        { wrapper: ownerWrapper },
      )
      await waitFor(() => expect(getModelsCalls().length).toBeGreaterThan(0))
      expect(result.current).toBe(false)
      unmount()
    }
  })
})

describe('useResearchTopicOverview', () => {
  it('404 topic_overview_not_found → data null 且非 error（空态 ≠ 故障）', async () => {
    responder = () => ({
      status: 404,
      data: { detail: { code: 'topic_overview_not_found', message: 'no overview' } },
    })
    const { result } = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
    expect(result.current.isError).toBe(false)
    expect(result.current.error).toBeNull()
    expect(getOverviewCalls()).toHaveLength(1)
  })

  it('其它 404（如项目不可见）不伪装成空态 → error', async () => {
    responder = () => ({
      status: 404,
      data: { detail: { code: 'project_not_found', message: 'not found' } },
    })
    const { result } = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('503 topic_overview_store_unavailable → error，且只请求一次（retry:false，不重试风暴）', async () => {
    responder = () => ({
      status: 503,
      data: {
        detail: { code: 'topic_overview_store_unavailable', message: 'store unavailable' },
      },
    })
    const { result } = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(getOverviewCalls()).toHaveLength(1)
  })

  it('200 ready → 归一化 wire；200 畸形体（缺身份键）→ error（不伪造空态）', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const ready = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(ready.result.current.isSuccess).toBe(true))
    expect(ready.result.current.data?.overview_id).toBe('ovw_h')
    expect(ready.result.current.data?.visibility).toBe('ready')
    ready.unmount()

    responder = () => ({
      status: 200,
      data: {
        schema_version: 'd1g-topic-overview-v1',
        request_id: 'req_bad',
        overview: { visibility: 'ready', content_markdown: 'x' },
      },
    })
    const malformed = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(malformed.result.current.isError).toBe(true))
  })

  it('visibility=restricted → wire 保留受限投影（正文 null、引用空）', async () => {
    responder = () => ({
      status: 200,
      data: overviewEnvelope({
        visibility: 'restricted',
        content_markdown: null,
        citations: [],
        limitations: ['content_restricted'],
        warnings: ['content_restricted'],
      }),
    })
    const { result } = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.visibility).toBe('restricted')
    expect(result.current.data?.content_markdown).toBeNull()
    expect(result.current.data?.citations).toEqual([])
  })

  it('enabled:false → 不发起请求（Dialog 关闭时不加载）', async () => {
    const { result } = renderHook(
      () => useResearchTopicOverview(PROJECT, { enabled: false }),
      { wrapper: ownerWrapper },
    )
    expect(result.current.fetchStatus).toBe('idle')
    expect(getOverviewCalls()).toHaveLength(0)
  })

  it('工作台内使用尾随身份段 query key；data 立即 stale（staleTime: 0，回访按最新权限读）', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const { result } = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const expectedKey = researchTopicOverviewIdentityKey(
      ownerResearchIdentity(PROJECT, 'u1', 3),
    )
    expect(cacheKeys()).toContainEqual(expectedKey)
    const query = queryClient.getQueryCache().find({ queryKey: expectedKey })
    expect(query?.isStale()).toBe(true)
  })

  it('无工作台上下文（孤立渲染）→ 沿用非判别键', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const { result } = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: plainWrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(cacheKeys()).toContainEqual(
      QUERY_KEYS.researchTopicOverview(PROJECT),
    )
  })
})

describe('useGenerateTopicOverview', () => {
  function readyMutation(overrides: Record<string, unknown> = {}) {
    return {
      focus: '关注 A？',
      modelId: 'm_local',
      scope: SELECTED_SCOPE,
      ...overrides,
    }
  }

  it('POST 携带 c05-v1 契约头 + Idempotency-Key；请求体含 focus、不含 query；200 直接归一（无 202 分支）', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const { result } = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    let overview: { overview_id: string } | undefined
    await act(async () => {
      overview = await result.current.mutateAsync(readyMutation())
    })
    expect(overview?.overview_id).toBe('ovw_h')

    expect(postOverviewCalls()).toHaveLength(1)
    const call = postOverviewCalls()[0]
    expect(String(call.headers['X-Research-Contract'])).toBe('c05-v1')
    const idempotencyKey = String(call.headers['Idempotency-Key'])
    expect(idempotencyKey.startsWith('ui-')).toBe(true)
    expect(call.data).toEqual({
      focus: '关注 A？',
      model_id: 'm_local',
      work_purpose: 'document_qa',
      source_scope: {
        mode: 'selected',
        source_ids: ['s1', 's2'],
        single_source_id: null,
      },
      note_ids: [],
    })
    const body = call.data as Record<string, unknown>
    expect(body).not.toHaveProperty('query')
    expect(body).not.toHaveProperty('source_ids')
    expect(body).not.toHaveProperty('mode')
    expect(body).not.toHaveProperty('context_level')
  })

  it('202/Job 受理形态不视为成功（无 202 分支，fail-closed 抛错）', async () => {
    responder = () => ({
      status: 202,
      data: {
        request_id: 'req_job',
        generation_id: 'gen_job',
        job_id: 'job_1',
        status: 'queued',
      },
    })
    const { result } = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await act(async () => {
      await expect(result.current.mutateAsync(readyMutation()))
        .rejects.toThrowError('invalid_topic_overview_response')
    })
  })

  it('每次 mutate/mutateAsync 生成新的 Idempotency-Key（换新键重试语义）', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const { result } = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await act(async () => {
      await result.current.mutateAsync(readyMutation({ focus: '第一次' }))
      await result.current.mutateAsync(readyMutation({ focus: '第二次' }))
    })
    const posts = postOverviewCalls()
    expect(posts).toHaveLength(2)
    const firstKey = String(posts[0].headers['Idempotency-Key'])
    const secondKey = String(posts[1].headers['Idempotency-Key'])
    expect(firstKey).not.toBe('')
    expect(secondKey).not.toBe('')
    expect(firstKey).not.toBe(secondKey)
  })

  it('response_language 仅在 variables 提供时进入请求体', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const { result } = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await act(async () => {
      await result.current.mutateAsync(readyMutation({ responseLanguage: 'en' }))
    })
    expect((postOverviewCalls()[0].data as Record<string, unknown>).response_language)
      .toBe('en')
  })

  it('空 selected fail-closed：mutation 报错且零 POST（不扩大为 all）', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const { result } = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          ...readyMutation(),
          scope: { mode: 'selected', sourceIds: [], noteIds: [] },
        }),
      ).rejects.toThrowError('c05_request_empty_selected')
    })
    expect(postOverviewCalls()).toHaveLength(0)
  })

  it('失败不自动重试（全局 mutation 默认 retry:2 时仍只派发一次）', async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: 2 } },
    })
    responder = () => ({
      status: 503,
      data: {
        detail: { code: 'topic_overview_store_unavailable', message: 'store unavailable' },
      },
    })
    const { result } = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await act(async () => {
      await expect(result.current.mutateAsync(readyMutation())).rejects.toBeTruthy()
    })
    expect(postOverviewCalls()).toHaveLength(1)
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it('mutationKey 稳定（供 Entry 用 useIsMutating 观测全局「生成中」）', async () => {
    responder = () => ({ status: 200, data: overviewEnvelope() })
    const { result } = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await act(async () => {
      await result.current.mutateAsync(readyMutation())
    })
    const mutations = queryClient.getMutationCache().getAll()
    expect(mutations).toHaveLength(1)
    expect(mutations[0].options.mutationKey).toEqual([
      'research',
      PROJECT,
      'topic-overview',
      'generate',
    ])
  })

  it('成功后刷新读缓存：Entry 的 GET 状态立即变为「已有概览」（setQueriesData + invalidate 权威重读）', async () => {
    let generated = false
    responder = (config) => {
      if (config.url === OVERVIEW_URL && String(config.method).toUpperCase() === 'GET') {
        return generated
          ? { status: 200, data: overviewEnvelope() }
          : {
            status: 404,
            data: { detail: { code: 'topic_overview_not_found', message: 'no overview' } },
          }
      }
      if (config.url === OVERVIEW_URL && String(config.method).toUpperCase() === 'POST') {
        generated = true
        return { status: 200, data: overviewEnvelope() }
      }
      return { status: 200, data: { models: [] } }
    }
    const read = renderHook(() => useResearchTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true))
    expect(read.result.current.data).toBeNull()

    const generate = renderHook(() => useGenerateTopicOverview(PROJECT), {
      wrapper: ownerWrapper,
    })
    await act(async () => {
      await generate.result.current.mutateAsync(readyMutation())
    })
    await waitFor(() =>
      expect(read.result.current.data?.overview_id).toBe('ovw_h'))
    // invalidate 触发权威重读（首读 404 + 生成后重读 200）。
    await waitFor(() => expect(getOverviewCalls().length).toBeGreaterThanOrEqual(2))
  })
})
