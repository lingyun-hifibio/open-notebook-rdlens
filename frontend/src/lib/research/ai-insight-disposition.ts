/**
 * Issue #54 S3（FR-05/C-09）：AI Insight 失败的归一化与 disposition 状态机。
 *
 * 分类只依赖规范化后的四轴（status/code/state/message）——绝不只看
 * `detail.code`：Host 的 409 家族同时使用 `detail.state`，consent 拒绝可能
 * 没有结构化 code，网络失败没有 response，幂等冲突可能是纯字符串。
 *
 * 优先级严格如下（命中即返回，顺序即正确性）：
 *   1. `state/code = outcome_unknown` → outcome_unknown
 *   2. `state = accepted/running` 或 `code = generation_in_progress` → retry_same_key
 *   3. `state = failed` → terminal
 *   4. consent 三码 → consent_invalid（清当前 marker、刷新 consent、新 key）
 *   5. 幂等冲突（纯字符串/结构化）或无法解释的 409 → protocol_conflict（保留
 *      marker、禁止自动重发）
 *   6. 无 HTTP 响应，或无权威终态的 5xx → retry_same_key
 *   7. 其余确定性 4xx/422/429 → terminal
 *
 * 只有「确定的失败」才判 terminal；任何不确定结果都落在会复用同一 key 的
 * disposition 上（retry_same_key / outcome_unknown），客户端永不隐式换 key。
 */

import { researchApiErrorDetail } from '@/lib/research/api'

export interface NormalizedResearchError {
  status: number | null
  code: string | null
  state: string | null
  message: string | null
  hasResponse: boolean
}

export type AiInsightDisposition =
  | 'outcome_unknown'
  | 'retry_same_key'
  | 'terminal'
  | 'consent_invalid'
  | 'protocol_conflict'

const CONSENT_CODES = new Set(['consent_required', 'consent_revoked', 'consent_scope_changed'])
const OUTCOME_UNKNOWN_CODES = new Set(['outcome_unknown'])
const RETRY_STATES = new Set(['accepted', 'running'])

/** 结构化 detail（对象、非数组）——纯字符串/FastAPI 数组一律 null。 */
function structuredDetail(error: unknown): Record<string, unknown> | null {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data
  const detail = (data as { detail?: unknown } | null)?.detail
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return null
  }
  return detail as Record<string, unknown>
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 任意错误对象 → 四轴 + hasResponse（不抛错；非对象按无响应处理）。 */
export function normalizeAiInsightError(error: unknown): NormalizedResearchError {
  if (error === null || typeof error !== 'object') {
    return { status: null, code: null, state: null, message: null, hasResponse: false }
  }
  const response = (error as { response?: unknown }).response
  if (response === null || response === undefined || typeof response !== 'object') {
    return { status: null, code: null, state: null, message: null, hasResponse: false }
  }
  const status = (response as { status?: unknown }).status
  return {
    status: typeof status === 'number' ? status : null,
    // code/message 复用既有解析（对象 detail / 纯字符串 detail / 数组 detail 守卫）
    code: researchApiErrorDetail(error).code,
    state: readString(structuredDetail(error), 'state'),
    message: researchApiErrorDetail(error).message,
    hasResponse: true,
  }
}

/** 幂等冲突：结构化 code 或纯字符串 detail 中的 "idempotency conflict"。 */
function isIdempotencyConflict(normalized: NormalizedResearchError): boolean {
  if (normalized.code !== null && normalized.code.toLowerCase().includes('idempotency')) {
    return true
  }
  return normalized.message !== null && /idempotency[ _-]*conflict/i.test(normalized.message)
}

/** 优先级 1→7。输入接受原始错误对象（内部归一化）或已归一化结果。 */
export function classifyAiInsightFailure(
  error: unknown,
  normalized: NormalizedResearchError = normalizeAiInsightError(error),
): AiInsightDisposition {
  // 1. 结果未知优先于一切（409 也可能是 outcome_unknown）
  if (
    (normalized.code !== null && OUTCOME_UNKNOWN_CODES.has(normalized.code)) ||
    (normalized.state !== null && OUTCOME_UNKNOWN_CODES.has(normalized.state))
  ) {
    return 'outcome_unknown'
  }
  // 2. 服务端仍在处理同一 key：同 key 重试是唯一安全动作
  if (
    (normalized.state !== null && RETRY_STATES.has(normalized.state)) ||
    normalized.code === 'generation_in_progress'
  ) {
    return 'retry_same_key'
  }
  // 3. 权威终态
  if (normalized.state === 'failed') return 'terminal'
  // 4. consent 失效：清当前 marker、刷新 consent，之后重新确认并用新 key
  if (normalized.code !== null && CONSENT_CODES.has(normalized.code)) return 'consent_invalid'
  // 5. 协议冲突：保留 marker，禁止自动重发。当前所有 409 都归此级，但幂等
  //    冲突要单独识别——它明确表示「同 key 不同载荷」，与无解释的 409 一样
  //    都不能自动换 key 重发（未来若放宽未知 409 的处置，此处即判别点）。
  if (normalized.status === 409) {
    void isIdempotencyConflict(normalized)
    return 'protocol_conflict'
  }
  // 6. 无响应或无权威终态的 5xx：结果未知但同 key 重试安全
  if (!normalized.hasResponse) return 'retry_same_key'
  if (normalized.status !== null && normalized.status >= 500) return 'retry_same_key'
  // 7. 其余确定性 4xx/422/429
  return 'terminal'
}
