/**
 * Issue #54 S3（FR-05/FR-06/C-07）：AI Insight 专用 adapter 与成功载荷解析。
 *
 * 与 Manual Insight 的关键区别（Host `InsightCreateRequest`）：
 * - `insight_type: 'ai'` 时 `content` 是**生成指令**而非正文；AI 正文只能由
 *   Research Engine 产出（客户端无法伪造 ai provenance）；
 * - 请求必须携带已冻结的 Scope（`source_ids`/`note_ids`）、显式 `model_id`、
 *   固定 `context_level: 'focused'`（O-01）与本次生成指令语言；
 * - 必须带 `X-Research-Contract: v1` 与调用方提供的 `Idempotency-Key`。
 *
 * 为什么解析必须严格（FR-06）：成功响应缺失契约头或必需字段时，若按成功处理
 * 会**错误清除风险 marker**（未知结果被当成已知），并可能显示并不存在的
 * Insight。因此任何不满足契约的 2xx 一律归为 `outcome_unknown`，由状态机
 * 按「结果未知」继续保护。
 */

import { apiClient } from '@/lib/api/client'
import type { ResearchInsight } from '@/lib/types/research'

/** §4.1：AI Insight 生成指令语言（由 content 检出，派发时冻结）。 */
export type AiInsightResponseLanguage = 'zh' | 'en'

export interface CreateAiInsightRequest {
  title: string
  /** 生成指令（非正文） */
  content: string
  insight_type: 'ai'
  model_id: string
  /** O-01：AI Insight 显式使用 focused 上下文 */
  context_level: 'focused'
  source_ids: string[]
  note_ids: string[]
  response_language: AiInsightResponseLanguage
}

/** 200 的 Host 形态：扁平 Insight + 并列 `generation_id`。 */
type AiInsightCreatedEnvelope = ResearchInsight & { generation_id?: unknown }
const QUEUED_JOB_STATES = new Set(['queued', 'accepted', 'running'])

/** 与 `api.ts` 的 researchPath 同构（v1 前缀 + /projects/{id}/{segments}）。 */
const insightsPath = (projectId: string): string =>
  `/v1/research/projects/${projectId}/insights`

export interface AiInsightHttpResponse {
  status: number
  /** 响应体（适配器不解释，由 `aiInsightOutcomeFromResponse` 严格校验） */
  envelope: unknown
  /** 响应头（axios 1 归一化小写）；契约头校验用 */
  headers?: unknown
}

export type AiInsightOutcome =
  | { kind: 'created'; insight: ResearchInsight; generationId: string }
  | { kind: 'queued'; jobId: string; generationId: string }
  | { kind: 'outcome_unknown'; reason: 'missing_contract_header' | 'malformed_success' | 'malformed_job' }

/**
 * 发送 AI Insight 生成请求。`idempotencyKey` 由调用方提供——adapter 内部
 * **不得**生成（键只在 consent 成功后的 operation 内产生，S3/S4 契约）。
 */
export async function createAiInsight(
  projectId: string,
  request: CreateAiInsightRequest,
  options: { idempotencyKey: string },
): Promise<AiInsightHttpResponse> {
  const response = await apiClient.post<unknown>(
    insightsPath(projectId),
    request,
    {
      headers: {
        'X-Research-Contract': 'v1',
        'Idempotency-Key': options.idempotencyKey,
      },
    },
  )
  return { status: response.status, envelope: response.data, headers: response.headers }
}

/** 契约头读取（axios 1 归一化小写键；同时容忍 Headers 对象形态）。 */
function readContractHeader(headers: unknown): unknown {
  if (headers === null || typeof headers !== 'object') return undefined
  const direct = (headers as Record<string, unknown>)['x-research-contract']
  if (direct !== undefined) return direct
  const getter = (headers as { get?: (name: string) => unknown }).get
  return typeof getter === 'function' ? getter.call(headers, 'x-research-contract') : undefined
}

function hasContractV1(headers: unknown): boolean {
  return readContractHeader(headers) === 'v1'
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 HTTP 响应解析为 outcome。调用方必须先确认契约头（缺头即使 200 也不是
 * 合法成功）——本函数不做归一化，只做严格校验。
 */
export function aiInsightOutcomeFromResponse(response: AiInsightHttpResponse): AiInsightOutcome {
  if (!hasContractV1(response.headers)) {
    return { kind: 'outcome_unknown', reason: 'missing_contract_header' }
  }
  if (response.status === 200) {
    const envelope = response.envelope
    if (!isRecord(envelope)) return { kind: 'outcome_unknown', reason: 'malformed_success' }
    const insightId = nonEmptyString(envelope.insight_id)
    const generationId = nonEmptyString(envelope.generation_id)
    if (insightId === null || generationId === null) {
      return { kind: 'outcome_unknown', reason: 'malformed_success' }
    }
    // generation_id 与 Insight 同层并列——剥离后仅返回 Insight 本体
    const { generation_id: generationIdRaw, ...rest } = envelope as unknown as AiInsightCreatedEnvelope
    void generationIdRaw
    return {
      kind: 'created',
      insight: rest as ResearchInsight,
      generationId,
    }
  }
  if (response.status === 202) {
    const envelope = response.envelope
    if (!isRecord(envelope)) return { kind: 'outcome_unknown', reason: 'malformed_job' }
    const jobId = nonEmptyString(envelope.job_id)
    const generationId = nonEmptyString(envelope.generation_id)
    const status = nonEmptyString(envelope.status)
    if (jobId === null || generationId === null || status === null || !QUEUED_JOB_STATES.has(status)) {
      return { kind: 'outcome_unknown', reason: 'malformed_job' }
    }
    return { kind: 'queued', jobId, generationId }
  }
  // 未知 2xx：不猜成功（FR-06）
  return { kind: 'outcome_unknown', reason: 'malformed_success' }
}
