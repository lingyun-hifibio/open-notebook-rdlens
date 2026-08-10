/**
 * Research Token 纯内存驻留存储（REQ-EMB-02，设计 §4.2）。
 *
 * Token 只存模块级变量（JS 堆内存），**永不**写入 localStorage /
 * sessionStorage / URL / 日志 / 指标。刷新替换、登出/销毁清除。
 * 本模块刻意不使用 zustand persist——任何持久化中间件都是违规。
 */

let researchToken: string | null = null
let tokenExpiresAt: number | null = null

export function setResearchToken(token: string, expiresAt: number): void {
  researchToken = token
  tokenExpiresAt = expiresAt
}

export function getResearchToken(): string | null {
  return researchToken
}

export function getResearchTokenExpiry(): number | null {
  return tokenExpiresAt
}

export function clearResearchToken(): void {
  researchToken = null
  tokenExpiresAt = null
}
