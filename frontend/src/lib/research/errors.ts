/**
 * RWV2-42（Fork #45）：Research 稳定错误码 → 用户文案 key 映射。
 *
 * 规则（评审 R4-H1/M14）：
 * - 只收录「可达子集」——能经五动作派发端点 HTTP detail.code、Chat
 *   SSE/流错误或 consent/ack 到达用户面的码；内部/job 终态码（coverage_*、
 *   artifact_*、lease_* 等）一律不建文案，回落 generic 兜底。
 * - 优先复用现有 key（daily_limit_exceeded/superseded/model_required/
 *   conflict_busy），禁止同义双份文案。
 * - 表中每个 value 均为完整 dotted key，字面量出现在本产品文件内即可
 *   满足 locales unused-key 门禁（排除 *.test.* 与 locales 目录）。
 */

/** 稳定错误码 → i18n key（未收录的码 → userErrorMessageKey 返回 generic）。 */
export const RESEARCH_ERROR_USER_COPY: Record<string, string> = {
  // ── 既有 key 复用（同义文案，M14） ──
  daily_limit_exceeded: 'research.chatErrorDailyLimitExceeded',
  superseded: 'research.chatErrorSuperseded',
  model_required: 'research.globalModel.selectModelHint',
  conflict_busy: 'research.sourceChat.conflictBusy',

  // ── 403 consent/policy ──
  consent_required: 'research.errors.consentRequired',
  consent_revoked: 'research.errors.consentRevoked',
  consent_scope_changed: 'research.errors.consentScopeChanged',
  policy_denied: 'research.errors.policyDenied',
  external_disabled: 'research.errors.externalDisabled',
  data_egress_disabled: 'research.errors.egressDisabled',

  // ── provider / model / engine ──
  provider_disabled: 'research.errors.providerUnavailable',
  provider_unavailable: 'research.errors.providerUnavailable',
  provider_unhealthy: 'research.errors.providerUnavailable',
  model_disabled: 'research.errors.modelUnavailable',
  model_unavailable: 'research.errors.modelUnavailable',
  engine_unavailable: 'research.errors.engineUnavailable',
  credential_unreadable: 'research.errors.credentialUnreadable',
  url_blocked: 'research.errors.urlBlocked',

  // ── quota / rate ──
  quota_exceeded: 'research.errors.quotaExceeded',
  quota_unavailable: 'research.errors.quotaUnavailable',
  rate_limiter_unavailable: 'research.errors.rateLimiterUnavailable',

  // ── 409 / 恢复语义 ──
  outcome_unknown: 'research.errors.outcomeUnknown',
  generation_in_progress: 'research.errors.generationInProgress',
  revision_changed: 'research.errors.revisionChanged',

  // ── Chat SSE / 客户端码 ──
  stream_lost: 'research.errors.streamLost',
  http_error: 'research.errors.httpError',
  admission_unavailable: 'research.errors.admissionUnavailable',
  admission_capacity: 'research.errors.admissionCapacity',
  internal: 'research.errors.internal',
}

/** 未知/内部码统一兜底（raw 只作次级诊断，不作主消息——AC8）。 */
export const RESEARCH_GENERIC_ERROR_KEY = 'research.errors.generic'

/** 码 → 用户文案 key；未收录一律 generic。 */
export function userErrorMessageKey(code: string | null | undefined): string {
  if (!code) return RESEARCH_GENERIC_ERROR_KEY
  return RESEARCH_ERROR_USER_COPY[code] ?? RESEARCH_GENERIC_ERROR_KEY
}

/**
 * 从任意错误对象提取稳定码（HTTP detail.code），带 shape 守卫：
 * FastAPI 校验错误 detail 为数组、网络错误无 response、detail 可能为
 * 字符串——三者一律返回 null（走 generic），不抛错、不误读（评审 R6-4）。
 */
export function extractResearchErrorCode(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const maybe = err as { response?: { data?: { detail?: unknown } } }
  const detail = maybe.response?.data?.detail
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    return null
  }
  const code = (detail as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}
