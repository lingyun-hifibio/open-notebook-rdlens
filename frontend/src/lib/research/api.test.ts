import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api/client'
import * as researchApi from './api'
import { coverageAllSelectedFrom } from './types'

// UI-02 Red：Research Gateway API 模块（契约 v0 §6/§7/§9，REQ-API-01、
// REQ-DIS-01/02/03、REQ-SRC-04）——全部请求经 UI-01 apiClient（嵌入式
// baseURL 只指向 Gateway），路径精确匹配白名单，保存 Note 永不触发
// Embedding，Transformation 只走 Gateway run 端点（prompt-only 字段）。

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
  params?: Record<string, unknown>
  data?: unknown
  headers?: Record<string, string>
}

const calls: Captured[] = []

async function capture(fn: () => Promise<unknown>): Promise<Captured> {
  const before = calls.length
  await fn()
  return calls[before]
}

function installAdapter() {
  apiClient.defaults.adapter = async (config) => {
    // axios 在 interceptor 之后、adapter 之前已序列化 JSON body
    const raw = config.data
    calls.push({
      url: String(config.url),
      method: String(config.method ?? 'get').toUpperCase(),
      params: config.params as Record<string, unknown> | undefined,
      data: typeof raw === 'string' ? JSON.parse(raw) : raw,
      headers: (config.headers ?? {}) as Record<string, string>,
    })
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
  }
}

const P = 'proj_1'

describe('researchApi（Gateway 白名单契约）', () => {
  beforeEach(() => {
    calls.length = 0
    installAdapter()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('listSources → GET /v1/research/projects/{project}/sources（非 /api 上游路径）', async () => {
    const captured = await capture(() => researchApi.listSources(P))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/sources`)
    expect(captured.url.startsWith('/api/')).toBe(false)
  })

  it('listSources 支持 cursor/limit 分页参数（RWV2-12 枚举 entire_project 用）', async () => {
    const captured = await capture(() =>
      researchApi.listSources(P, { limit: 100, cursor: 'c_aGVsbG8' }),
    )
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/sources`)
    expect(captured.params).toEqual({ limit: 100, cursor: 'c_aGVsbG8' })
  })

  it('getSource → GET .../sources/{source_id}', async () => {
    const captured = await capture(() => researchApi.getSource(P, 'src_1'))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/sources/src_1`)
  })

  it('createNote → POST .../notes，载荷仅 title/content（无 Embedding 字段，REQ-DIS-01）', async () => {
    const captured = await capture(() => researchApi.createNote(P, { title: 't', content: 'c' }))
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe(`/v1/research/projects/${P}/notes`)
    expect(captured.data).toEqual({ title: 't', content: 'c' })
  })

  it('listNotes → GET .../notes 携带 q/cursor 查询参数', async () => {
    const captured = await capture(() => researchApi.listNotes(P, { q: 'keyword', cursor: 'abc' }))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/notes`)
    expect(captured.params).toEqual({ q: 'keyword', cursor: 'abc' })
  })

  it('updateNote → PATCH .../notes/{note_id}；deleteNote → DELETE', async () => {
    const patched = await capture(() => researchApi.updateNote(P, 'note_1', { title: 't2' }))
    expect(patched.method).toBe('PATCH')
    expect(patched.url).toBe(`/v1/research/projects/${P}/notes/note_1`)
    expect(patched.data).toEqual({ title: 't2' })
    const deleted = await capture(() => researchApi.deleteNote(P, 'note_1'))
    expect(deleted.method).toBe('DELETE')
    expect(deleted.url).toBe(`/v1/research/projects/${P}/notes/note_1`)
  })

  it('createInsight → POST .../insights（manual 不带 model_id；ai 携带）', async () => {
    const manual = await capture(() => researchApi.createInsight(P, { title: 't', content: 'c', insight_type: 'manual' }))
    expect(manual.url).toBe(`/v1/research/projects/${P}/insights`)
    expect(manual.data).toEqual({ title: 't', content: 'c', insight_type: 'manual' })
    const ai = await capture(() => researchApi.createInsight(P, { title: 't', content: 'c', insight_type: 'ai', model_id: 'qwen3.6' }))
    expect(ai.data).toEqual({ title: 't', content: 'c', insight_type: 'ai', model_id: 'qwen3.6' })
  })

  it('createTransformation 载荷仅 prompt-only 四字段（无 code/tool/url，REQ-DIS-03）', async () => {
    const captured = await capture(() => researchApi.createTransformation(P, {
      name: 'summarize',
      prompt_template: '请总结',
      model_id: 'qwen3.6-35b-a3b-fp8',
      scope: 'project_private',
    }))
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe(`/v1/research/projects/${P}/transformations`)
    expect(captured.data).toEqual({
      name: 'summarize',
      prompt_template: '请总结',
      model_id: 'qwen3.6-35b-a3b-fp8',
      scope: 'project_private',
    })
  })

  it('runTransformation → POST .../transformations/{id}/run，输入 source_ids/note_ids + 运行时 model_id + v1 契约头 + 幂等键（REQ-DIS-02；#243 §6.7 model_id 为 required；v1 契约 Phase 6）', async () => {
    const captured = await capture(() => researchApi.runTransformation(P, 'trans_1', {
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-global',
    }))
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe(`/v1/research/projects/${P}/transformations/trans_1/run`)
    expect(captured.data).toEqual({
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-global',
    })
    expect(captured.headers?.['X-Research-Contract']).toBe('v1')
    // Rerun 为新派发：每次新 `ui-` 前缀幂等键（后端重放/409 语义见 #330 备忘）
    expect(captured.headers?.['Idempotency-Key']).toMatch(/^ui-/)
  })

  it('runTransformation 幂等键可由调用方显式提供（Rerun 新键前端接线；同键重试=后端幂等）', async () => {
    const captured = await capture(() => researchApi.runTransformation(P, 'trans_1', {
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-global',
    }, { idempotencyKey: 'ui-key-rerun-1' }))
    expect(captured.headers?.['Idempotency-Key']).toBe('ui-key-rerun-1')
  })

  it('listTransformationResults → GET .../transformation-results?cursor&limit，响应解包 ResearchPage（RWV2-20）', async () => {
    const captured = await capture(() =>
      researchApi.listTransformationResults(P, { cursor: 'c1', limit: 20 }),
    )
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/transformation-results`)
    expect(captured.params).toEqual({ cursor: 'c1', limit: 20 })
  })

  it('getTransformationResult → GET .../transformation-results/{result_id}（RWV2-20）', async () => {
    const captured = await capture(() => researchApi.getTransformationResult(P, 'tres_api3'))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/transformation-results/tres_api3`)
  })

  it('runTransformation：RWV2-35 双语变体显式 response_language=zh → 请求体携带（单 prompt 缺省不发送）', async () => {
    const captured = await capture(() => researchApi.runTransformation(P, 'trans_1', {
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-global',
      response_language: 'zh',
    }))
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe(`/v1/research/projects/${P}/transformations/trans_1/run`)
    expect(captured.data).toEqual({
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-global',
      response_language: 'zh',
    })
  })

  it('createExport → GET .../export?artifacts=note,insight,transformation_result', async () => {
    const captured = await capture(() => researchApi.createExport(P))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/export`)
    expect(captured.params).toEqual({ artifacts: 'note,insight,transformation_result' })
  })

  it('downloadExport → GET 下载路径，blob 响应', async () => {
    const captured = await capture(() => researchApi.downloadExport(P, '/v1/research/projects/proj_1/export/exp_1/file'))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/export/exp_1/file`)
  })

  it('所有端点均未使用 /api 前缀（REQ-DEP-02：浏览器只访问 Gateway）', async () => {
    await researchApi.listSources(P)
    await researchApi.listNotes(P, {})
    await researchApi.listTransformations(P, {})
    await researchApi.listInsights(P, {})
    for (const call of calls) {
      expect(call.url.startsWith('/api/')).toBe(false)
      expect(call.url.startsWith('/v1/research/')).toBe(true)
    }
  })
})

// ── COV-09：Coverage 提交 / 报告读取 / 人工重试（COV-08 §12.1/§12.2） ──

describe('researchApi coverage（COV-09）', () => {
  beforeEach(() => {
    calls.length = 0
    installAdapter()
  })

  it('createCoverageChat → POST /chat 携带 synthesis_scope=all_selected + v1 契约头', async () => {
    const captured = await capture(() =>
      researchApi.createCoverageChat(
        P,
        {
          query: '覆盖全部所选来源',
          source_ids: ['src-1', 'src-2'],
          note_ids: [],
          model_id: 'm-local',
          synthesis_scope: 'all_selected',
        },
        'ui-key-1',
      ),
    )
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe(`/v1/research/projects/${P}/chat`)
    expect(captured.data).toMatchObject({
      query: '覆盖全部所选来源',
      source_ids: ['src-1', 'src-2'],
      note_ids: [],
      model_id: 'm-local',
      synthesis_scope: 'all_selected',
    })
    const headers = captured.headers as Record<string, string> | undefined
    expect(headers?.['X-Research-Contract']).toBe('v1')
    expect(headers?.['Idempotency-Key']).toBe('ui-key-1')
  })

  it('getCoverageReport → GET .../jobs/{id}/report（渲染完成后只读）', async () => {
    const captured = await capture(() => researchApi.getCoverageReport(P, 'job_1'))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/jobs/job_1/report`)
  })

  it('getCompareReport → 同一 report 端点（#307 deep_compare 分支）', async () => {
    const captured = await capture(() => researchApi.getCompareReport(P, 'job_1'))
    expect(captured.method).toBe('GET')
    expect(captured.url).toBe(`/v1/research/projects/${P}/jobs/job_1/report`)
  })

  it('retryCoverageJob → POST .../jobs/{id}/retry 确认计费风险 + 新幂等键', async () => {
    const captured = await capture(() => researchApi.retryCoverageJob(P, 'job_1', 'ui-key-2'))
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe(`/v1/research/projects/${P}/jobs/job_1/retry`)
    expect(captured.data).toEqual({ confirm_billing_risk: true })
    const headers = captured.headers as Record<string, string> | undefined
    expect(headers?.['X-Research-Contract']).toBe('v1')
    expect(headers?.['Idempotency-Key']).toBe('ui-key-2')
  })

  it('coverage 端点均未使用 /api 前缀（REQ-DEP-02）', async () => {
    await researchApi.createCoverageChat(
      P, { query: 'q', source_ids: ['s'], note_ids: [], model_id: 'm', synthesis_scope: 'all_selected' }, 'k',
    )
    await researchApi.getCoverageReport(P, 'job_1')
    await researchApi.retryCoverageJob(P, 'job_1', 'k2')
    for (const call of calls) {
      expect(call.url.startsWith('/api/')).toBe(false)
      expect(call.url.startsWith('/v1/research/')).toBe(true)
    }
  })
})

// ── #358：结构化错误解析（detail.code/detail.message，替代通用 Axios 503） ──

describe('researchApiErrorDetail（#358）', () => {
  it('FastAPI HTTPException detail 对象 → code + message', () => {
    const error = Object.assign(new Error('Request failed with status code 503'), {
      response: {
        data: {
          detail: {
            code: 'coverage_not_enabled',
            message: 'research coverage is not enabled; relevant synthesis remains available',
          },
        },
      },
    })
    expect(researchApi.researchApiErrorDetail(error)).toEqual({
      code: 'coverage_not_enabled',
      message: 'research coverage is not enabled; relevant synthesis remains available',
    })
  })

  it('纯字符串 detail → message（兼容旧后端）', () => {
    const error = Object.assign(new Error('Request failed with status code 422'), {
      response: { data: { detail: 'synthesis_scope must be relevant or all_selected' } },
    })
    expect(researchApi.researchApiErrorDetail(error)).toEqual({
      code: null,
      message: 'synthesis_scope must be relevant or all_selected',
    })
  })

  it('非 axios 错误（无 response）→ 双 null（调用方兜底 error.message）', () => {
    expect(researchApi.researchApiErrorDetail(new Error('network down'))).toEqual({
      code: null,
      message: null,
    })
  })

  it('detail 缺失/数组（FastAPI 校验错误）/类型非法 → 双 null（fail-closed 不误读）', () => {
    expect(researchApi.researchApiErrorDetail({ response: { data: {} } })).toEqual({
      code: null,
      message: null,
    })
    expect(
      researchApi.researchApiErrorDetail({
        response: { data: { detail: [{ msg: 'field required' }] } },
      }),
    ).toEqual({ code: null, message: null })
    expect(researchApi.researchApiErrorDetail(null)).toEqual({ code: null, message: null })
  })

  it('detail 对象只有 code 或只有 message → 保留可解析项', () => {
    expect(
      researchApi.researchApiErrorDetail({
        response: { data: { detail: { code: 'some_code' } } },
      }),
    ).toEqual({ code: 'some_code', message: null })
    expect(
      researchApi.researchApiErrorDetail({
        response: { data: { detail: { message: 'some message' } } },
      }),
    ).toEqual({ code: null, message: 'some message' })
  })
})

// ── #358：能力归一（fail-closed） ──

describe('coverageAllSelectedFrom（#358）', () => {
  it('严格 true → 允许', () => {
    expect(coverageAllSelectedFrom({ coverage_all_selected: true })).toBe(true)
  })
  it('false / 缺失 / 非法类型 → false（fail-closed）', () => {
    expect(coverageAllSelectedFrom({ coverage_all_selected: false })).toBe(false)
    expect(coverageAllSelectedFrom(undefined)).toBe(false)
    expect(coverageAllSelectedFrom({})).toBe(false)
    expect(coverageAllSelectedFrom({ coverage_all_selected: 'yes' })).toBe(false)
    expect(coverageAllSelectedFrom({ coverage_all_selected: 1 })).toBe(false)
    expect(coverageAllSelectedFrom({ coverage_all_selected: null })).toBe(false)
  })
})
