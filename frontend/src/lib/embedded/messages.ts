/**
 * 纯消息校验器：postMessage v0 契约（契约 v0 §12，REQ-EMB-01）。
 *
 * 父页面 → iframe 的每条消息必须同时满足五要素绑定：
 * origin（精确匹配白名单）、window source（event.source 为已知父窗口引用）、
 * schema（固定 `research-v0`）、nonce（会话一次性）、channel（会话随机）。
 * 任一不符或载荷不符合类型 schema → 返回 null，调用方**静默拒绝**：
 * 不响应、不落日志正文。
 *
 * W1 宿主契约 v1（加性扩展，与宿主侧 PR 锁步）：
 * - `language` 消息：宿主级语言偏好（D-UI-02）经同一嵌入会话协议下发；
 *   只接受 `zh-CN` / `en-US` 两值，非法值静默丢弃；
 * - `token` / `refresh` 的**可选** `project: { name }` 字段（1..200 chars）：
 *   宿主项目可读名（D-UI-01：项目身份只在 UI-02 呈现）。字段存在但非法
 *   → 整条消息静默丢弃（fail-closed，不猜测项目名）；refresh 缺字段时
 *   由 session 层保留已有项目名。
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

/**
 * 宿主下发的语言（D-UI-02，W1 双语范围只有 zh-CN / en-US）。
 * 加性扩展：旧宿主不发该消息时工作台保持嵌入式默认 en-US。
 */
export const HOST_LANGUAGES = ['zh-CN', 'en-US'] as const

export type HostLanguage = (typeof HOST_LANGUAGES)[number]

/** 宿主项目可读名（D-UI-01）：1..200 字符，不做 further 语义推断。 */
export interface HostProject {
  name: string
}

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
  | { type: 'token'; token: string; expiresAt: number; project?: HostProject }
  | { type: 'refresh'; token: string; expiresAt: number; project?: HostProject }
  | { type: 'error'; code: PmErrorCode; message: string }
  | { type: 'logout' }
  | { type: 'destroy' }
  /** RWV2-50：宿主解析主题（additive，契约 v0 §12 theme_rules） */
  | { type: 'theme'; theme: 'light' | 'dark' }
  /** W1 契约 v1（D-UI-02）：宿主级语言偏好（additive） */
  | { type: 'language'; language: HostLanguage }

/** 项目名边界（1..200 chars）；超界视为非法载荷。 */
export const HOST_PROJECT_NAME_MIN_LENGTH = 1
export const HOST_PROJECT_NAME_MAX_LENGTH = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验可选 `project` 字段。
 *
 * 返回 `undefined` = 字段缺失（合法，session 层保留已有项目名）；
 * 返回 `null` = 字段存在但非法（整条消息丢弃，不静默降级成通用项目名）。
 */
export function parseHostProject(value: unknown): HostProject | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.name !== 'string') return null
  const name = value.name
  if (
    name.length < HOST_PROJECT_NAME_MIN_LENGTH ||
    name.length > HOST_PROJECT_NAME_MAX_LENGTH
  ) {
    return null
  }
  // 纯空白名不承载项目身份：按非法载荷处理，避免顶栏渲染空项目壳。
  if (name.trim().length === 0) return null
  return { name }
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
      // W1 契约 v1：project 可选；存在但非法 → 整条消息丢弃（fail-closed）。
      const project = parseHostProject(data.project)
      if (project === null) return null
      return {
        type: data.type,
        token: data.token,
        expiresAt: data.expires_at,
        ...(project === undefined ? {} : { project }),
      }
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
    case 'theme':
      // RWV2-50：payload 有界枚举，越界值与缺失字段一律静默拒绝
      if (data.theme !== 'light' && data.theme !== 'dark') {
        return null
      }
      return { type: 'theme', theme: data.theme }
    case 'language':
      // W1 契约 v1（D-UI-02）：只有 zh-CN / en-US 两值合法。
      if (
        typeof data.language !== 'string' ||
        !(HOST_LANGUAGES as readonly string[]).includes(data.language)
      ) {
        return null
      }
      return { type: 'language', language: data.language as HostLanguage }
    default:
      return null
  }
}
