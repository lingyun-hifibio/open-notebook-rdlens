/**
 * Issue #601 PR5（D-03/D-05）：C-05 错误动作分类——主仓 `scope_errors.py`
 * 动作表的**前端消费面**。
 *
 * 三种 detail 形态都要能取到码（v8 §2.1）：
 * - C-05 对象 detail：`{code, message, recovery_action?, acceptance?, retryable?, ...}`；
 * - 历史字符串 detail（如 409 "idempotency conflict"、426 纯字符串）；
 * - 框架数组 detail（`extra="forbid"` 入口的 422）。
 *
 * 纪律：**不解析英文文案**；字符串/数组 detail 一律走"未识别"分支
 * （`acceptance='unknown'` + `stop_and_confirm` + `recognised=false`），
 * 不得据状态码发明自动重试；`acceptance_outcome_unknown`（提交回执丢失）
 * 与 `outcome_unknown`（模型可能已发送）严格分开——前者授权原键有界查证，
 * 后者绝不授权重新调用。
 */

export type C05Acceptance = 'not_accepted' | 'accepted' | 'unknown'
export type C05ClientAction =
  | 'show_validation'
  | 'reselect_sources'
  | 'retry_same_key'
  | 'reconcile_then_retry'
  | 'read_original_result'
  | 'show_conflict'
  | 'show_unavailable'
  | 'stop_and_confirm'

export interface C05ErrorDetail {
  code: string | null
  message: string | null
  acceptance: C05Acceptance
  action: C05ClientAction
  /** 服务端明确给出时透传；本地推断时 null */
  retryable: boolean | null
  /** detail 里是否带机器可读动作（对象 detail 且回退表命中） */
  recognised: boolean
  /** detail 形态：对象（C-05）/字符串（历史）/数组（框架） */
  shape: 'object' | 'string' | 'array' | 'none'
  generation_id: string | null
  state: string | null
  retry_after_seconds: number | null
}

/**
 * 从 axios/HTTP 错误中取 detail（三形态）。只取**形状**，不解释语义。
 */
export function extractErrorDetail(error: unknown): {
  shape: C05ErrorDetail['shape']
  raw: unknown
  status: number | null
} {
  let status: number | null = null
  let raw: unknown = null
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>
    if (typeof err.status === 'number') status = err.status
    const response = err.response as Record<string, unknown> | undefined
    if (response && typeof response.status === 'number') status = response.status as number
    if (response && 'data' in response) {
      raw = (response as { data?: unknown }).data
    }
  }
  let shape: C05ErrorDetail['shape'] = 'none'
  if (typeof raw === 'string') shape = 'string'
  else if (Array.isArray(raw)) shape = 'array'
  else if (raw !== null && typeof raw === 'object') {
    const detail = (raw as Record<string, unknown>).detail
    if (typeof detail === 'string') shape = 'string'
    else if (Array.isArray(detail)) shape = 'array'
    else if (detail !== null && typeof detail === 'object') shape = 'object'
  }
  return { shape, raw, status }
}

function readObjectDetail(raw: Record<string, unknown>): {
  code: string | null
  message: string | null
  detail: Record<string, unknown> | null
} {
  const detail = raw.detail
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    // 兼容顶层直接是 C-05 detail 体的响应（无 detail 包裹层）
    if ('code' in raw && typeof raw.code === 'string') {
      return { code: raw.code, message: (raw.message as string) ?? null, detail: raw }
    }
    return { code: null, message: null, detail: null }
  }
  const d = detail as Record<string, unknown>
  return {
    code: typeof d.code === 'string' ? d.code : null,
    message: typeof d.message === 'string' ? d.message : null,
    detail: d,
  }
}

/**
 * 服务端在 `acceptance.py` 的 `zero_accept_writes` 证据已由后端折叠进
 * `detail.acceptance`（回滚未确认时后端降级为 unknown/reconcile_then_retry），
 * 前端**信任 detail.acceptance**，不再自行按状态码推断。
 */
const ACTION_TABLE: Record<string, { acceptance: C05Acceptance; action: C05ClientAction; retryable: boolean }> = {
  // 范围契约拒绝（接受写入前，零副作用）
  scope_invalid_payload: { acceptance: 'not_accepted', action: 'show_validation', retryable: false },
  scope_unknown_field: { acceptance: 'not_accepted', action: 'show_validation', retryable: false },
  scope_invalid_mode: { acceptance: 'not_accepted', action: 'show_validation', retryable: false },
  scope_header_payload_mismatch: { acceptance: 'not_accepted', action: 'show_validation', retryable: false },
  scope_legacy_fields_not_allowed: { acceptance: 'not_accepted', action: 'show_validation', retryable: false },
  scope_requires_specific_source: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  scope_all_with_notes: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  scope_selected_empty: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  coverage_notes_not_supported: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  scope_selected_source_unavailable: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  scope_single_source_not_found: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  scope_selected_version_unavailable: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  note_not_found: { acceptance: 'not_accepted', action: 'reselect_sources', retryable: false },
  // 门禁
  c05_contract_not_enabled: { acceptance: 'not_accepted', action: 'show_unavailable', retryable: false },
  c05_entry_not_ready: { acceptance: 'not_accepted', action: 'show_unavailable', retryable: false },
  // 接受阶段
  acceptance_outcome_unknown: { acceptance: 'unknown', action: 'reconcile_then_retry', retryable: true },
  idempotency_conflict: { acceptance: 'unknown', action: 'show_conflict', retryable: false },
  acceptance_retry_budget_exhausted: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: true },
  acceptance_budget_exhausted: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: true },
  acceptance_connection_unavailable: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: true },
  acceptance_serialization_failure: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: true },
  acceptance_temporary_unavailable: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: false },
  acceptance_internal_error: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: false },
  scope_resolution_unavailable: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: true },
  authoritative_read_unavailable: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: true },
  note_availability_unavailable: { acceptance: 'not_accepted', action: 'retry_same_key', retryable: true },
  // 已接受
  generation_in_progress: { acceptance: 'accepted', action: 'read_original_result', retryable: false },
  result_missing: { acceptance: 'accepted', action: 'stop_and_confirm', retryable: false },
}

/**
 * PR-13（F-1）：码 → 服务端动作表里的 `retryable`（未登记返回 null）。
 *
 * 仅用于 UI **投影层**决定“明确未受理”轮的 Retry 是否可用：wire 的
 * `recovery_action=show_unavailable` 一律 `retryable:false`（不渲染 Retry），
 * `retry_same_key`/`reconcile_then_retry` 才是允许原键重试的动作。动作本身
 * 已在 machine/session 决定，本函数不改变任何状态机语义。
 */
export function retryableForCode(code: string | null | undefined): boolean | null {
  if (typeof code !== 'string' || code.length === 0) return null
  return ACTION_TABLE[code]?.retryable ?? null
}

/** PR-13：该码的动作是否属于“同键重试/对账后重试”（允许展示 Retry）。 */
export function allowsRetryAction(code: string | null | undefined): boolean {
  if (typeof code !== 'string' || code.length === 0) return false
  const entry = ACTION_TABLE[code]
  if (entry === undefined) return false
  return entry.action === 'retry_same_key' || entry.action === 'reconcile_then_retry'
}

const TERMINAL_FAILURE_CODES = new Set([
  'outcome_unknown', 'result_missing', 'local_generation_failed', 'external_dispatch_failed',
])

/** 字符串 detail 的**保守识别**（T19/D-02 契约一致性）：仅 426 与覆盖 Note */
function classifyStringDetail(status: number | null): { acceptance: C05Acceptance; action: C05ClientAction; recognised: boolean } | null {
  if (status === 426) return { acceptance: 'not_accepted', action: 'show_unavailable', recognised: true }
  return null
}

/**
 * 分类错误 → 客户端动作（D-13 键处置的锚点）。
 *
 * 优先级：C-05 对象 detail 的 `recovery_action` > 稳定码表回退 >
 * 未识别（字符串/数组 detail → `unknown` + `stop_and_confirm` +
 * `recognised=false`）。
 */
export function classifyC05Error(error: unknown): C05ErrorDetail {
  const { shape, raw, status } = extractErrorDetail(error)

  if (shape === 'object' && raw !== null && typeof raw === 'object') {
    const { code, message, detail } = readObjectDetail(raw as Record<string, unknown>)
    const recovery = detail && typeof detail.recovery_action === 'string'
      ? detail.recovery_action as C05ClientAction
      : null
    const acceptance = detail && typeof detail.acceptance === 'string'
      ? detail.acceptance as C05Acceptance
      : null
    const retryableWire = detail && typeof detail.retryable === 'boolean'
      ? detail.retryable as boolean
      : null
    const tableHit = code !== null && ACTION_TABLE[code] !== undefined
      ? ACTION_TABLE[code]
      : null
    const terminal = code !== null && TERMINAL_FAILURE_CODES.has(code)

    if (code === null) {
      return {
        code: null, message, acceptance: 'unknown', action: 'stop_and_confirm',
        retryable: null, recognised: false, shape,
        generation_id: readId(detail, 'generation_id'),
        state: readString(detail, 'state'), retry_after_seconds: readRetryAfter(detail),
      }
    }
    if (terminal) {
      return {
        code, message, acceptance: 'accepted', action: 'stop_and_confirm',
        retryable: retryableWire ?? false, recognised: true, shape,
        generation_id: readId(detail, 'generation_id'),
        state: readString(detail, 'state'), retry_after_seconds: readRetryAfter(detail),
      }
    }
    if (tableHit !== null) {
      return {
        code, message,
        acceptance: acceptance ?? tableHit.acceptance,
        action: recovery ?? tableHit.action,
        retryable: retryableWire ?? tableHit.retryable,
        recognised: true, shape,
        generation_id: readId(detail, 'generation_id'),
        state: readString(detail, 'state'), retry_after_seconds: readRetryAfter(detail),
      }
    }
    // 对象 detail 但码未登记：按 unknown 保守（不解析英文、不发明重试）
    return {
      code, message, acceptance: 'unknown', action: 'stop_and_confirm',
      retryable: retryableWire ?? null, recognised: false, shape,
      generation_id: readId(detail, 'generation_id'),
      state: readString(detail, 'state'), retry_after_seconds: readRetryAfter(detail),
    }
  }

  // 字符串/数组/none detail：只有 426 保守可识别为门禁不可用；
  // 其余一律未识别（含 409 "idempotency conflict" 纯字符串——D-03）
  const stringHit = shape === 'string' ? classifyStringDetail(status) : null
  return {
    code: null,
    message: shape === 'string' ? (extractDetailString(raw)) : null,
    acceptance: stringHit?.acceptance ?? 'unknown',
    action: stringHit?.action ?? 'stop_and_confirm',
    retryable: null,
    recognised: stringHit?.recognised ?? false,
    shape,
    generation_id: null,
    state: null,
    retry_after_seconds: null,
  }
}

function extractDetailString(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object') {
    const detail = (raw as Record<string, unknown>).detail
    if (typeof detail === 'string') return detail
  }
  return null
}

function readId(detail: Record<string, unknown> | null, key: string): string | null {
  const v = detail ? detail[key] : null
  return typeof v === 'string' && v ? v : null
}

function readString(detail: Record<string, unknown> | null, key: string): string | null {
  const v = detail ? detail[key] : null
  return typeof v === 'string' ? v : null
}

function readRetryAfter(detail: Record<string, unknown> | null): number | null {
  const v = detail ? detail.retry_after_seconds ?? detail.retry_after : null
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return null
}
