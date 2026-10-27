/**
 * 会话运行时 bootstrap 的生产传输（RDLens #602 第三批 PR-8 / 6b）。
 *
 * 规范来源：DESIGN §3.2/§3.3（bootstrap 与能力协商）、§7.1（稳定错误映射）、
 * 02 §3（list_query → list_response）、02 §8（parseSessionError）。
 *
 * 职责边界：
 * - **只**做传输与判别映射：不取 token、不落盘、不加协议头（Bearer 与
 *   `X-Research-Session-Contract` 由 `api.ts` 的 `listChatSessions` 负责），
 *   不缓存、不重试、不伪造能力；
 * - 响应严格经 `session-contract.parseListResponse` 校验，只消费
 *   `viewer_user_id` 与 `capabilities`，**不读**列表条目正文；
 * - never throws：失败一律返回判别结果，由运行时分派到
 *   masked / unauthorized / error 三态（`session-runtime.ts`）。
 *
 * 映射（DESIGN §7.1 + Lead 批准口径）：
 * - 200 + 合法 `list_response` → `{status:'ok', viewerUserId, capabilities}`；
 *   capabilities 字段缺失／契约不匹配 → **仍为 ok**，携带 degraded 能力
 *   （§3.3 门禁照常生效，不能用错误页掩盖「新会话能力未就绪」）；
 * - 形状非法／非对象响应 → `{status:'error', code:'invalid_response', retryable:false}`
 *   （客户端稳定码，不伪造 viewer/capabilities）；
 * - 401 → `{status:'error', code:'unauthenticated'|envelope, retryable:false}`
 *   （等待父页面刷新，不跳登录页）；
 * - 403 `chat_owner_required` → `{status:'unauthorized', code}`；其他 403
 *   同样 `unauthorized`（无 envelope code 时不伪造码）；
 * - 5xx／网络／超时 → `{status:'error', code, retryable:true}`
 *   （5xx 只保留**已知**稳定码，否则 `bootstrap_failed`）。
 */

import { listChatSessions, researchApiErrorDetail } from '@/lib/research/api'
import { parseListResponse, parseSessionError } from './session-contract'
import type {
  SessionRuntimeBootstrapOutcome,
  SessionRuntimeTransport,
} from './session-runtime'

/** 无 HTTP 响应且码表命中这些码 → 网络层失败（可重试）。 */
const NETWORK_ERROR_CODES = new Set([
  'ERR_NETWORK',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_INTERNET_DISCONNECTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/** 无 HTTP 响应且码表命中这些码 → 超时（可重试）。 */
const TIMEOUT_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'])

/** 未知失败（含 4xx 无稳定码）的统一客户端兜底码（不冒充服务端稳定码）。 */
const BOOTSTRAP_FAILED = 'bootstrap_failed'

const INVALID_RESPONSE = 'invalid_response'

/**
 * 读 HTTP 状态（无响应/形状不符/非法数值一律 null）。
 *
 * `never throws`：恶意或被破坏的错误对象可能用 getter 抛错（`response` 是
 * 访问器属性），本函数吞掉读取异常并按“无响应”处理——分类退化为保守的
 * 可重试传输失败，绝不冒泡成未处理拒绝。
 */
function readStatus(error: unknown): number | null {
  try {
    if (error === null || typeof error !== 'object') return null
    const response = (error as { response?: unknown }).response
    if (response === null || response === undefined || typeof response !== 'object') return null
    const status = (response as { status?: unknown }).status
    if (typeof status !== 'number' || !Number.isInteger(status)) return null
    // 只接受真实 HTTP 状态区间：越界值（0/负数/999999）不是可分类的响应，
    // 否则会被误当成 5xx 并保留稳定码。
    if (status < 100 || status > 599) return null
    return status
  } catch {
    return null
  }
}

/** 读传输层错误码（axios 与 fetch 包装的码都挂在 `code` 上）。 */
function readTransportCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

function readMessage(error: unknown): string {
  if (error === null || typeof error !== 'object') return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

/**
 * 无 HTTP 响应的失败映射：网络／超时 → 对应客户端码，其余 → `bootstrap_failed`。
 * 三者都按可重试处理（§7.1：没有可靠受理知识的传输失败才进入保守重试）。
 */
function mapTransportFailure(error: unknown): SessionRuntimeBootstrapOutcome {
  const code = readTransportCode(error)
  if (code !== null && TIMEOUT_ERROR_CODES.has(code)) {
    return { status: 'error', code: 'timeout', retryable: true }
  }
  if (code !== null && NETWORK_ERROR_CODES.has(code)) {
    return { status: 'error', code: 'network_error', retryable: true }
  }
  // axios 在部分适配器下只给 message（`timeout of 0ms exceeded`）与 ETIMEDOUT。
  if (code === null && /timeout/i.test(readMessage(error))) {
    return { status: 'error', code: 'timeout', retryable: true }
  }
  return { status: 'error', code: BOOTSTRAP_FAILED, retryable: true }
}

/** HTTP 错误 → 判别结果（401/403/5xx/其余 4xx；DESIGN §7.1）。 */
function mapHttpFailure(error: unknown, status: number): SessionRuntimeBootstrapOutcome {
  if (status === 401) {
    // 认证失效：FREEZE §7「401 无专用 code，按状态」——固定归一到 `unauthenticated`，
    // 不把 envelope 里可能出现的其它码（token_expired 等）当成本会话稳定码；
    // 交父页面刷新，客户端不重试、不跳登录页（DESIGN §7.1）。
    //
    // 必须先于任何 envelope 读取判定：401 的分类只依赖状态，若先解 envelope
    // 而 `response.data` 是抛错的访问器，异常会退化成“可重试的未知失败”，
    // 把认证失效误报为可重试（复核 F1）。
    return { status: 'error', code: 'unauthenticated', retryable: false }
  }
  // 401 之后才需要 envelope：读失败按“无结构化 detail”处理（不伪造稳定码）。
  let envelopeCode: string | null = null
  let recognized = false
  try {
    const data = (error as { response?: { data?: unknown } } | null)?.response?.data
    const projection = parseSessionError(status, data)
    // 只有真实存在 detail.code 时才保留：缺失时不得用 fallback 码冒充稳定码。
    envelopeCode = researchApiErrorDetail(error).code
    recognized = envelopeCode !== null && projection.recognized
  } catch {
    envelopeCode = null
    recognized = false
  }

  if (status === 403) {
    // 403 一律终态 unauthorized（`chat_owner_required` 只是其中的具体原因）。
    return envelopeCode === null
      ? { status: 'unauthorized' }
      : { status: 'unauthorized', code: envelopeCode }
  }
  if (status >= 500) {
    return {
      status: 'error',
      code: recognized && envelopeCode !== null ? envelopeCode : BOOTSTRAP_FAILED,
      retryable: true,
    }
  }
  // 其余 4xx（400/404/408/409/422/429…）：确定性失败，仅 408/429 可重试。
  return {
    status: 'error',
    code: envelopeCode ?? BOOTSTRAP_FAILED,
    retryable: status === 408 || status === 429,
  }
}

/**
 * 创建生产 bootstrap 传输。
 *
 * 工厂不持有任何可变态：每次 bootstrap 都是独立的一次 `GET /chat/sessions`
 * （`kind=all` + `limit=1`，只为取 viewer 与能力协商结果，不翻页）。
 */
export function createSessionRuntimeTransport(): SessionRuntimeTransport {
  return {
    async bootstrap(input) {
      let raw: unknown
      try {
        raw = await listChatSessions(input.projectId, { kind: 'all', limit: 1 })
      } catch (error) {
        const status = readStatus(error)
        try {
          return status === null
            ? mapTransportFailure(error)
            : mapHttpFailure(error, status)
        } catch {
          // 兜底：映射自身异常也不能冒泡成未处理拒绝（运行时只会看到判别结果）。
          return { status: 'error', code: BOOTSTRAP_FAILED, retryable: true }
        }
      }

      let parsed: ReturnType<typeof parseListResponse>
      try {
        parsed = parseListResponse(raw)
      } catch {
        return { status: 'error', code: INVALID_RESPONSE, retryable: false }
      }
      if (!parsed.ok) {
        // 形状非法：不伪造 viewer / capabilities，也不猜能力降级（§7.1 invalid_response）。
        return { status: 'error', code: INVALID_RESPONSE, retryable: false }
      }
      return {
        status: 'ok',
        viewerUserId: parsed.value.viewerUserId,
        // capabilities 已完成 §3.3 协商：字段缺失/契约不符 → degraded（不伪造 ready）。
        capabilities: parsed.value.capabilities,
      }
    },
  }
}
