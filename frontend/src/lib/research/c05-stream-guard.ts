/**
 * Issue #601 PR5（D-24）：SSE 传输层守卫——handover §5.3「传输（fork 侧修改，
 * PR5 落地）」的四条冻结规则，抽为**可单测的纯函数**，由 `api.ts` 的
 * `openResearchChatStream` 与 `use-research-chat` 消费。
 *
 * 四条规则：
 * 1. `API_TIMEOUT_MS` 正数作用于等待响应及 JSON 完整 body 读取／解析；
 *    `0` 明确禁用超时。流侧对应"空闲计时"（见 2），不是总时长上限。
 * 2. SSE：**校验状态与 `Content-Type` 之后**才切换为流空闲计时；收到字节／
 *    heartbeat 重置空闲，**不把 heartbeat 当模型进度**。
 * 3. abort 原因**区分**（timeout／用户取消／身份／页面变化／正常结束）；
 *    **仅 `timeout` 可进入既有有界策略**；每次尝试**只结算一次**。
 * 4. `Last-Event-ID`、事件去重、终态恰好一次保持；**不**新增 SSE 事件类型。
 */

import { API_TIMEOUT_MS } from '@/lib/api/client'

/**
 * 流空闲预算。与 axios 客户端共用同一可配置预算（`NEXT_PUBLIC_API_TIMEOUT_MS`，
 * 默认 10 分钟；`0` 禁用）——`use-ask.ts` 的既有 SSE 看门狗是同一约定。
 */
export const STREAM_IDLE_TIMEOUT_MS = API_TIMEOUT_MS

/** 合法的 SSE 响应头（允许 `text/event-stream; charset=utf-8` 这类参数） */
export function isSseContentType(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  return value.split(';')[0].trim().toLowerCase() === 'text/event-stream'
}

/** abort／结束原因（§5.3 第 3 行的五分类） */
export type ResearchStreamEndReason =
  /** 传输空闲超时（唯一可进入有界重试的 abort 原因） */
  | 'timeout'
  /** 用户显式取消/停止 */
  | 'user_cancel'
  /** 身份变化（登出、token 清除、会话失效） */
  | 'identity'
  /** 页面变化（卸载、切换项目/工作台） */
  | 'page_change'
  /** 正常读尽（EOF） */
  | 'normal_end'
  /** 已收到 SSE 终态（done/error）——本地收尾，不重试（评审 MEDIUM-6） */
  | 'terminal_reached'

/**
 * 仅 `timeout` 可进入既有有界重试策略；用户取消/身份/页面变化一律不得重试
 * （重试它们等于违背用户意图或把请求发给已失效的身份）。
 * `normal_end`／`terminal_reached` 不是"需要重试的 abort"：前者是否重连由
 * 调用方按 SSE 终态判定，后者表示终态已到达、本地收尾。
 */
export function isTimeoutRetryEligible(reason: ResearchStreamEndReason): boolean {
  return reason === 'timeout'
}

/**
 * 每次尝试**只结算一次**。传输层可能同时触发多条终止路径（例如 abort 同时
 * 让 `read()` 抛 AbortError 与空闲计时回调），若各自都上报，调用方会看到
 * "一次尝试两次失败"——重连计数与错误呈现都会被放大。
 */
export function createAttemptSettlement(): { settle: () => boolean } {
  let settled = false
  return {
    settle: () => {
      if (settled) return false
      settled = true
      return true
    },
  }
}

/**
 * 该状态码在上层是否带有"可自愈/可重试"语义（审查轮 3 L1）。
 *
 * 409 有 `generation_in_progress` 的同键自愈路径（原 gen 完成后同键 POST 走
 * completed-replay）；429/5xx 属临时不可用，调用方本就有有界重试。若把
 * "状态已知但响应体读不完"一律按终态 HTTP 错误上报，这些恢复路径就不可达了
 * （用户重发会产生新键 = 新的付费执行）。因此这类状态在超时上报时保留
 * timeout 语义，交回调用方既有的有界策略。
 */
export function hasRetrySemanticsStatus(status: number): boolean {
  return status === 409 || status === 429 || status >= 500
}

/**
 * heartbeat/keepalive 只是传输活跃信号，**不是**模型进度。
 * 返回 true 时调用方只重置空闲计时，不得改写 turn 的流式状态、
 * 不得把内容当作模型输出。
 */
export function isHeartbeatComment(frame: string): boolean {
  const trimmed = frame.trim()
  if (trimmed === '') return false
  return trimmed.split('\n').every((line) => line.startsWith(':') || line.trim() === '')
}
