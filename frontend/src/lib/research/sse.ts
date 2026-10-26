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
 * - Issue #439：`persistent_job_required`（引擎判定必须走持久化 Job）是
 *   **不可重试**码——重试同一请求恒徒劳，UI 改提供"以后台任务运行"入口；
 *   真实的排队/容量不足仍由 admission_capacity（可重试）表达。
 */

import type {
  ResearchAcceptedReceiptWire,
  ResearchCitation,
  ResearchContextCoverage,
  ResearchContextReportWire,
  ResearchSourceRef,
  ResearchSseEvent,
  ResearchSseType,
  ResearchTokenUsage,
} from './types'
import {
  parseSessionRef,
  type ResearchContextReportProjection,
  type ResearchSessionRef,
} from './session-contract'

/**
 * 受理回执投影（#602 第三批 PR-5a）：`session_ref` 经契约校验后转 camelCase。
 * 匹配时 generation_id/draft_token/editor_intent_hash 参与等值，request_id/
 * editor_revision 只记录（DESIGN §6.3 R7）。
 */
export interface ResearchAcceptedReceipt {
  readonly ref: ResearchSessionRef
  readonly generationId: string
  readonly requestId: string
  readonly editorRevision: number
  readonly draftToken: string
  readonly editorIntentHash: string
}


export const SSE_ERROR_CODES = [
  'admission_unavailable',
  'admission_capacity',
  'persistent_job_required',
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
  /** Issue #182：真实降级原因码集合（usage 事件携带；无则空数组） */
  degradationReasons: string[]
  /** Issue #182：本轮实际钉住的 source→document 版本（camelCase 视图在 turn 层转换） */
  sourceRef: ResearchSourceRef | null
  sessionId: string | null
  requestId: string | null
  jobId: string | null
  completionStatus: string | null
  terminal: 'done' | 'error' | null
  errorCode: string | null
  errorMessage: string | null
  /**
   * #602 PR-5a（§9.5）：受理回执投影。仅形状合法的 accepted 字段会被接受；
   * 非法整组丢弃，不阻断同事件其他字段。
   */
  accepted: ResearchAcceptedReceipt | null
  /** #602 PR-5a（§9.5/§6.9）：容量解释投影（渲染归 PR-5b）。 */
  contextReport: ResearchContextReportProjection | null
  /** #602 PR-5a（§9.5）：上下文覆盖投影。 */
  contextCoverage: ResearchContextCoverage | null
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
    degradationReasons: [],
    sourceRef: null,
    sessionId: null,
    requestId: null,
    jobId: null,
    completionStatus: null,
    terminal: null,
    errorCode: null,
    errorMessage: null,
    accepted: null,
    contextReport: null,
    contextCoverage: null,
    pending: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ID_STRING_MAX = 256
const MAX_32BIT = 2_147_483_647
const DRAFT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const INTENT_HASH_PATTERN = /^[a-f0-9]{64}$/

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isBoundedString(value: unknown, max = ID_STRING_MAX): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
}

function isCountOrNull(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_32BIT)
}

function isUniqueStringArray(value: unknown, max: number): value is string[] {
  if (!Array.isArray(value) || value.length > max) {
    return false
  }
  const seen = new Set<string>()
  for (const item of value) {
    if (!isBoundedString(item) || seen.has(item)) {
      return false
    }
    seen.add(item)
  }
  return true
}

/**
 * 校验 `accepted_receipt`（第一批 `$defs/accepted_receipt`）。
 * 形状非法返回 null（调用方整组丢弃，不污染同事件其他扩展字段）。
 */
export function parseAcceptedReceiptWire(value: unknown): ResearchAcceptedReceiptWire | null {
  if (!isRecord(value)) {
    return null
  }
  if (
    !hasOnlyKeys(value, [
      'session_ref',
      'generation_id',
      'request_id',
      'editor_revision',
      'draft_token',
      'editor_intent_hash',
    ])
  ) {
    return null
  }
  const refResult = parseSessionRef(value.session_ref)
  if (!refResult.ok) {
    return null
  }
  if (!isBoundedString(value.generation_id) || !isBoundedString(value.request_id)) {
    return null
  }
  const revision = value.editor_revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0 || revision > MAX_32BIT) {
    return null
  }
  if (typeof value.draft_token !== 'string' || !DRAFT_TOKEN_PATTERN.test(value.draft_token)) {
    return null
  }
  if (typeof value.editor_intent_hash !== 'string' || !INTENT_HASH_PATTERN.test(value.editor_intent_hash)) {
    return null
  }
  const ref = refResult.value
  return {
    session_ref: {
      domain: 'research',
      kind: ref.kind,
      project_id: ref.projectId,
      session_id: ref.sessionId,
      source_id: ref.sourceId,
    },
    generation_id: value.generation_id,
    request_id: value.request_id,
    editor_revision: revision,
    draft_token: value.draft_token,
    editor_intent_hash: value.editor_intent_hash,
  }
}

/** `accepted_receipt` wire → camelCase 投影；输入须已通过校验。 */
export function projectAcceptedReceipt(wire: ResearchAcceptedReceiptWire): ResearchAcceptedReceipt | null {
  const refResult = parseSessionRef(wire.session_ref)
  if (!refResult.ok) {
    return null
  }
  return {
    ref: refResult.value,
    generationId: wire.generation_id,
    requestId: wire.request_id,
    editorRevision: wire.editor_revision,
    draftToken: wire.draft_token,
    editorIntentHash: wire.editor_intent_hash,
  }
}

/** 校验 `context_report`（第一批 `$defs/context_report`）；非法返回 null。 */
export function parseContextReportWire(value: unknown): ResearchContextReportWire | null {
  if (!isRecord(value)) {
    return null
  }
  if (
    !hasOnlyKeys(value, [
      'version',
      'status',
      'history',
      'evidence',
      'input_budget',
      'serialized_input_tokens',
      'estimator_version',
      'reason_codes',
      'required_context_missing',
      'measurement_scope',
    ])
  ) {
    return null
  }
  if (value.version !== 1) {
    return null
  }
  const status = value.status
  if (status !== 'complete' && status !== 'trimmed' && status !== 'blocked' && status !== 'unknown') {
    return null
  }
  const history = value.history
  if (
    !isRecord(history)
    || !hasOnlyKeys(history, ['available_turns', 'included_turns', 'omitted_turns'])
    || !isCountOrNull(history.available_turns)
    || !isCountOrNull(history.included_turns)
    || !isCountOrNull(history.omitted_turns)
  ) {
    return null
  }
  const evidence = value.evidence
  if (
    !isRecord(evidence)
    || !hasOnlyKeys(evidence, ['included_chunks', 'omitted_chunks'])
    || !isCountOrNull(evidence.included_chunks)
    || !isCountOrNull(evidence.omitted_chunks)
  ) {
    return null
  }
  if (!isCountOrNull(value.input_budget) || !isCountOrNull(value.serialized_input_tokens)) {
    return null
  }
  if (value.estimator_version !== null && !isBoundedString(value.estimator_version)) {
    return null
  }
  if (!isUniqueStringArray(value.reason_codes, 1000)) {
    return null
  }
  if (typeof value.required_context_missing !== 'boolean') {
    return null
  }
  if (value.measurement_scope !== 'final_reasoning_call' && value.measurement_scope !== 'unknown') {
    return null
  }
  return {
    version: 1,
    status,
    history: {
      available_turns: history.available_turns,
      included_turns: history.included_turns,
      omitted_turns: history.omitted_turns,
    },
    evidence: {
      included_chunks: evidence.included_chunks,
      omitted_chunks: evidence.omitted_chunks,
    },
    input_budget: value.input_budget,
    serialized_input_tokens: value.serialized_input_tokens,
    estimator_version: value.estimator_version,
    reason_codes: value.reason_codes,
    required_context_missing: value.required_context_missing,
    measurement_scope: value.measurement_scope,
  }
}

/** `context_report` wire → camelCase 投影；输入须已通过校验。 */
export function projectContextReport(wire: ResearchContextReportWire): ResearchContextReportProjection {
  return {
    version: 1,
    status: wire.status,
    history: {
      availableTurns: wire.history.available_turns,
      includedTurns: wire.history.included_turns,
      omittedTurns: wire.history.omitted_turns,
    },
    evidence: {
      includedChunks: wire.evidence.included_chunks,
      omittedChunks: wire.evidence.omitted_chunks,
    },
    inputBudget: wire.input_budget,
    serializedInputTokens: wire.serialized_input_tokens,
    estimatorVersion: wire.estimator_version,
    reasonCodes: wire.reason_codes,
    requiredContextMissing: wire.required_context_missing,
    measurementScope: wire.measurement_scope,
  }
}

/** 校验 `context_coverage`（第一批 `$defs/context_coverage`，允许额外字段）；非法返回 null。 */
export function parseContextCoverageWire(value: unknown): ResearchContextCoverage | null {
  if (!isRecord(value)) {
    return null
  }
  const numericKeys = ['selected_full', 'relevant_extra', 'trimmed', 'missing', 'token_estimate', 'input_budget'] as const
  for (const key of numericKeys) {
    if (key in value && !isCountOrNull(value[key])) {
      return null
    }
  }
  if ('context_level' in value && typeof value.context_level !== 'string') {
    return null
  }
  if ('estimator_version' in value && typeof value.estimator_version !== 'string') {
    return null
  }
  const coverage: ResearchContextCoverage = {}
  const mutable = coverage as Record<string, string | number | null | undefined>
  for (const key of numericKeys) {
    if (key in value) {
      mutable[key] = value[key] as number | null
    }
  }
  if (typeof value.context_level === 'string') {
    mutable.context_level = value.context_level
  }
  if (typeof value.estimator_version === 'string') {
    mutable.estimator_version = value.estimator_version
  }
  return coverage
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
  if (isRecord(payload.usage)) event.usage = payload.usage as unknown as ResearchTokenUsage
  if (typeof payload.resolved_mode === 'string') event.resolved_mode = payload.resolved_mode
  if (
    Array.isArray(payload.degradation_reasons)
    && payload.degradation_reasons.length > 0
    && payload.degradation_reasons.every((r) => typeof r === 'string')
  ) {
    // Issue #182：原因码集合必须全为字符串（含混合非法元素时整组丢弃）
    event.degradation_reasons = payload.degradation_reasons as string[]
  }
  if (
    isRecord(payload.source_ref)
    && typeof payload.source_ref.source_id === 'string'
    && typeof payload.source_ref.document_id === 'string'
    && typeof payload.source_ref.document_version === 'string'
  ) {
    event.source_ref = {
      source_id: payload.source_ref.source_id,
      document_id: payload.source_ref.document_id,
      document_version: payload.source_ref.document_version,
    }
  }
  if (typeof payload.session_id === 'string') event.session_id = payload.session_id
  if (typeof payload.request_id === 'string') event.request_id = payload.request_id
  if (typeof payload.job_id === 'string' || payload.job_id === null) event.job_id = payload.job_id
  if (typeof payload.completion_status === 'string') event.completion_status = payload.completion_status
  if (typeof payload.code === 'string') event.code = payload.code
  if (typeof payload.message === 'string') event.message = payload.message
  // #602 PR-5a：usage 事件的三个扩展字段逐个校验；非法形状整组丢弃，不影响
  // 同事件其他字段（§9.5 / 第一批 response_composition.sse_usage_extensions）。
  const accepted = parseAcceptedReceiptWire(payload.accepted)
  if (accepted !== null) event.accepted = accepted
  const contextReport = parseContextReportWire(payload.context_report)
  if (contextReport !== null) event.context_report = contextReport
  const contextCoverage = parseContextCoverageWire(payload.context_coverage)
  if (contextCoverage !== null) event.context_coverage = contextCoverage
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
  const base = {
    ...state,
    lastEventId: event.event_id,
    degradationReasons: event.degradation_reasons ?? state.degradationReasons,
    sourceRef: event.source_ref ?? state.sourceRef,
    // #602 PR-5a（§9.5）：扩展字段随事件合并；非法已由 parse 阶段整组丢弃。
    accepted: event.accepted ? (projectAcceptedReceipt(event.accepted) ?? state.accepted) : state.accepted,
    contextReport: event.context_report ? projectContextReport(event.context_report) : state.contextReport,
    contextCoverage: event.context_coverage ?? state.contextCoverage,
  }
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
