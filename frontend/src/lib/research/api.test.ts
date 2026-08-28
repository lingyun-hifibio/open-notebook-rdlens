import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api/client'
import * as researchApi from './api'

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

  it('runTransformation → POST .../transformations/{id}/run，输入 source_ids/note_ids + 运行时 model_id（REQ-DIS-02；#243 §6.7 model_id 为 required）', async () => {
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
