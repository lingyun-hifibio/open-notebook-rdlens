import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api/client'
import { aiInsightOutcomeFromResponse, createAiInsight, type CreateAiInsightRequest } from './ai-insight'
import { markerActionForDisposition } from './ai-insight-risk'

// Issue #54 S3（FR-05/FR-06/C-07）：AI Insight adapter 的请求精确性与响应契约校验。
// 成功载荷必须同时满足「契约头 + 状态码 + 必需字段」，任一缺失按
// outcome_unknown 处理——绝不显示成功、绝不据此清 marker。

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
}))

const request: CreateAiInsightRequest = {
  title: 'AI Insight',
  content: 'Summarize the selected materials.',
  insight_type: 'ai',
  model_id: 'm-ext',
  context_level: 'focused',
  source_ids: ['src_1'],
  note_ids: ['note_1'],
  response_language: 'en',
}

const insight = { insight_id: 'ins_1', project_id: 'proj_1', title: 'AI Insight', content: 'out', insight_type: 'ai' as const, model_id: 'm-ext', created_at: null, updated_at: null }

// 与 adapter 返回的 AiInsightHttpResponse 同形（envelope + 小写响应头）
function okResponse<T>(status: number, data: T, headers: Record<string, string> = { 'x-research-contract': 'v1' }) {
  return { status, envelope: data, headers } as never
}

describe('createAiInsight 请求（C-07/C-04）', () => {
  beforeEach(() => {
    vi.mocked(apiClient.post).mockReset()
  })

  it('发送 X-Research-Contract: v1 + 调用方幂等键 + 冻结 Scope/模型/语言', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(okResponse(200, { ...insight, generation_id: 'gen_1' }))
    await createAiInsight('proj_1', request, { idempotencyKey: 'ui-k1' })
    expect(apiClient.post).toHaveBeenCalledWith(
      '/v1/research/projects/proj_1/insights',
      request,
      { headers: { 'X-Research-Contract': 'v1', 'Idempotency-Key': 'ui-k1' } },
    )
  })

  it('adapter 不自造幂等键（键必须由调用方提供）', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(okResponse(200, { ...insight, generation_id: 'gen_1' }))
    await createAiInsight('proj_1', request, { idempotencyKey: 'caller-owned' })
    const headers = vi.mocked(apiClient.post).mock.calls[0]?.[2]?.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('caller-owned')
  })
})

describe('aiInsightOutcomeFromResponse（FR-06 契约校验）', () => {
  it('合法 200：契约头 + 扁平 Insight + generation_id → created（generation_id 被剥离）', () => {
    const outcome = aiInsightOutcomeFromResponse(okResponse(200, { ...insight, generation_id: 'gen_1' }))
    expect(outcome.kind).toBe('created')
    if (outcome.kind !== 'created') throw new Error('unreachable')
    expect(outcome.generationId).toBe('gen_1')
    expect(outcome.insight.insight_id).toBe('ins_1')
    expect((outcome.insight as unknown as Record<string, unknown>).generation_id).toBeUndefined()
  })

  it('合法 202：契约头 + generation_id + 非空 job_id + queued/accepted/running → queued', () => {
    for (const status of ['queued', 'accepted', 'running']) {
      const outcome = aiInsightOutcomeFromResponse(
        okResponse(202, { generation_id: 'gen_2', job_id: 'job_1', status }),
      )
      expect(outcome.kind).toBe('queued')
      if (outcome.kind !== 'queued') throw new Error('unreachable')
      expect(outcome.jobId).toBe('job_1')
      expect(outcome.generationId).toBe('gen_2')
    }
  })

  it('缺 X-Research-Contract → outcome_unknown（即使 200 且载荷完整）', () => {
    expect(aiInsightOutcomeFromResponse(okResponse(200, { ...insight, generation_id: 'gen_1' }, {})))
      .toEqual({ kind: 'outcome_unknown', reason: 'missing_contract_header' })
  })

  it('契约头为其他版本 → outcome_unknown（版本不符不得当成功）', () => {
    expect(aiInsightOutcomeFromResponse(
      okResponse(200, { ...insight, generation_id: 'gen_1' }, { 'x-research-contract': 'v2' }),
    )).toEqual({ kind: 'outcome_unknown', reason: 'missing_contract_header' })
  })

  it('200 缺 generation_id / 缺 insight_id → outcome_unknown（畸形成功载荷）', () => {
    expect(aiInsightOutcomeFromResponse(okResponse(200, { ...insight, generation_id: '' })))
      .toEqual({ kind: 'outcome_unknown', reason: 'malformed_success' })
    expect(aiInsightOutcomeFromResponse(okResponse(200, { generation_id: 'gen_1' })))
      .toEqual({ kind: 'outcome_unknown', reason: 'malformed_success' })
    expect(aiInsightOutcomeFromResponse(okResponse(200, null)))
      .toEqual({ kind: 'outcome_unknown', reason: 'malformed_success' })
  })

  it('202 缺 job_id / job_id 空串 / status 非 queued 家族 → outcome_unknown', () => {
    expect(aiInsightOutcomeFromResponse(okResponse(202, { generation_id: 'g', status: 'queued' })))
      .toEqual({ kind: 'outcome_unknown', reason: 'malformed_job' })
    expect(aiInsightOutcomeFromResponse(okResponse(202, { generation_id: 'g', job_id: '  ', status: 'queued' })))
      .toEqual({ kind: 'outcome_unknown', reason: 'malformed_job' })
    expect(aiInsightOutcomeFromResponse(okResponse(202, { generation_id: 'g', job_id: 'j', status: 'weird' })))
      .toEqual({ kind: 'outcome_unknown', reason: 'malformed_job' })
  })

  it('未知 2xx（204/201/299）→ outcome_unknown（不猜成功）', () => {
    for (const status of [201, 204, 299]) {
      const outcome = aiInsightOutcomeFromResponse(okResponse(status, { ...insight, generation_id: 'gen_1' }))
      expect(outcome.kind).toBe('outcome_unknown')
    }
  })
})

describe('adapter × 状态机组合（契约头缺失必须走 marker 保留路径）', () => {
  it('缺契约头的 200 → outcome_unknown → markerAction=keep，且不得当成功清 marker', () => {
    const outcome = aiInsightOutcomeFromResponse(
      okResponse(200, { ...insight, generation_id: 'gen_1' }, {}),
    )
    expect(outcome.kind).toBe('outcome_unknown')
    if (outcome.kind !== 'outcome_unknown') throw new Error('unreachable')
    expect(outcome.reason).toBe('missing_contract_header')
    // 成功路径（created/queued）才允许 clear；未知结果必须 keep
    expect(markerActionForDisposition('outcome_unknown')).toBe('keep')
  })

  it('合法 200/202 是唯一允许 clear 的成功路径（S4 消费的判定点）', () => {
    expect(aiInsightOutcomeFromResponse(okResponse(200, { ...insight, generation_id: 'g' })).kind).toBe('created')
    expect(aiInsightOutcomeFromResponse(okResponse(202, { generation_id: 'g', job_id: 'j', status: 'queued' })).kind).toBe('queued')
    expect(markerActionForDisposition('terminal')).toBe('clear')
  })
})
