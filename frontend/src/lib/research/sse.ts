/**
 * SSE 契约纯 reducer（UI-03，契约 v0 §9）。
 *
 * 语义（全部为纯函数，不触碰 window/fetch，可直接单元测试）：
 * - `event_id` 单调递增（从 1 起）；客户端按 `event_id` 去重与排序，
 *   乱序/重复事件必须可容忍（§9.2）。
 * - 每个流恰好一个终态（done/error）；终态后不再接受任何事件（§9.3）。
 * - `lastEventId` 即断线重连的 `Last-Event-ID` 依据（§9.5）：重连后
 *   `n+1` 起的增量才被应用。
 * - 错误码与可重试集合见 §9.4（admission_unavailable/admission_capacity/
 *   internal 可重试；project_deleted/epoch_mismatch/job_cancelled 不可重试）。
 */

import type { ResearchCitation, ResearchSseEvent, ResearchSseType, ResearchTokenUsage } from './types'

export const SSE_ERROR_CODES = [
  'admission_unavailable',
  'admission_capacity',
  'project_deleted',
  'epoch_mismatch',
  'job_cancelled',
  'internal',
] as const

export type ResearchSseErrorCode = (typeof SSE_ERROR_CODES)[number]

/** 契约 §9.4：可重试错误码（客户端展示可重试提示） */
export const RETRYABLE_SSE_ERROR_CODES: readonly string[] = [
  'admission_unavailable',
  'admission_capacity',
  'internal',
]

export interface ResearchSseState {
  /** 已处理的最大 event_id（重连 Last-Event-ID 依据） */
  lastEventId: number
  thinking: string
  answer: string
  citations: ResearchCitation[]
  usage: ResearchTokenUsage | null
  resolvedMode: string | null
  sessionId: string | null
  requestId: string | null
  jobId: string | null
  completionStatus: string | null
  terminal: 'done' | 'error' | null
  errorCode: string | null
  errorMessage: string | null
  /** 乱序事件缓冲（按 event_id 升序），内部状态 */
  pending: ResearchSseEvent[]
}

export function createSseState(): ResearchSseState {
  return {
    lastEventId: 0,
    thinking: '',
    answer: '',
    citations: [],
    usage: null,
    resolvedMode: null,
    sessionId: null,
    requestId: null,
    jobId: null,
    completionStatus: null,
    terminal: null,
    errorCode: null,
    errorMessage: null,
    pending: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验并规范化单个 SSE 事件载荷；非法载荷返回 null（调用方丢弃）。
 * 契约 §9.1 必填字段：event_id（正整数）/type（六类之一）。
 */
export function parseResearchEvent(payload: unknown): ResearchSseEvent | null {
  if (!isRecord(payload)) {
    return null
  }
  const { event_id, type } = payload
  if (typeof event_id !== 'number' || !Number.isInteger(event_id) || event_id < 1) {
    return null
  }
  const SSE_TYPES: readonly string[] = ['thinking', 'answer', 'citation', 'usage', 'done', 'error']
  if (typeof type !== 'string' || !(SSE_TYPES as readonly string[]).includes(type)) {
    return null
  }
  const event: ResearchSseEvent = { event_id, type: type as ResearchSseType }
  if (typeof payload.delta === 'string') event.delta = payload.delta
  if (Array.isArray(payload.citations)) event.citations = payload.citations as ResearchCitation[]
  if (isRecord(payload.usage)) event.usage = payload.usage as ResearchTokenUsage
  if (typeof payload.resolved_mode === 'string') event.resolved_mode = payload.resolved_mode
  if (typeof payload.session_id === 'string') event.session_id = payload.session_id
  if (typeof payload.request_id === 'string') event.request_id = payload.request_id
  if (typeof payload.job_id === 'string' || payload.job_id === null) event.job_id = payload.job_id
  if (typeof payload.completion_status === 'string') event.completion_status = payload.completion_status
  if (typeof payload.code === 'string') event.code = payload.code
  if (typeof payload.message === 'string') event.message = payload.message
  return event
}

function mergeCitations(existing: ResearchCitation[], incoming: ResearchCitation[]): ResearchCitation[] {
  const merged = [...existing]
  for (const citation of incoming) {
    if (!merged.some((c) => c.citation_id === citation.citation_id)) {
      merged.push(citation)
    }
  }
  return merged
}

/** 应用单个已确认连续的事件（内部：前置校验已完成） */
function applyOne(state: ResearchSseState, event: ResearchSseEvent): ResearchSseState {
  const base = { ...state, lastEventId: event.event_id }
  switch (event.type) {
    case 'thinking':
      return { ...base, thinking: base.thinking + (event.delta ?? '') }
    case 'answer':
      return { ...base, answer: base.answer + (event.delta ?? '') }
    case 'citation':
      return { ...base, citations: mergeCitations(base.citations, event.citations ?? []) }
    case 'usage':
      return { ...base, usage: event.usage ?? null, resolvedMode: event.resolved_mode ?? base.resolvedMode }
    case 'done':
      return {
        ...base,
        sessionId: event.session_id ?? null,
        requestId: event.request_id ?? null,
        jobId: event.job_id ?? null,
        completionStatus: event.completion_status ?? null,
        terminal: 'done',
      }
    case 'error':
      return {
        ...base,
        errorCode: event.code ?? null,
        errorMessage: event.message ?? null,
        terminal: 'error',
      }
  }
}

/**
 * 解析单个 SSE 帧（`event: <type>` + 一行或多行 `data: <json>`）。
 * 忽略 `id:`/`retry:` 行；event 名与载荷 `type` 不一致或 JSON 非法 → null。
 * 多行 data 按 SSE 规范以 `\n` 拼接后整体解析。
 */
export function parseSseFrame(frame: string): ResearchSseEvent | null {
  let eventType: string | null = null
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
    // id:/retry:/comment 等行忽略
  }
  if (eventType === null || dataLines.length === 0) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }
  const event = parseResearchEvent(payload)
  if (event === null || event.type !== eventType) {
    return null
  }
  return event
}

/**
 * 应用一个事件到当前流状态（纯函数，不修改入参）。
 * - 终态已设置 → 忽略（终态一次，§9.3）。
 * - `event_id <= lastEventId` → 忽略（重复/重放，§9.2/§9.5）。
 * - `event_id === lastEventId + 1` → 立即应用；更大则入缓冲按序排齐
 *   （乱序容忍，§9.2）。
 */
export function applySseEvent(state: ResearchSseState, event: ResearchSseEvent): ResearchSseState {
  if (state.terminal) {
    return state
  }
  if (!Number.isInteger(event.event_id) || event.event_id < 1) {
    return state
  }
  if (event.event_id <= state.lastEventId) {
    return state
  }

  let cursor: ResearchSseState = state
  let pending = state.pending
  if (event.event_id === state.lastEventId + 1) {
    cursor = applyOne(state, event)
  } else {
    pending = [...pending, event].sort((a, b) => a.event_id - b.event_id)
  }

  // 排空连续段：从 cursor.lastEventId + 1 起逐个应用（终态出现即停止）
  let applied = true
  while (applied && !cursor.terminal) {
    applied = false
    const nextId = cursor.lastEventId + 1
    const index = pending.findIndex((e) => e.event_id === nextId)
    if (index >= 0) {
      const [nextEvent] = pending.splice(index, 1)
      cursor = applyOne(cursor, nextEvent)
      applied = true
    }
  }

  return { ...cursor, pending }
}
