/**
 * 纯消息校验器：postMessage v0 契约（契约 v0 §12，REQ-EMB-01）。
 *
 * 父页面 → iframe 的每条消息必须同时满足五要素绑定：
 * origin（精确匹配白名单）、window source（event.source 为已知父窗口引用）、
 * schema（固定 `research-v0`）、nonce（会话一次性）、channel（会话随机）。
 * 任一不符或载荷不符合类型 schema → 返回 null，调用方**静默拒绝**：
 * 不响应、不落日志正文。
 *
 * 本模块为纯函数，不触碰 window/DOM，可直接单元测试。
 */

export const PM_SCHEMA = 'research-v0'

export const PM_ERROR_CODES = [
  'bootstrap_failed',
  'refresh_failed',
  'session_invalid',
] as const

export type PmErrorCode = (typeof PM_ERROR_CODES)[number]

export interface MessageValidationContext {
  /** event.origin */
  origin: string
  /** true 当 event.source === 期望的父窗口引用 */
  sourceMatches: boolean
  /** 允许的父页面精确 origin 列表（环境配置） */
  allowedOrigins: readonly string[]
  /** 会话一次性 nonce（ready 握手生成，父页面回显） */
  nonce: string
  /** 会话随机 channel id（ready 握手生成，父页面回显） */
  channel: string
}

export type ValidatedInboundMessage =
  | { type: 'token'; token: string; expiresAt: number }
  | { type: 'refresh'; token: string; expiresAt: number }
  | { type: 'error'; code: PmErrorCode; message: string }
  | { type: 'logout' }
  | { type: 'destroy' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验父页面消息；非法消息返回 null（调用方静默丢弃）。
 */
export function validateIncomingMessage(
  data: unknown,
  ctx: MessageValidationContext,
): ValidatedInboundMessage | null {
  // 五要素绑定：origin / window source
  if (!ctx.allowedOrigins.includes(ctx.origin) || !ctx.sourceMatches) {
    return null
  }
  if (!isRecord(data)) {
    return null
  }
  // schema / channel / nonce
  if (
    data.schema !== PM_SCHEMA ||
    typeof data.channel !== 'string' ||
    data.channel !== ctx.channel ||
    typeof data.nonce !== 'string' ||
    data.nonce !== ctx.nonce
  ) {
    return null
  }

  switch (data.type) {
    case 'token':
    case 'refresh': {
      if (
        typeof data.token !== 'string' ||
        data.token.length === 0 ||
        typeof data.expires_at !== 'number' ||
        !Number.isFinite(data.expires_at)
      ) {
        return null
      }
      return { type: data.type, token: data.token, expiresAt: data.expires_at }
    }
    case 'error': {
      if (
        typeof data.code !== 'string' ||
        !(PM_ERROR_CODES as readonly string[]).includes(data.code) ||
        typeof data.message !== 'string'
      ) {
        return null
      }
      return { type: 'error', code: data.code as PmErrorCode, message: data.message }
    }
    case 'logout':
      return { type: 'logout' }
    case 'destroy':
      return { type: 'destroy' }
    default:
      return null
  }
}
