/**
 * Research Token claims 纯函数解码（UI-02，设计 §4.2/契约 v0 §4.1；
 * REQ-AUTH-02/REQ-SCOPE-04）。
 *
 * iframe 需要从 JWT 载荷读取 ``project_id``（构建 Gateway 路径）与
 * ``role``（Owner 写 / Admin 只读矩阵，设计 §4.4）。签名与 claim 权威
 * 校验在 Gateway 每请求执行（FND-05）；本模块只做浏览器侧的展示/路径
 * 解析，**不验签、不落日志、不写存储**（Token 仍只存内存，REQ-EMB-02）。
 *
 * 任何缺字段 / 非法值返回 null：工作台无法确定项目或角色时 fail-closed，
 * 由会话层进入 error 状态，而不是猜测路径或权限。
 */

export type ResearchRole = 'owner' | 'admin_readonly'

export interface ResearchClaims {
  projectId: string
  role: ResearchRole
  scopes: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodePayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0) {
    return null
  }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1].length === 0) {
    return null
  }
  let json: string
  try {
    // base64url → binary → utf-8（兼容带 padding/不带 padding 的载荷）
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    json = new TextDecoder().decode(bytes)
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 解码并校验 Research Token claims；非法返回 null。
 */
export function decodeResearchClaims(token: string): ResearchClaims | null {
  const payload = decodePayload(token)
  if (payload === null) {
    return null
  }
  if (typeof payload.project_id !== 'string' || payload.project_id.length === 0) {
    return null
  }
  if (payload.role !== 'owner' && payload.role !== 'admin_readonly') {
    return null
  }
  if (
    !Array.isArray(payload.scopes) ||
    payload.scopes.some((scope) => typeof scope !== 'string')
  ) {
    return null
  }
  return {
    projectId: payload.project_id,
    role: payload.role,
    scopes: payload.scopes as string[],
  }
}

/** Admin 只读角色判定（设计 §4.4：Admin 只读/导出，不可写研究产物）。 */
export function isAdminReadonly(claims: ResearchClaims | null | undefined): boolean {
  return claims?.role === 'admin_readonly'
}
