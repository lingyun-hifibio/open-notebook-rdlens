'use client'

/**
 * Research 项目上下文（UI-03，契约 v0 §4.1/§12.2）。
 *
 * postMessage `token` 载荷不含 project_id（UI-01 冻结）；iframe 从
 * Research Token 的 JWT payload 读取 `project_id` claim 用于 Gateway
 * URL 路由（REQ-AUTH-03：URL project_id 必须与 Token claim 一致，
 * 服务端仍做最终校验）。本模块**不校验签名**——信任来自服务端签发的
 * Token 本身；无效载荷 fail-closed 返回 null（工作区显示错误态）。
 */

import { getResearchToken } from '@/lib/embedded/token-store'

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/** 从 JWT payload（base64url，无填充）解码 project_id；任何异常 → null */
export function decodeResearchProjectId(token: string): string | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    if (!payload || !BASE64URL_RE.test(payload)) return null
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const json = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
    const projectId = (json as { project_id?: unknown }).project_id
    return typeof projectId === 'string' && projectId.length > 0 ? projectId : null
  } catch {
    return null
  }
}

/** 当前会话项目 ID（内存 Token）；无 Token 或载荷非法 → null */
export function getResearchProjectId(): string | null {
  const token = getResearchToken()
  if (!token) return null
  return decodeResearchProjectId(token)
}
