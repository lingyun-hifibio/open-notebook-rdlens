/**
 * 纯对话状态机（#602 第三批 PR-5a，DESIGN §6.1–§6.8、§9.2）。
 *
 * 职责边界（全部为纯函数，不触碰 fetch/window/React）：
 * - turn 身份与状态：idle → preparing → submitting → accepted → streaming →
 *   terminal；submitting → unknown → lookup_pending → accepted/terminal/
 *   not_observed。
 * - 受理回执匹配：`session_ref + generation_id + draft_token +
 *   editor_intent_hash` 参与等值；`editor_revision`/`request_id` 只记录
 *   （§6.3 R7）。`generationId` 初始为 null，仅当前有效 attempt 的合法
 *   accepted 首次绑定，之后严格等值；**禁止用 null == null 作为同一执行证据**。
 * - 迟到隔离：所有流回调必须携带 `turnId + attempt`，且 turn 未 detached；
 *   旧 attempt / 已 detach 的回调（包括已解码事件）一律丢弃（§6.4/§6.6）。
 * - 终态锁：terminal 之后不再接受任何流事件；上一轮终态不得被新 send 改写，
 *   新 send 进入新 turn，旧 turn 完整保留在 history。
 * - 水位：每个 turn 独立维护 `lastEventId`（turns 之间可从 1 重新计数）；
 *   `resume_after > lastEventId + 1` 一律转 durable/lookup，绝不跳水位把残缺
 *   增量标成完整答案（§6.2/§6.5）。
 * - 查回/结算：unknown 进入 lookup_pending，submit hold 保留到 lookup 结算；
 *   `not_observed` 不是“未受理”，保留草稿与标记；settlement 只释放当前
 *   operationId 的 hold，不开放无提示的新执行（§5.6/§6.7）。
 *
 * 该模块只做决策，并返回副作用描述 `ConversationEffect[]`，由 controller
 * （session-runtime / hooks）执行，便于纯单测与变异红检。
 */

import { applySseEvent, createSseState } from './sse'
import type { ResearchAcceptedReceipt, ResearchSseState } from './sse'
import { sessionKey } from './session-contract'
import type { ResearchSessionRef } from './session-contract'
import type { ResearchSseEvent } from './types'

/** turn 状态（DESIGN §6.3 状态图）。 */
export type ConversationTurnState =
  | 'idle'
  | 'preparing'
  | 'submitting'
  | 'accepted'
  | 'streaming'
  | 'terminal'
  | 'unknown'
  | 'not_observed'
  | 'lookup_pending'

/** 终态类型；`null` 表示尚未终态。 */
export type ConversationTerminal = 'done' | 'error' | null

/** 受理状态投影（与 `submission_response.acceptance_state` 一致）。 */
export type ConversationAcceptanceState = 'not_observed' | 'accepted' | 'terminal' | 'outcome_unknown'

/**
 * 活动 turn 身份（DESIGN §6.4 ActiveTurnIdentity）。
 * 所有字段只读；reducer 以新对象替换。
 */
export interface ConversationTurnIdentity {
  readonly authGeneration: number
  /** research.v1 规范化会话键（与 session-contract.sessionKey 一致） */
  readonly sessionKey: string
  /** 服务端 session_id（用于校验 SSE response 头 / 事件 session_id；外部查回可为空） */
  readonly sessionId?: string
  readonly turnId: string
  readonly draftToken: string
  readonly idempotencyKey: string
  /** 发送时编辑器 revision（仅记录，不参与受理等值） */
  readonly requestedRevision: number
  /** 发送时服务端返回的 intent hash（客户端不自行计算） */
  readonly editorIntentHash: string
  /** accepted 回执记录的服务端 revision（用于后续清稿决策/展示） */
  readonly observedRevision: number | null
  /** 首次合法 accepted 绑定；之后严格等值 */
  readonly generationId: string | null
  /** 本次订阅的 attempt（重连 +1）；回调必须携带匹配 attempt */
  readonly attempt: number
  /** 当前 turn 已应用的最大事件水位（各 turn 独立） */
  readonly lastEventId: number
  /** 离开会话/隐藏面板后为 true，使旧回调失效 */
  readonly detached: boolean
  readonly terminal: ConversationTerminal
}

/** 所有流回调的守卫参数（DESIGN §6.4）。 */
export interface ConversationCallbackGuard {
  readonly authGeneration: number
  readonly sessionKey: string
  readonly turnId: string
  readonly attempt?: number
  readonly detached?: boolean
}

/** 查回结果（controller 把 submission_response 投影成该形状）。 */
export interface ConversationSubmissionView {
  readonly ref: ResearchSessionRef
  readonly token: string
  readonly idempotencyKey: string
  readonly acceptance: ConversationAcceptanceState
  readonly generationId: string | null
  readonly generationState: string | null
  readonly acceptedEditorRevision: number | null
  readonly editorIntentHash: string | null
  readonly submittedDraftText: string | null
}

/** 查回尝试的本轮记录（bounded lookup 用）。 */
export interface ConversationLookupState {
  readonly token: string
  readonly view: ConversationSubmissionView | null
  readonly failures: number
  readonly lastFailure: 'network' | 'protocol' | 'not_found' | null
}

/** 一个对话 turn（含投影后的 SSE 状态）。 */
export interface ConversationTurn {
  readonly identity: ConversationTurnIdentity
  readonly state: ConversationTurnState
  readonly sse: ResearchSseState
  readonly query: string
  /** submit hold 的操作 id；无 hold 时为 null */
  readonly operationId: string | null
  readonly accepted: ResearchAcceptedReceipt | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  /** 是否检测到不可续接的水位缺口（转 durable 后为 true） */
  readonly gapDetected: boolean
  readonly lookup: ConversationLookupState | null
  /** accepted 已排队清稿（clearAfterSubmission 已派发）→ 终态不得提前 release。 */
  readonly clearPending: boolean
  /** 查回/恢复得到的答案是否不完整（缺口后 durable 恢复前为 true）。 */
  readonly incomplete: boolean
  /** 冷启动/无 turn 的外部 token 查回（不绑定编辑器快照）。 */
  readonly external: boolean
}

/** 对话状态（每 session 一份）。 */
export interface ConversationState {
  readonly sessionKey: string
  readonly authGeneration: number
  readonly turn: ConversationTurn | null
  /** 已结束/被替换的 turn 历史（终态绝不改写） */
  readonly history: readonly ConversationTurn[]
  /** 单调递增序号（便于快照缓存与调试） */
  readonly sequence: number
}

/** controller 需要执行的副作用描述（纯数据，可断言）。 */
export type ConversationEffect =
  | { readonly type: 'release_hold'; readonly operationId: string | null }
  | {
      readonly type: 'clear_after_submission'
      readonly receipt: ResearchAcceptedReceipt
      readonly operationId: string
    }
  | {
      readonly type: 'lookup_submission'
      readonly token: string | null
      readonly reason: 'unknown' | 'disconnect' | 'reattach' | 'cold_start' | 'manual'
    }
  | { readonly type: 'abort_stream'; readonly turnId: string }
  | { readonly type: 'durable_restore'; readonly token: string }
  | {
      readonly type: 'open_stream'
      readonly turnId: string
      readonly attempt: number
      readonly lastEventId: number
    }

/** reducer 返回值：新状态 + 待执行副作用。 */
export interface ConversationReduction {
  readonly state: ConversationState
  readonly effects: readonly ConversationEffect[]
}

/** turn 身份构造种子（controller / 测试使用）。 */
export interface ConversationTurnSeed {
  readonly authGeneration: number
  readonly sessionKey: string
  readonly sessionId?: string
  readonly turnId: string
  readonly draftToken: string
  readonly idempotencyKey: string
  readonly requestedRevision: number
  readonly editorIntentHash: string
}

/** 新建 turn 身份：generationId 未绑定、未 detached、未终态、水位为 0。 */
export function createTurnIdentity(seed: ConversationTurnSeed): ConversationTurnIdentity {
  return {
    authGeneration: seed.authGeneration,
    sessionKey: seed.sessionKey,
    sessionId: seed.sessionId,
    turnId: seed.turnId,
    draftToken: seed.draftToken,
    idempotencyKey: seed.idempotencyKey,
    requestedRevision: seed.requestedRevision,
    editorIntentHash: seed.editorIntentHash,
    observedRevision: null,
    generationId: null,
    attempt: 0,
    lastEventId: 0,
    detached: false,
    terminal: null,
  }
}

/** 创建空对话状态。 */
export function createConversationState(input: {
  readonly sessionKey: string
  readonly authGeneration: number
}): ConversationState {
  return {
    sessionKey: input.sessionKey,
    authGeneration: input.authGeneration,
    turn: null,
    history: [],
    sequence: 0,
  }
}

/** 回调守卫：`{sessionKey, authGeneration, turnId, attempt?, detached?}` 全部匹配才生效。 */
export function turnIdentityMatches(
  identity: ConversationTurnIdentity,
  guard: ConversationCallbackGuard,
): boolean {
  if (identity.authGeneration !== guard.authGeneration) {
    return false
  }
  if (identity.sessionKey !== guard.sessionKey) {
    return false
  }
  if (identity.turnId !== guard.turnId) {
    return false
  }
  if (guard.attempt !== undefined && identity.attempt !== guard.attempt) {
    return false
  }
  if (guard.detached !== undefined && identity.detached !== guard.detached) {
    return false
  }
  return true
}

/**
 * SSE 事件的 session_id 必须与当前 turn 的 session_id 一致；事件缺失该字段
 * 时视为兼容（旧 batch-2 服务端），但不放松 turn 级守卫。
 */
export function eventSessionMatches(
  identity: ConversationTurnIdentity,
  event: ResearchSseEvent,
): boolean {
  const sessionId = (event as { readonly session_id?: unknown }).session_id
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return true
  }
  if (identity.sessionId === undefined || identity.sessionId.length === 0) {
    return true
  }
  return identity.sessionId === sessionId
}

/**
 * 查回结果与 turn 身份的完整匹配（DESIGN §6.7）：session_ref + draft_token +
 * idempotency_key + editor_intent_hash + 已绑定 generationId。
 * `external`（冷启动无编辑器快照）只校验 session_ref + token。
 */
export function submissionViewMatches(
  sessionKeyValue: string,
  identity: ConversationTurnIdentity,
  view: ConversationSubmissionView,
  external: boolean,
): boolean {
  if (sessionKey(view.ref) !== sessionKeyValue) {
    return false
  }
  if (view.token !== identity.draftToken) {
    return false
  }
  if (external) {
    return true
  }
  if (
    view.idempotencyKey.length > 0
    && identity.idempotencyKey.length > 0
    && view.idempotencyKey !== identity.idempotencyKey
  ) {
    return false
  }
  if (
    view.editorIntentHash !== null
    && view.editorIntentHash.length > 0
    && view.editorIntentHash !== identity.editorIntentHash
  ) {
    return false
  }
  if (
    identity.generationId !== null
    && view.generationId !== null
    && view.generationId !== identity.generationId
  ) {
    return false
  }
  return true
}

/**
 * 受理回执等值匹配（DESIGN §6.3）：
 * session_ref + draft_token + editor_intent_hash 必须相等；generationId 首次绑定，
 * 已绑定后必须严格相等；`request_id`/`editor_revision` 不参与匹配（R7）。
 */
export function acceptedReceiptMatches(
  identity: ConversationTurnIdentity,
  receipt: ResearchAcceptedReceipt,
): boolean {
  if (sessionKey(receipt.ref) !== identity.sessionKey) {
    return false
  }
  if (receipt.draftToken !== identity.draftToken) {
    return false
  }
  if (receipt.editorIntentHash !== identity.editorIntentHash) {
    return false
  }
  if (identity.generationId !== null && receipt.generationId !== identity.generationId) {
    return false
  }
  return true
}

/** 查回并发上限（DESIGN §3.5：≤2）。 */
export const MAX_CONCURRENT_SUBMISSION_LOOKUPS = 2
/** 热恢复重连上限（DESIGN §6.5：最多 3 次退避）。 */
export const MAX_REATTACH_ATTEMPTS = 3
/** 有限查回失败次数上限（超过即 settle 为 unknown）。 */
export const BOUNDED_LOOKUP_FAILURES = 3

/**
 * 查回顺序计划：active token → 当前 draft token → 其余历史标记；
 * 分批返回，每批最多 `maxConcurrent`（默认 2）个，保持顺序（§3.5/§6.7）。
 * 不得因等待历史标记而阻塞编辑（调用方只并行执行首批）。
 */
export function planSubmissionLookups(input: {
  readonly activeToken?: string | null
  readonly draftToken?: string | null
  readonly markers?: readonly string[]
  readonly maxConcurrent?: number
}): readonly (readonly string[])[] {
  const max = Math.max(1, Math.min(input.maxConcurrent ?? MAX_CONCURRENT_SUBMISSION_LOOKUPS, MAX_CONCURRENT_SUBMISSION_LOOKUPS))
  const ordered: string[] = []
  const push = (token: string | null | undefined): void => {
    if (typeof token !== 'string' || token.length === 0 || ordered.includes(token)) {
      return
    }
    ordered.push(token)
  }
  push(input.activeToken)
  push(input.draftToken)
  for (const marker of input.markers ?? []) {
    push(marker)
  }
  const batches: string[][] = []
  for (let index = 0; index < ordered.length; index += max) {
    batches.push(ordered.slice(index, index + max))
  }
  return batches
}

/** 失败分类结果。 */
export type ConversationFailureClass = 'not_accepted' | 'unknown' | 'stale' | 'terminal'

export interface ConversationFailureInput {
  readonly status?: number | null
  readonly code?: string | null
  /** 服务端/响应体是否明确表达受理结果 */
  readonly acceptance?: 'accepted' | 'not_accepted' | 'unknown' | null
  /** EOF 前是否已见到 terminal 事件 */
  readonly hadTerminal?: boolean
}

const DEFINITE_NON_ACCEPTANCE_STATUS = new Set([413, 422, 426, 400, 402])

/**
 * 稳定错误码中“一定未受理”的集合（在验收前被拒绝/参数非法/能力未启用）。
 * 注意：`session_store_unavailable`/`input_snapshot_unavailable` 等无受理知识的
 * 503 不在此列，必须转查回（review-1 P1-#4）。
 */
const DEFINITE_NOT_ACCEPTED_CODES = new Set([
  'c05_contract_not_enabled',
  'c05_entry_not_ready',
  'editor_state_invalid',
  'session_contract_unsupported',
  'input_snapshot_invalid',
  'context_limit_exceeded',
  'invalid_request',
  'session_context_changed',
])

/**
 * 提交失败分类（DESIGN §6.4/§7）：
 * - 401 → stale（停止应用，不清本地草稿）；
 * - 明确 not_accepted（426/503/422/413 等）→ not_accepted，不得进入 unknown；
 * - 409 acceptance_outcome_unknown / stream_identity_mismatch、无受理知识的
 *   5xx/网络/EOF → unknown（只查回，不换 key）；
 * - 其他明确协议/终态错误 → terminal。
 */
export function classifySubmissionFailure(input: ConversationFailureInput): ConversationFailureClass {
  const status = input.status ?? null
  const code = input.code ?? null
  if (status === 401) {
    return 'stale'
  }
  // 优先级（review-1 P1-#4）：受理知识/recovery_action → 稳定码 → 未知传输错误。
  if (code === 'acceptance_outcome_unknown') {
    return 'unknown'
  }
  if (input.acceptance === 'unknown') {
    return 'unknown'
  }
  if (input.acceptance === 'not_accepted') {
    return 'not_accepted'
  }
  if (code !== null && DEFINITE_NOT_ACCEPTED_CODES.has(code)) {
    return 'not_accepted'
  }
  if (status === 409) {
    if (
      code === 'generation_in_progress'
      || code === 'stream_identity_mismatch'
      || code === 'session_store_unavailable'
    ) {
      // 执行可能仍在运行：不得释放 hold / 另开新意图，转查回保持原身份。
      return 'unknown'
    }
    if (code === 'session_context_changed') {
      // 会话上下文已变：本次未被受理，保留输入，允许以新快照重发。
      return 'not_accepted'
    }
    if (code === 'submission_intent_conflict' || code === 'session_busy') {
      return 'terminal'
    }
    return 'unknown'
  }
  if (status !== null && DEFINITE_NON_ACCEPTANCE_STATUS.has(status)) {
    return 'not_accepted'
  }
  if (status !== null && status >= 500) {
    // 无受理知识（如 session_store_unavailable）→ 查回，不能判 not_accepted。
    return 'unknown'
  }
  if (status === null) {
    return input.hadTerminal ? 'terminal' : 'unknown'
  }
  if (status === 403 || status === 404) {
    return 'terminal'
  }
  return 'unknown'
}

/**
 * 是否需要在改稿后发送前显式确认“可能重复执行”（§6.3 not_observed/unknown）：
 * 当前活动 turn 处于 unknown/not_observed 且新发送 draftToken 不同 → true。
 */
export function needsDuplicateExecutionConfirmation(
  state: ConversationState,
  nextDraftToken: string,
): boolean {
  const turn = state.turn
  if (turn === null) {
    return false
  }
  if (turn.state !== 'unknown' && turn.state !== 'not_observed' && turn.state !== 'lookup_pending') {
    return false
  }
  return turn.identity.draftToken !== nextDraftToken
}

/** reducer 事件定义（controller 按回调语义构造）。 */
export type ConversationEvent =
  | {
      readonly type: 'prepare'
      readonly identity: ConversationTurnIdentity
      readonly operationId: string
      readonly query: string
    }
  | { readonly type: 'prepare_succeeded'; readonly turnId: string }
  | { readonly type: 'prepare_failed'; readonly turnId: string; readonly reason: string }
  | { readonly type: 'accepted'; readonly turnId: string; readonly attempt: number; readonly receipt: ResearchAcceptedReceipt }
  | { readonly type: 'sse'; readonly turnId: string; readonly attempt: number; readonly event: ResearchSseEvent }
  | {
      readonly type: 'http_failure'
      readonly turnId: string
      readonly attempt: number
      readonly status: number
      readonly code: string | null
      readonly acceptance: 'accepted' | 'not_accepted' | 'unknown' | null
    }
  | { readonly type: 'network_failure'; readonly turnId: string; readonly attempt: number; readonly hadTerminal?: boolean }
  | { readonly type: 'stream_end'; readonly turnId: string; readonly attempt: number; readonly hadTerminal: boolean }
  | { readonly type: 'detach' }
  | {
      readonly type: 'reattach'
      readonly eligible: boolean
      readonly resumeAfter?: number | null
    }
  | {
      readonly type: 'lookup_result'
      readonly turnId: string
      readonly view: ConversationSubmissionView
    }
  | {
      readonly type: 'lookup_failure'
      readonly turnId: string
      readonly token: string
      readonly failure: 'network' | 'protocol' | 'not_found'
      readonly bounded: boolean
    }
  | {
      readonly type: 'manual_lookup'
      readonly token?: string | null
      readonly reason?: 'manual' | 'cold_start'
    }
  | {
      readonly type: 'clear_settled'
      readonly turnId: string
      readonly operationId: string
      readonly outcome: 'cleared' | 'superseded' | 'failed' | 'blocked'
    }
  | {
      readonly type: 'external_lookup'
      readonly token: string
      readonly sessionId?: string
    }
  | {
      readonly type: 'durable_restored'
      readonly turnId: string
      readonly complete: boolean
    }

function withTurn(state: ConversationState, turn: ConversationTurn): ConversationState {
  return { ...state, turn, sequence: state.sequence + 1 }
}

function archived(turn: ConversationTurn): ConversationTurn {
  return turn.identity.terminal === null
    ? { ...turn, identity: { ...turn.identity, detached: true } }
    : turn
}

function isTerminalState(turn: ConversationTurn): boolean {
  return turn.state === 'terminal' || turn.identity.terminal !== null
}

function pushHistory(state: ConversationState, turn: ConversationTurn): readonly ConversationTurn[] {
  return [...state.history, archived(turn)]
}

function settleRelease(turn: ConversationTurn): ConversationEffect {
  return { type: 'release_hold', operationId: turn.operationId }
}

function lookupEffect(
  turn: ConversationTurn,
  reason: 'unknown' | 'disconnect' | 'reattach' | 'cold_start' | 'manual',
  token?: string | null,
): ConversationEffect {
  return {
    type: 'lookup_submission',
    token: token ?? turn.identity.draftToken,
    reason,
  }
}

/** 进入 lookup_pending：保留 submit hold，记录查回原因，返回查回副作用。 */
function enterLookup(
  state: ConversationState,
  turn: ConversationTurn,
  reason: 'unknown' | 'disconnect' | 'reattach' | 'cold_start' | 'manual',
): ConversationReduction {
  const next: ConversationTurn = {
    ...turn,
    state: 'lookup_pending',
    lookup: turn.lookup ?? {
      token: turn.identity.draftToken,
      view: null,
      failures: 0,
      lastFailure: null,
    },
  }
  return {
    state: withTurn(state, next),
    effects: [lookupEffect(next, reason)],
  }
}

/** 进入终态并释放当前 turn 的 hold。 */
function enterTerminal(
  state: ConversationState,
  turn: ConversationTurn,
  terminal: 'done' | 'error',
  errorCode: string | null = null,
  errorMessage: string | null = null,
): ConversationReduction {
  const next: ConversationTurn = {
    ...turn,
    state: 'terminal',
    identity: { ...turn.identity, terminal },
    errorCode,
    errorMessage,
  }
  // 清稿已租约在途：hold 必须保留到 clear settlement（review-1 P1-#9）。
  return {
    state: withTurn(state, next),
    effects: turn.clearPending ? [] : [settleRelease(turn)],
  }
}

/** 根据 SSE 终态推导 turn 终态。 */
function terminalFromSse(sse: ResearchSseState): { terminal: 'done' | 'error'; errorCode: string | null; errorMessage: string | null } | null {
  if (sse.terminal === null) {
    return null
  }
  return {
    terminal: sse.terminal,
    errorCode: sse.errorCode,
    errorMessage: sse.errorMessage,
  }
}

/**
 * 应用一次状态转移。所有流回调事件都带 `turnId`（+ `attempt`），任何不匹配
 * 或 detached 的旧回调都原样返回（无副作用），这是迟到隔离的单一入口。
 */
export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationReduction {
  const unchanged: ConversationReduction = { state, effects: [] }
  const turn = state.turn

  switch (event.type) {
    case 'prepare': {
      if (turn !== null && !isTerminalState(turn) && turn.state !== 'idle') {
        // 每个 session 同时只允许一个活动 turn；未终结前不得被新 send 改写。
        return unchanged
      }
      if (event.identity.sessionKey !== state.sessionKey) {
        return unchanged
      }
      if (event.identity.authGeneration !== state.authGeneration) {
        return unchanged
      }
      const history = turn === null ? state.history : pushHistory(state, turn)
      const next: ConversationTurn = {
        identity: { ...event.identity, terminal: null, detached: false, lastEventId: 0, generationId: null },
        state: 'preparing',
        sse: createSseState(),
        query: event.query,
        operationId: event.operationId,
        accepted: null,
        errorCode: null,
        errorMessage: null,
        gapDetected: false,
        lookup: null,
        clearPending: false,
        incomplete: false,
        external: false,
      }
      return {
        state: { ...state, turn: next, history, sequence: state.sequence + 1 },
        effects: [],
      }
    }

    case 'prepare_succeeded': {
      if (turn === null || turn.identity.turnId !== event.turnId || isTerminalState(turn)) {
        return unchanged
      }
      if (turn.state !== 'preparing') {
        return unchanged
      }
      const next: ConversationTurn = {
        ...turn,
        state: 'submitting',
        identity: { ...turn.identity, attempt: turn.identity.attempt + 1 },
      }
      return {
        state: withTurn(state, next),
        effects: [
          {
            type: 'open_stream',
            turnId: next.identity.turnId,
            attempt: next.identity.attempt,
            lastEventId: 0,
          },
        ],
      }
    }

    case 'prepare_failed': {
      if (turn === null || turn.identity.turnId !== event.turnId) {
        return unchanged
      }
      if (turn.operationId === null) {
        return unchanged
      }
      const next: ConversationTurn = {
        ...turn,
        state: 'idle',
        operationId: null,
        errorCode: 'prepare_failed',
        errorMessage: event.reason,
      }
      return {
        state: withTurn(state, next),
        effects: [{ type: 'release_hold', operationId: turn.operationId }],
      }
    }

    case 'accepted': {
      if (turn === null || isTerminalState(turn)) {
        return unchanged
      }
      if (
        !turnIdentityMatches(turn.identity, {
          authGeneration: state.authGeneration,
          sessionKey: state.sessionKey,
          turnId: event.turnId,
          attempt: event.attempt,
          detached: false,
        })
      ) {
        return unchanged
      }
      // generationId 首次绑定只允许来自当前合法 attempt 的 accepted。
      if (!acceptedReceiptMatches(turn.identity, event.receipt)) {
        return unchanged
      }
      const next: ConversationTurn = {
        ...turn,
        state: 'accepted',
        accepted: event.receipt,
        clearPending: turn.operationId !== null ? true : turn.clearPending,
        identity: {
          ...turn.identity,
          generationId: turn.identity.generationId ?? event.receipt.generationId,
          observedRevision: event.receipt.editorRevision,
        },
      }
      const effects: ConversationEffect[] = []
      if (turn.operationId !== null) {
        effects.push({
          type: 'clear_after_submission',
          receipt: event.receipt,
          operationId: turn.operationId,
        })
      }
      return { state: withTurn(state, next), effects }
    }

    case 'sse': {
      if (turn === null || isTerminalState(turn)) {
        return unchanged
      }
      if (
        !turnIdentityMatches(turn.identity, {
          authGeneration: state.authGeneration,
          sessionKey: state.sessionKey,
          turnId: event.turnId,
          attempt: event.attempt,
          detached: false,
        })
      ) {
        return unchanged
      }
      // SSE 事件的 session_id 必须与当前 turn 一致（review-1 P1-#7）。
      if (!eventSessionMatches(turn.identity, event.event)) {
        return unchanged
      }
      let nextTurn: ConversationTurn = {
        ...turn,
        sse: applySseEvent(turn.sse, event.event),
        state: turn.state === 'submitting' || turn.state === 'streaming' ? 'streaming' : turn.state,
      }
      const sseWatermark = Math.max(nextTurn.identity.lastEventId, nextTurn.sse.lastEventId)
      nextTurn = {
        ...nextTurn,
        identity: { ...nextTurn.identity, lastEventId: sseWatermark },
      }
      // usage 事件可能携带受理回执：匹配后进入 accepted（不等待 HTTP 层）。
      if (event.event.accepted && nextTurn.state !== 'accepted') {
        const receiptFromSse = acceptedReceiptFromEvent(event.event.accepted)
        if (receiptFromSse !== null && !acceptedReceiptMatches(nextTurn.identity, receiptFromSse)) {
          // 已绑定 generationId 后收到不同执行的回执：整条事件丢弃，不能改写
          // 既有 accepted（review-1 P1-#7）。
          return unchanged
        }
        if (
          receiptFromSse !== null
          && nextTurn.identity.generationId === null
          && acceptedReceiptMatches(nextTurn.identity, receiptFromSse)
        ) {
          nextTurn = {
            ...nextTurn,
            state: 'accepted',
            accepted: receiptFromSse,
            clearPending: nextTurn.operationId !== null ? true : nextTurn.clearPending,
            identity: {
              ...nextTurn.identity,
              generationId: receiptFromSse.generationId,
              observedRevision: receiptFromSse.editorRevision,
            },
          }
          const effects: ConversationEffect[] = []
          if (nextTurn.operationId !== null) {
            effects.push({
              type: 'clear_after_submission',
              receipt: receiptFromSse,
              operationId: nextTurn.operationId,
            })
          }
          return { state: withTurn(state, nextTurn), effects }
        }
      }
      const terminal = terminalFromSse(nextTurn.sse)
      if (terminal !== null) {
        // 终态到达但未匹配到 accepted 回执：不得仅凭 done 清稿，转查回取全量状态。
        if (terminal.terminal === 'done' && nextTurn.accepted === null) {
          nextTurn = { ...nextTurn, gapDetected: false }
          return enterLookup(state, nextTurn, 'unknown')
        }
        const reduction = enterTerminal(
          state,
          nextTurn,
          terminal.terminal,
          terminal.errorCode,
          terminal.errorMessage,
        )
        return reduction
      }
      return { state: withTurn(state, nextTurn), effects: [] }
    }

    case 'http_failure': {
      if (turn === null || isTerminalState(turn)) {
        return unchanged
      }
      if (
        !turnIdentityMatches(turn.identity, {
          authGeneration: state.authGeneration,
          sessionKey: state.sessionKey,
          turnId: event.turnId,
          attempt: event.attempt,
          detached: false,
        })
      ) {
        return unchanged
      }
      const classification = classifySubmissionFailure({
        status: event.status,
        code: event.code,
        acceptance: event.acceptance,
      })
      if (classification === 'stale') {
        return unchanged
      }
      if (classification === 'not_accepted') {
        const next: ConversationTurn = {
          ...turn,
          state: 'idle',
          errorCode: event.code ?? `http_${event.status}`,
          errorMessage: null,
        }
        return {
          state: withTurn(state, next),
          effects: [settleRelease(turn)],
        }
      }
      if (classification === 'terminal') {
        return enterTerminal(state, turn, 'error', event.code ?? `http_${event.status}`)
      }
      return enterLookup(state, turn, 'unknown')
    }

    case 'network_failure':
    case 'stream_end': {
      if (turn === null || isTerminalState(turn)) {
        return unchanged
      }
      if (
        !turnIdentityMatches(turn.identity, {
          authGeneration: state.authGeneration,
          sessionKey: state.sessionKey,
          turnId: event.turnId,
          attempt: event.attempt,
          detached: false,
        })
      ) {
        return unchanged
      }
      if (event.type === 'stream_end' && event.hadTerminal) {
        return unchanged
      }
      return enterLookup(state, turn, 'disconnect')
    }

    case 'detach': {
      if (turn === null || isTerminalState(turn) || turn.identity.detached) {
        return unchanged
      }
      const next: ConversationTurn = {
        ...turn,
        identity: { ...turn.identity, detached: true },
      }
      return {
        state: withTurn(state, next),
        effects: [{ type: 'abort_stream', turnId: next.identity.turnId }],
      }
    }

    case 'reattach': {
      if (turn === null || isTerminalState(turn)) {
        return unchanged
      }
      if (turn.state === 'lookup_pending' || turn.state === 'unknown') {
        return unchanged
      }
      const lastEventId = turn.identity.lastEventId
      const canResume = event.eligible
        && turn.identity.attempt < MAX_REATTACH_ATTEMPTS
        && (event.resumeAfter === undefined || event.resumeAfter === null || event.resumeAfter <= lastEventId + 1)
      if (!canResume) {
        if (event.eligible) {
          // 热恢复不可续接（缺口/超上限）：转 durable，不跳水位。
          const next: ConversationTurn = {
            ...turn,
            identity: { ...turn.identity, detached: false },
            gapDetected: true,
          }
          return enterLookup(state, next, 'reattach')
        }
        const next: ConversationTurn = {
          ...turn,
          identity: { ...turn.identity, detached: false },
        }
        return enterLookup(state, next, 'reattach')
      }
      const next: ConversationTurn = {
        ...turn,
        state: 'streaming',
        identity: {
          ...turn.identity,
          detached: false,
          attempt: turn.identity.attempt + 1,
        },
      }
      return {
        state: withTurn(state, next),
        effects: [
          {
            type: 'open_stream',
            turnId: next.identity.turnId,
            attempt: next.identity.attempt,
            lastEventId,
          },
        ],
      }
    }

    case 'lookup_result': {
      if (turn === null || turn.identity.turnId !== event.turnId) {
        return unchanged
      }
      if (isTerminalState(turn)) {
        return unchanged
      }
      const view = event.view
      // 集中校验完整身份：session_ref + draft_token + idempotency_key +
      // editor_intent_hash + 已绑定 generationId（review-1 P1-#6）。
      if (!submissionViewMatches(state.sessionKey, turn.identity, view, turn.external)) {
        const failures = (turn.lookup?.failures ?? 0) + 1
        const lookup: ConversationLookupState = {
          token: view.token,
          view: turn.lookup?.view ?? null,
          failures,
          lastFailure: 'protocol',
        }
        if (failures >= BOUNDED_LOOKUP_FAILURES) {
          const next: ConversationTurn = {
            ...turn,
            state: 'unknown',
            lookup,
          }
          return {
            state: withTurn(state, next),
            effects: [settleRelease(turn)],
          }
        }
        return {
          state: withTurn(state, { ...turn, state: 'lookup_pending', lookup }),
          effects: [],
        }
      }
      if (view.acceptance === 'not_observed') {
        const next: ConversationTurn = {
          ...turn,
          state: 'not_observed',
          lookup: { token: view.token, view, failures: 0, lastFailure: null },
        }
        return {
          state: withTurn(state, next),
          effects: [settleRelease(turn)],
        }
      }
      if (view.acceptance === 'accepted') {
        const matchesIdentity = turn.external
          ? false
          : submissionViewMatches(state.sessionKey, turn.identity, view, false)
        const next: ConversationTurn = {
          ...turn,
          state: 'accepted',
          clearPending: matchesIdentity && turn.operationId !== null && view.generationId !== null
            ? true
            : turn.clearPending,
          lookup: { token: view.token, view, failures: 0, lastFailure: null },
          identity: {
            ...turn.identity,
            generationId: turn.identity.generationId ?? view.generationId,
            observedRevision: view.acceptedEditorRevision ?? turn.identity.observedRevision,
          },
        }
        const effects: ConversationEffect[] = []
        if (matchesIdentity && turn.operationId !== null && view.generationId !== null) {
          effects.push({
            type: 'clear_after_submission',
            receipt: syntheticReceipt(next, view),
            operationId: turn.operationId,
          })
        }
        return { state: withTurn(state, next), effects }
      }
      if (view.acceptance === 'terminal') {
        const terminal: 'done' | 'error' = view.generationState === 'completed' ? 'done' : 'error'
        const next: ConversationTurn = {
          ...turn,
          incomplete: turn.gapDetected ? true : turn.incomplete,
          lookup: { token: view.token, view, failures: 0, lastFailure: null },
        }
        const reduction = enterTerminal(
          state,
          next,
          terminal,
          terminal === 'done' ? null : (view.generationState ?? 'failed'),
        )
        if (next.gapDetected) {
          // 缺口后的 completed 不能静默当完整答案：保留 incomplete 并触发
          // durable 恢复（review-1 P1-#10）。
          return {
            state: reduction.state,
            effects: [...reduction.effects, { type: 'durable_restore', token: view.token }],
          }
        }
        return reduction
      }
      // outcome_unknown：保留未知标记与草稿，settlement 只释放 hold。
      const next: ConversationTurn = {
        ...turn,
        state: 'unknown',
        lookup: { token: view.token, view, failures: 0, lastFailure: null },
      }
      return {
        state: withTurn(state, next),
        effects: [settleRelease(turn)],
      }
    }

    case 'lookup_failure': {
      if (turn === null || turn.identity.turnId !== event.turnId) {
        return unchanged
      }
      if (isTerminalState(turn)) {
        return unchanged
      }
      const failures = (turn.lookup?.failures ?? 0) + 1
      const lookup: ConversationLookupState = {
        token: event.token,
        view: turn.lookup?.view ?? null,
        failures,
        lastFailure: event.failure,
      }
      if (event.bounded) {
        const next: ConversationTurn = {
          ...turn,
          state: 'unknown',
          lookup,
        }
        return {
          state: withTurn(state, next),
          effects: [settleRelease(turn)],
        }
      }
      return {
        state: withTurn(state, { ...turn, lookup }),
        effects: [],
      }
    }

    case 'manual_lookup': {
      if (turn === null || isTerminalState(turn)) {
        return unchanged
      }
      return {
        state: withTurn(state, {
          ...turn,
          lookup: turn.lookup ?? {
            token: event.token ?? turn.identity.draftToken,
            view: null,
            failures: 0,
            lastFailure: null,
          },
        }),
        effects: [
          lookupEffect(
            turn,
            event.reason ?? 'manual',
            event.token ?? turn.identity.draftToken,
          ),
        ],
      }
    }

    case 'clear_settled': {
      if (turn === null || turn.identity.turnId !== event.turnId) {
        return unchanged
      }
      // 只结算当前 turn 自己的 operationId：旧 turn 的迟到 clear ACK 不得
      // 释放新 turn 的 hold（review-1 P1-#9）。
      if (turn.operationId === null || turn.operationId !== event.operationId) {
        return unchanged
      }
      const next: ConversationTurn = {
        ...turn,
        operationId: null,
        clearPending: false,
      }
      return {
        state: withTurn(state, next),
        effects: [{ type: 'release_hold', operationId: event.operationId }],
      }
    }

    case 'external_lookup': {
      if (turn !== null && !isTerminalState(turn) && turn.state !== 'idle') {
        return unchanged
      }
      const sequence = state.sequence + 1
      const identity: ConversationTurnIdentity = {
        authGeneration: state.authGeneration,
        sessionKey: state.sessionKey,
        sessionId: event.sessionId,
        turnId: `external-${sequence}`,
        draftToken: event.token,
        idempotencyKey: '',
        requestedRevision: 0,
        editorIntentHash: '',
        observedRevision: null,
        generationId: null,
        attempt: 0,
        lastEventId: 0,
        detached: false,
        terminal: null,
      }
      const nextTurn: ConversationTurn = {
        identity,
        state: 'lookup_pending',
        sse: createSseState(),
        query: '',
        operationId: null,
        accepted: null,
        errorCode: null,
        errorMessage: null,
        gapDetected: false,
        lookup: null,
        clearPending: false,
        incomplete: true,
        external: true,
      }
      const history = turn === null ? state.history : pushHistory(state, turn)
      return {
        state: { ...state, turn: nextTurn, history, sequence },
        effects: [{ type: 'lookup_submission', token: event.token, reason: 'cold_start' }],
      }
    }

    case 'durable_restored': {
      if (turn === null || turn.identity.turnId !== event.turnId) {
        return unchanged
      }
      const next: ConversationTurn = {
        ...turn,
        incomplete: event.complete ? false : turn.incomplete,
      }
      return { state: withTurn(state, next), effects: [] }
    }
  }
}

/** SSE 回执（wire 已校验）→ 投影；形状非法返回 null。 */
function acceptedReceiptFromEvent(
  wire: NonNullable<ResearchSseEvent['accepted']>,
): ResearchAcceptedReceipt | null {
  const ref: ResearchSessionRef = {
    domain: 'research',
    kind: wire.session_ref.kind,
    projectId: wire.session_ref.project_id,
    sessionId: wire.session_ref.session_id,
    sourceId: wire.session_ref.source_id,
  }
  return {
    ref,
    generationId: wire.generation_id,
    requestId: wire.request_id,
    editorRevision: wire.editor_revision,
    draftToken: wire.draft_token,
    editorIntentHash: wire.editor_intent_hash,
  }
}

/** 由查回结果构造清稿所需回执投影（用于 accepted 后补清稿）。 */
function syntheticReceipt(
  turn: ConversationTurn,
  view: ConversationSubmissionView,
): ResearchAcceptedReceipt {
  const accepted = turn.accepted
  if (accepted !== null) {
    return accepted
  }
  // 查回响应携带同一个 session_ref；request_id 不在 submission_response 中，
  // 仅记录用途，缺失时置空串（不参与受理等值匹配）。
  return {
    ref: view.ref,
    generationId: view.generationId ?? '',
    requestId: '',
    editorRevision: view.acceptedEditorRevision ?? turn.identity.requestedRevision,
    draftToken: view.token,
    editorIntentHash: view.editorIntentHash ?? turn.identity.editorIntentHash,
  }
}
