/**
 * Issue #601 PR5（D-13）：幂等键生命周期——**以服务端 `detail.acceptance`
 * / `detail.recovery_action` 为锚**，不以"是否收到 HTTP 响应"为准。
 *
 * 服务端语义（v8 §2.1 已核实）：
 * - 同键同 hash → 重放既有行（用户重复提问拿到旧答案）；
 * - 同键不同 hash → 409 `"idempotency conflict"`（纯字符串）。
 *
 * 因此键处置是**两张表**：
 * ① 未确定性完成（无 response / 网络中断 / `acceptance==='unknown'` /
 *    `read_original_result`）→ 保留原键（换键 = 第二次执行）；
 * ② 服务端给出确定性结论（200/202/终态 failed/纯字符串拒绝/422/426）→
 *    清除键，下一次提交（含同一问题再次点击）生成新键。
 *
 * 键与"逻辑提交签名"（entry+query+scope+note+model+context+语言/模板）
 * 绑定：签名变化 = 用户新意图 = 新键。
 */

import type { C05ErrorDetail } from './c05-error-actions'

/** 逻辑提交签名（不含幂等键本身） */
export interface C05SubmitSignature {
  entry: string
  query: string
  scope: { mode: string; sourceIds: readonly string[]; noteIds: readonly string[]; singleSourceId: string | null }
  modelId: string
  contextLevel: string
  mode?: string
  responseLanguage?: string
  sessionId?: string | null
}

export function signatureOf(sub: C05SubmitSignature): string {
  return JSON.stringify([
    sub.entry,
    sub.query,
    sub.scope.mode,
    [...sub.scope.sourceIds],
    [...sub.scope.noteIds],
    sub.scope.singleSourceId,
    sub.modelId,
    sub.contextLevel,
    sub.mode ?? null,
    sub.responseLanguage ?? null,
    sub.sessionId ?? null,
  ])
}

/** 单一逻辑提交的键持有态（Search/Chat 共用同一纯函数） */
export interface KeyHold {
  key: string | null
  /** 与键绑定的提交签名（键保留时校验） */
  signature: string | null
  firstSentAt: number | null
  /** 自动重试/重连 + 手动重试合计（≤3） */
  attempts: number
}

export const MAX_ATTEMPTS = 3

export function newKeyHold(): KeyHold {
  return { key: null, signature: null, firstSentAt: null, attempts: 0 }
}

/** 键龄上限：复用 `AI_INSIGHT_KEY_MAX_AGE_MS` 语义（24h，D-02） */
export const KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 提交前取键：签名变化 → 新键；签名相同 → 复用。
 * 返回的 `hold` 由调用方保存在组件 ref / hook state 中。
 */
export function acquireKey(
  hold: KeyHold,
  now: number,
  freshKey: () => string,
  signature: string,
): { key: string; hold: KeyHold; reused: boolean } {
  if (hold.key !== null && hold.signature === signature) {
    return { key: hold.key, hold: { ...hold }, reused: true }
  }
  const key = freshKey()
  return { key, hold: { key, signature, firstSentAt: now, attempts: 0 }, reused: false }
}

/** 派发即计数（初始 POST 与所有重试共用 ≤3） */
export function countAttempt(hold: KeyHold): KeyHold {
  return { ...hold, attempts: hold.attempts + 1 }
}

/**
 * 提交结局 → 键处置（D-13 两张表的唯一实现）。
 *
 * @param httpDelivered 网络层是否收到完整响应（false = 无 response/中断）
 */
export function settleKey(
  hold: KeyHold,
  outcome: { httpDelivered: boolean; detail: C05ErrorDetail | null; success: boolean },
): KeyHold {
  // ① 未确定性完成：网络层未收到响应 → 保留（换键=第二次执行）
  if (!outcome.httpDelivered) {
    return { ...hold }
  }
  const detail = outcome.detail
  if (detail) {
    // ② 对象 detail：
    if (detail.shape === 'object') {
      if (detail.acceptance === 'unknown') return { ...hold }
      if (detail.action === 'read_original_result') return { ...hold }
      if (detail.recognised && detail.acceptance === 'accepted') return { ...hold }
      // 确定性拒绝/校验错误：服务端明确结论 → 清键
      return { key: null, signature: null, firstSentAt: null, attempts: 0 }
    }
    // ③ 字符串/数组 detail（无机器码，如 409 "idempotency conflict"、
    //    409 会话冲突、426 纯字符串、extra=forbid 数组）：都是服务端
    //    **确定性结论**（会话/框架层拒绝，无接受凭据可保留）→ 清键（D-13 表第 5 行）
    if (detail.shape === 'string' || detail.shape === 'array') {
      return { key: null, signature: null, firstSentAt: null, attempts: 0 }
    }
    // shape='none'：不可能带 httpDelivered=true；防御性保留
    return { ...hold }
  }
  // ④ 无 detail 但有响应：成功（200/202）→ 服务端已给出确定性结论 → 清键
  return { key: null, signature: null, firstSentAt: null, attempts: 0 }
}

/** 键龄检查（单调时钟由调用方传入 now） */
export function keyExpired(hold: KeyHold, now: number): boolean {
  if (hold.key === null || hold.firstSentAt === null) return false
  return now - hold.firstSentAt > KEY_MAX_AGE_MS
}

/** 重试资格：未过期 + 未达上限 + 键仍在手 */
export function canRetryKey(hold: KeyHold, now: number): boolean {
  if (hold.key === null) return false
  if (hold.attempts >= MAX_ATTEMPTS) return false
  return !keyExpired(hold, now)
}
