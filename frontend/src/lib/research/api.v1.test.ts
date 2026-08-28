/**
 * Issue #200 Phase 2b：Research Contract v1 API 客户端（§14.2/§14.3）。
 *
 * 契约：
 * - 生成请求发送 `X-Research-Contract: v1` + `Idempotency-Key`；
 * - 按 HTTP status + Content-Type 分支：200 JSON = direct，202 JSON =
 *   background job（不能只看 body 字段）；
 * - 模型列表（含 interactive_context_levels）/ 执行偏好 GET/PATCH /
 *   Context Preview 端点路径。
 *
 * Issue #243 GMOD-FE-01：
 * - 保存模型只 PATCH preferred_model_id；保存 Search 上下文只 PATCH
 *   default_context_level（互不覆盖，§6.1）；
 * - Preview / Chat / Compare / Transformation Run 的 TS 请求 builders 把
 *   model_id 建模为 required（§6.7：不得依赖 undefined 触发旧默认）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalAxiosRequestConfig } from 'axios'
import { apiClient } from '@/lib/api/client'
import * as researchApi from './api'

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: vi.fn(() => true),
  getEmbeddedGatewayUrl: vi.fn(() => 'https://gateway.example.com'),
}))

vi.mock('@/lib/embedded/token-store', () => ({
  getResearchToken: vi.fn(() => 'memory-token'),
}))

interface Captured {
  url: string
  method: string
  data?: unknown
  headers: Record<string, unknown>
  status: number
}

const calls: Captured[] = []

function installAdapter(responder: (config: InternalAxiosRequestConfig) => {
  status: number
  data: unknown
  contentType?: string
}) {
  apiClient.defaults.adapter = async (config) => {
    const raw = config.data
    const captured: Captured = {
      url: String(config.url),
      method: String(config.method ?? 'get').toUpperCase(),
      data: typeof raw === 'string' ? JSON.parse(raw) : raw,
      headers: (config.headers ?? {}) as Record<string, unknown>,
      status: 0,
    }
    calls.push(captured)
    const outcome = responder(config)
    captured.status = outcome.status
    return {
      data: outcome.data,
      status: outcome.status,
      statusText: 'OK',
      headers: { 'content-type': outcome.contentType ?? 'application/json' },
      config,
    }
  }
}

const P = 'proj_1'

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('contract v1 客户端（Phase 2b）', () => {
  it('listModels 命中 models 端点', async () => {
    installAdapter(() => ({ status: 200, data: { models: [] } }))
    await researchApi.listModels(P)
    expect(calls[0].url).toBe(`/v1/research/projects/${P}/models`)
    expect(calls[0].method).toBe('GET')
  })

  it('execution-preferences GET/PATCH 路径正确；PATCH 只发送出现的字段', async () => {
    installAdapter(() => ({
      status: 200,
      data: {
        project_id: P,
        default_context_level: 'focused',
        preferred_model_id: null,
        updated_by: null,
        updated_at: null,
      },
    }))
    await researchApi.getExecutionPreferences(P)
    // 保存模型：只 PATCH preferred_model_id（不触碰 context，§6.1）
    await researchApi.patchExecutionPreferences(P, {
      preferred_model_id: 'm-local',
    })
    // 显式清除：preferred_model_id: null 原样透传（后端区分缺失 vs null）
    await researchApi.patchExecutionPreferences(P, {
      preferred_model_id: null,
    })
    // 保存 Search 上下文：只 PATCH default_context_level（不触碰模型）
    await researchApi.patchExecutionPreferences(P, {
      default_context_level: 'document',
    })
    const path = `/v1/research/projects/${P}/execution-preferences`
    expect(calls[0].url).toBe(path)
    expect(calls[0].method).toBe('GET')
    expect(calls[1].url).toBe(path)
    expect(calls[1].method).toBe('PATCH')
    expect(calls[1].data).toEqual({ preferred_model_id: 'm-local' })
    expect(calls[2].method).toBe('PATCH')
    expect(calls[2].data).toEqual({ preferred_model_id: null })
    expect(calls[3].method).toBe('PATCH')
    expect(calls[3].data).toEqual({ default_context_level: 'document' })
  })

  it('contextPreview POST 只读端点；model_id 为 required（GMOD §6.7）', async () => {
    installAdapter(() => ({ status: 200, data: { source_count: 1 } }))
    await researchApi.fetchContextPreview(P, {
      context_level: 'focused',
      source_ids: ['d1'],
      note_ids: [],
      question: 'q',
      model_id: 'm-local',
    })
    expect(calls[0].url).toBe(
      `/v1/research/projects/${P}/context-preview`,
    )
    expect(calls[0].method).toBe('POST')
    expect(calls[0].data).toEqual({
      context_level: 'focused',
      source_ids: ['d1'],
      note_ids: [],
      question: 'q',
      model_id: 'm-local',
    })
  })

  it('searchV1 携带 v1 头与 Idempotency-Key；200 JSON 归类 direct', async () => {
    installAdapter(() => ({
      status: 200,
      data: {
        request_id: 'r1',
        generation_id: 'gen_1',
        resolved_mode: 'direct_context',
        evidence: [],
        citations: [],
        usage: { input_tokens: 1, output_tokens: 1, estimated: true },
        degradation_reason: null,
        conclusion: 'ok',
        context_coverage: { context_level: 'focused', input_budget: 65536 },
      },
    }))
    const outcome = await researchApi.searchV1(P, {
      query: 'what is ORR?',
      source_ids: ['d1'],
      model_id: 'm-local',
      context_level: 'focused',
    })
    expect(outcome.kind).toBe('direct')
    expect(calls[0].url).toBe(`/v1/research/projects/${P}/search`)
    expect(String(calls[0].headers['X-Research-Contract'])).toBe('v1')
    const key = String(calls[0].headers['Idempotency-Key'])
    expect(key.length).toBeGreaterThan(8)
    expect((calls[0].data as Record<string, unknown>).model_id).toBe(
      'm-local',
    )
  })

  it('searchV1 对 202 后台响应归类 background 并携带 job_id', async () => {
    installAdapter(() => ({
      status: 202,
      data: {
        request_id: 'r2',
        generation_id: 'gen_2',
        job_id: 'job_9',
        status: 'queued',
        resolved_mode: 'planned_rag',
        evidence: [],
        citations: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        degradation_reason: null,
      },
    }))
    const outcome = await researchApi.searchV1(P, {
      query: 'q',
      model_id: 'm-local',
      context_level: 'document',
    })
    expect(outcome.kind).toBe('background')
    if (outcome.kind === 'background') {
      expect(outcome.job_id).toBe('job_9')
      expect(outcome.generation_id).toBe('gen_2')
    }
  })

  it('非 JSON 的 200 响应 fail-closed 抛错（§14.3 Content-Type 双条件）', async () => {
    installAdapter(() => ({
      status: 200,
      data: '<html>gateway error page</html>',
      contentType: 'text/html',
    }))
    await expect(
      researchApi.searchV1(P, {
        query: 'q',
        model_id: 'm-local',
        context_level: 'focused',
      }),
    ).rejects.toThrow('content-type')
  })

  it('非 200/202 的 2xx 抛错而非兜底归类', async () => {
    installAdapter(() => ({ status: 204, data: '' }))
    await expect(
      researchApi.searchV1(P, {
        query: 'q',
        model_id: 'm-local',
        context_level: 'focused',
      }),
    ).rejects.toThrow('status: 204')
  })

  it('searchV1 显式 idempotencyKey 复用调用方给定值', async () => {
    installAdapter(() => ({ status: 200, data: {} }))
    await researchApi.searchV1(
      P,
      { query: 'q', model_id: 'm', context_level: 'focused' },
      { idempotencyKey: 'fixed-key' },
    )
    expect(String(calls[0].headers['Idempotency-Key'])).toBe('fixed-key')
  })

  it('#238 createCompare 带 v1 头 + 幂等键 + model_id 透传', async () => {
    installAdapter(() => ({
      status: 202,
      data: { job_id: 'job_1', status: 'queued' },
    }))
    await researchApi.createCompare(
      P,
      { job_type: 'deep_compare', document_ids: ['d1'], model_id: 'm1' },
      { idempotencyKey: 'ik-1' },
    )
    expect(calls[0].url).toBe(`/v1/research/projects/${P}/compare/jobs`)
    expect(calls[0].method).toBe('POST')
    expect(String(calls[0].headers['X-Research-Contract'])).toBe('v1')
    expect(String(calls[0].headers['Idempotency-Key'])).toBe('ik-1')
    expect((calls[0].data as { model_id?: string }).model_id).toBe('m1')
  })

  it('#243 runTransformation 请求体携带 required model_id（运行时模型快照）', async () => {
    installAdapter(() => ({ status: 200, data: { request_id: 'r1' } }))
    await researchApi.runTransformation(P, 'trans_1', {
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-global',
    })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe(
      `/v1/research/projects/${P}/transformations/trans_1/run`,
    )
    expect(calls[0].data).toEqual({
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-global',
    })
  })
})
