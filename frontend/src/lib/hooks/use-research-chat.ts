'use client'

/**
 * Research Chat SSE 交互状态机（UI-03，契约 v0 §8.2/§9）。
 *
 * - 单轮 turn = 用户消息 + 助手消息；助手消息内容由 SSE reducer 维护
 *   （乱序/重复事件按 event_id 去重排序，终态恰好一次）。
 * - 断线（传输层）自动重连：第二次起携带 `Last-Event-ID`（§9.5）；
 *   409 按 body code 语义（评审 R-A/R-B：generation_in_progress 同键
 *   自愈重连 / 其余终态 conflict_busy）。
 * - 服务端 `error` 终态不重连；可重试错误码由 UI 标记。
 * - 浏览器断开 ≠ 取消：中止 fetch 只是停止本地读取，服务端继续
 *   （§9.6）；本 hook 不提供 Chat 取消。
 * - Issue #302：`session_id` 首知（响应头 X-Chat-Session-Id / done 事件）
 *   即持久化 localStorage（key 含 project_id）；mount 时拉取会话详情
 *   重放历史并续接同一会话（刷新恢复）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getChatSubmission,
  getResearchChatSession,
  newIdempotencyKey,
  openResearchChatStream,
  researchApiErrorDetail,
  type ResearchGlobalChatCard,
  type ResearchGlobalChatMessage,
} from '@/lib/research/api'
import {
  applySseEvent,
  createSseState,
  parseContextCoverageWire,
  parseContextReportWire,
  projectContextReport,
  type ResearchAcceptedReceipt,
  type ResearchSseState,
} from '@/lib/research/sse'
import {
  sessionKey,
  type ResearchContextReportProjection,
  type ResearchSessionRef,
} from '@/lib/research/session-contract'
import type {
  ConversationController,
  ConversationSendInput,
  ConversationTransport,
  SessionRuntime,
} from '@/lib/research/session-runtime'
import { buildSourceScope } from '@/lib/research/c05-request'
import type { ResearchChatRequest } from '@/lib/research/types'
import { classifyC05Error } from '@/lib/research/c05-error-actions'
import {
  parseGenerationIdFromMessageId,
  selectBoundAssistantRow,
  type ChatOriginRow,
} from '@/lib/research/chat-origin'
import type {
  ResearchCitationDisplayItem,
  ResearchContextCoverage,
  ResearchSseEvent,
  ResearchTokenUsage,
} from '@/lib/research/types'
import type { ResearchScopeMode, ResearchScopeSnapshot } from '@/lib/research/scope'

/** Issue #302：刷新恢复的持久化键（key 含 project_id 维度，防跨项目串会话） */
const LAST_SESSION_STORAGE_PREFIX = 'rdlens.research.chat.last-session.'

function lastSessionStorageKey(projectId: string): string {
  return `${LAST_SESSION_STORAGE_PREFIX}${projectId}`
}

function readStoredSessionId(projectId: string): string | null {
  try {
    return localStorage.getItem(lastSessionStorageKey(projectId))
  } catch {
    return null
  }
}

function persistSessionId(projectId: string, sessionId: string): void {
  try {
    localStorage.setItem(lastSessionStorageKey(projectId), sessionId)
  } catch {
    // storage 不可用（隐私模式等）时静默跳过——只影响刷新恢复，不影响流
  }
}

function clearStoredSessionId(projectId: string): void {
  try {
    localStorage.removeItem(lastSessionStorageKey(projectId))
  } catch {
    // 同上：静默
  }
}

/**
 * 刷新恢复时对持久化 17 字段 Citation 快照的展示归一
 * （兼容 SSE 9 字段与持久化快照，page_idx 可空不显示页码）。
 */
function normalizeCitation(raw: Record<string, unknown>): ResearchCitationDisplayItem {
  const citationId = raw.citation_id
  const pageIdx = raw.page_idx
  return {
    citation_id: typeof citationId === 'string' || typeof citationId === 'number'
      ? citationId
      : 0,
    claim: typeof raw.claim === 'string' ? raw.claim : '',
    doc_id: typeof raw.doc_id === 'string' ? raw.doc_id : '',
    page_idx: typeof pageIdx === 'number' ? pageIdx : null,
    confidence:
      typeof raw.confidence === 'string' || typeof raw.confidence === 'number'
        ? raw.confidence
        : null,
  }
}

/** 后台 Generation 恢复提示（如实呈现刷新前未完成/失败的在途轮，不显示假进行中） */
export interface ResearchBackgroundNotice {
  kind: 'running' | 'failed'
  count: number
  failureCode: string | null
}

function noticeFromCards(cards: ResearchGlobalChatCard[]): ResearchBackgroundNotice | null {
  const running = cards.filter(
    (card) => card.status === 'queued' || card.status === 'running',
  )
  const failed = cards.filter(
    (card) => card.status === 'failed' || card.status === 'unknown',
  )
  if (running.length === 0 && failed.length === 0) {
    return null
  }
  if (failed.length > 0) {
    return {
      kind: 'failed',
      count: failed.length,
      failureCode: failed[0].failure_code ?? null,
    }
  }
  return { kind: 'running', count: running.length, failureCode: null }
}

/** 断线/409 的最大重连尝试次数（含首次） */
export const MAX_STREAM_ATTEMPTS = 3

/**
 * 会话读取页数上限（restore 与 origin 解析共用，review #8）——防御异常会话，
 * 不依赖单会话规模假设。每页 ≤50 行。
 */
const SESSION_READ_PAGE_CAP = 1000

/** 重连退避基数（ms）；第 n 次重试等待 base * 2^(n-1) */
export const RECONNECT_BACKOFF_MS = 300

export type ResearchChatTurnStatus = 'streaming' | 'reconnecting' | 'done' | 'error'

export interface ResearchChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  citations: ResearchCitationDisplayItem[]
  usage: ResearchTokenUsage | null
  resolvedMode: string | null
  status: ResearchChatTurnStatus
  reconnectCount: number
  errorCode: string | null
  errorMessage: string | null
  /** COV-09：all_selected 覆盖任务关联的持久 Job（202 受理后绑定） */
  coverageJobId: string | null
  /**
   * RWV2-11（K8/K12）：本次派发时冻结的不可变 Scope 快照（mode + source/note
   * IDs）。会话内 turn 必有值；刷新恢复的 turn（messageRowToTurn）为 null——
   * 重试入口据此判定（null 不渲染重试，防静默以空数组=全项目派发）。
   */
  scopeSnapshot: ResearchScopeSnapshot | null
  /**
   * RWV2-23（Issue #43，D2）：该轮持久化 assistant message_id 与解析出的
   * generation_id（Save-as-Insight/Note 的 chat origin_id，见 chat-origin.ts）。
   * - 恢复/重开行在 messageRowToTurn 直接回填（message_id → gen 解析）；
   * - live 轮由 resolveChatOrigin 惰性解析后回填；解析成功前为 null → UI 不
   *   猜测、如实呈现“保存不可用/解析中”。
   */
  serverMessageId: string | null
  generationId: string | null
  /**
   * PR-5a F13：持久化恢复轮保留 context_report / context_coverage /
   * record_visibility（修复/回溯路径与 live SSE 同源；未知保持 null，
   * 不伪造 0 或 complete）。受限消息强制安全投影（正文/思考/引用为空）。
   */
  contextReport?: ResearchContextReportProjection | null
  contextCoverage?: ResearchContextCoverage | null
  recordVisibility?: string | null
}

/** 持久化消息行 + PR-5a 扩展（服务端可选下发；缺失按 null 处理）。 */
type DurableMessageRow = ResearchGlobalChatMessage & {
  context_report?: unknown
  context_coverage?: unknown
  record_visibility?: string | null
}

/** 已持久化消息行 → 展示 turn（阅读顺序重放；completed 轮 status 恒 done） */
export function messageRowToTurn(row: DurableMessageRow): ResearchChatTurn | null {
  if (row.role !== 'user' && row.role !== 'assistant') {
    return null
  }
  // §6.9：受限消息不得以任何形式显示正文/思考/引用（仅保留安全投影）。
  const restricted = row.record_visibility === 'restricted'
  const usage = row.usage
  const base = {
    id: row.message_id,
    role: row.role,
    content: restricted ? '' : (row.content ?? ''),
    thinking: '',
    citations: [] as ResearchCitationDisplayItem[],
    usage: null as ResearchTokenUsage | null,
    resolvedMode: null as string | null,
    status: 'done' as const,
    reconnectCount: 0,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    coverageJobId: null as string | null,
    // RWV2-11：恢复行无法证明原始 Scope——如实置 null（K6/K12）
    scopeSnapshot: null,
    // RWV2-23：恢复行只有持久化 message_id；generation_id 由 id 形状解析
    serverMessageId: null,
    generationId: null,
  }
  const extensions: Pick<ResearchChatTurn, 'contextReport' | 'contextCoverage' | 'recordVisibility'> = {}
  const reportWire = parseContextReportWire(row.context_report)
  if (reportWire !== null) {
    extensions.contextReport = projectContextReport(reportWire)
  }
  const coverageWire = parseContextCoverageWire(row.context_coverage)
  if (coverageWire !== null) {
    extensions.contextCoverage = coverageWire
  }
  if (row.record_visibility !== undefined && row.record_visibility !== null) {
    extensions.recordVisibility = row.record_visibility
  }
  if (row.role === 'user') {
    return { ...base, ...extensions }
  }
  const generationId = parseGenerationIdFromMessageId(row.message_id)
  return {
    ...base,
    ...extensions,
    thinking: restricted ? '' : (row.thinking ?? ''),
    serverMessageId: row.message_id ?? null,
    generationId,
    citations: !restricted && Array.isArray(row.citations)
      ? row.citations
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null,
        )
        .map(normalizeCitation)
      : [],
    usage:
      usage !== null && typeof usage === 'object' && !Array.isArray(usage)
        ? (usage as unknown as ResearchTokenUsage)
        : null,
    resolvedMode: row.resolved_mode ?? null,
  }
}

export interface ResearchChatSelection {
  sourceIds?: string[]
  noteIds?: string[]
  /** RWV2-11（K8）+ PR5：派发时的生效范围模式；缺省 all（C-05 语义） */
  mode?: ResearchScopeMode
  /** PR5（C1）：single 限定下的来源（仅 mode='single' 时非空） */
  singleSourceId?: string | null
}

/**
 * RWV2-23（Issue #43，D2）：chat origin 解析结果——持久化 assistant 行
 * message_id + 解析出的 generation_id（Save 请求的 origin_id）。
 */
export interface ResearchChatSaveOrigin {
  messageId: string
  generationId: string
}

/**
 * RWV2-11（K8/K12）+ PR5（D-10）：由派发时的 selection 推导冻结的
 * 不可变 Scope 快照。
 * - mode 缺省推导与 C-05 payload 语义一致（无显式 ID = all，**不再**是旧
 *   旧枚举语义）；
 * - 返回对象/数组均为冻结副本（与 `getSnapshot()` 同形态），只读不漂移；
 * - 会话内 turn 在创建时写入该快照，供 Scope 徽标、重试与元数据展示使用。
 */
export function deriveScopeSnapshot(
  selection: ResearchChatSelection | undefined,
): ResearchScopeSnapshot {
  // 复制数组：快照不得与调用方/后续 selection 数组别名（K1 不可变语义）
  const sourceIds = [...(selection?.sourceIds ?? [])]
  const noteIds = [...(selection?.noteIds ?? [])]
  const mode: ResearchScopeMode =
    selection?.mode ??
    (sourceIds.length + noteIds.length > 0 ? 'selected' : 'all')
  const singleSourceId = mode === 'single'
    ? (selection?.singleSourceId ?? null)
    : null
  return { mode, sourceIds, noteIds, singleSourceId }
}

export interface UseResearchChatResult {
  turns: ResearchChatTurn[]
  isStreaming: boolean
  /**
   * Issue #302：刷新恢复后仍未被交付的后台 Generation 提示——如实告知
   * 「上一轮仍在后台/未完成」，绝不渲染为假「进行中」。
   */
  backgroundNotice: ResearchBackgroundNotice | null
  /**
   * Issue #243 §6.4：modelId 是 required——调用方必须传入调用时刻捕获的
   * confirmed 全局模型快照。本 hook 不再在执行时读取执行偏好（删除
   * GET execution preferences），因此后来切换模型不会影响在途 turn，
   * SSE 重连也继续沿用该快照（不变量 4）。
   */
  /** PR5（D-22）：当前会话身份（供调用方在 consent 登记时冻结进 wire 请求） */
  getCurrentSessionId: () => string | null
  send: (
    query: string,
    selection: ResearchChatSelection | undefined,
    modelId: string,
    /** PR5（D-22）：登记前冻结的幂等键/契约（确认后原样复用） */
    frozenIdempotencyKey?: string,
    frozenContract?: 'v1' | 'c05-v1',
    /** PR5（D-22）：登记时冻结的完整 wire 请求（首次尝试原样发送） */
    frozenRequest?: ResearchChatRequest,
  ) => void
  /**
   * COV-09：all_selected 覆盖提交（COV-08 §12.1）。不走 SSE——202 受理后
   * 绑定持久 Job 标识，UI 经 GET /jobs/{id} 轮询展示 stage/progress/
   * 逐文档状态/报告。submit 由调用方注入（apiClient 202 + Job 登记），
   * 本 hook 只负责 turn 生命周期与错误表达。
   */
  sendCoverage: (
    query: string,
    selection: ResearchChatSelection | undefined,
    modelId: string,
    submit: (
      request: CoverageSubmitRequest,
      idempotencyKey: string,
    ) => Promise<{ job_id: string }>,
  ) => void
  /**
   * RWV2-23（Issue #43，D2）：解析某 assistant turn 的持久化 origin
   * （message_id + generation_id），供 Save-as-Insight/Note 使用。
   * - 恢复/重开行：直接回填（messageRowToTurn 已解析），无需网络；
   * - live 行：按需拉取当前会话（复用恢复逻辑的按 message_id 去重与键集
   *   游标续读，上限保护），以 content/前一 user 行约束绑定后回填 turn；
   * - 无法唯一绑定/会话不可达 → null（UI 如实显示不可存，不猜测）。
   */
  resolveChatOrigin: (turnId: string) => Promise<ResearchChatSaveOrigin | null>
  /**
   * PR-5a（D2 裁决）：显式传入 `session` 时由该会话对话控制器提供
   * `research-session-v1` 协议（查回/受理/热恢复/迟到隔离）。
   * 未传 `session` 时为 `null`，legacy 行为与返回形状不变（面板接线归 PR-5b）。
   */
  readonly conversation?: ConversationController | null
}

/**
 * PR-5a：会话控制器接线参数（面板 PR-5b 注入；本 PR 不接线 UI）。
 * 控制器是热恢复唯一权威：hook 卸载只 detach（浏览器断开 ≠ 取消），
 * 提交 hold/清稿副作用经回调交还 editor-machine 的持有者。
 */
export interface UseResearchChatSessionOptions {
  readonly runtime: SessionRuntime
  readonly ref: ResearchSessionRef
  readonly onReleaseHold?: (operationId: string) => void
  readonly onClearAfterSubmission?: (
    receipt: ResearchAcceptedReceipt,
    operationId: string,
  ) => void
}

/** COV-09：all_selected 提交请求载荷（note_ids 恒空数组——Notes 不支持） */
export interface CoverageSubmitRequest {
  query: string
  source_ids: string[]
  note_ids: string[]
  model_id: string
  /** R1-H7：派发时生效范围模式（C-05 分支构造 source_scope 用） */
  scopeMode?: 'all' | 'selected' | 'single'
  /** R2-H7：single 模式的限定来源 ID */
  singleSourceId?: string | null
}

interface ActiveTurn {
  turnId: string
  query: string
  sourceIds: string[]
  noteIds: string[]
  /** PR5（C6）：派发时冻结的生效范围快照（含 single） */
  scopeSnapshot: ResearchScopeSnapshot
  /** PR5（C6）：本 turn 的契约分支（能力判定结果，重连不重判） */
  contract: 'v1' | 'c05-v1'
  /** startTurn 已 fail-closed（空 modelId 直接 error 不建 turn），重连必非空 */
  modelId: string
  /** 每 turn 生成一次；断线重连必须复用同一键（后端同键同 hash 可重入，
   *  新键 = 新 Generation，首事件前断线会双扣） */
  idempotencyKey: string
  attempt: number
  reconnectCount: number
  lastEventId: number
  sessionId: string | null
  /**
   * PR5（D-22，评审 MEDIUM-11）：登记 consent 时冻结的**完整 wire 请求**。
   * 仅**首次尝试**原样发送；重连按 `active` 重建（须带上响应头回显的
   * session_id 与 Last-Event-ID，冻结体不具备这些恢复游标）。
   */
  initialRequest: ResearchChatRequest | null
  sse: ResearchSseState
  /** PR5（D-24）：中止可带原因（user_cancel/identity/page_change），
   *  供传输层区分"仅 timeout 可重试" */
  abort: ((reason?: 'user_cancel' | 'identity' | 'page_change' | 'terminal_reached') => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

/**
 * 冻结请求是否仍与当前会话身份一致（审查轮 2 B1）。
 * 冻结体没有 `session_id` 字段时视为一致（同为空）。
 */
function frozenRequestMatchesSession(
  frozen: ResearchChatRequest | undefined,
  currentSessionId: string | null,
): boolean {
  if (frozen === undefined) return false
  const frozenSession = (frozen as { session_id?: string | null }).session_id ?? null
  return frozenSession === (currentSessionId ?? null)
}

function randomId(): string {
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function httpErrorMessage(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string' && detail) {
    return detail
  }
  if (
    typeof detail === 'object' &&
    detail !== null &&
    typeof (detail as { message?: unknown }).message === 'string' &&
    (detail as { message: string }).message
  ) {
    return (detail as { message: string }).message
  }
  return `Research stream HTTP ${status}`
}

export function useResearchChat({ projectId, c05DispatchReady, onBindSession, session }: {
  projectId: string
  /** PR5（C6/C7）：C-05 契约判定（能力就绪回调；undefined = 旧 v1 全量） */
  c05DispatchReady?: () => boolean
  /** PR5（D-04）：会话身份确认时回调（绑定/清除 single 限定） */
  onBindSession?: (sessionId: string) => void
  /** PR-5a：显式会话控制器接线（省略 = legacy 行为完全不变） */
  session?: UseResearchChatSessionOptions
}): UseResearchChatResult {
  const [turns, setTurns] = useState<ResearchChatTurn[]>([])
  const [backgroundNotice, setBackgroundNotice] = useState<ResearchBackgroundNotice | null>(null)
  const activeRef = useRef<ActiveTurn | null>(null)
  /** 跨轮次续接的服务端 session_id（done 事件/响应头/恢复记录） */
  const sessionIdRef = useRef<string | null>(null)
  /**
   * Issue #302：本 project 已发生过用户发问（mount 后任何 send/sendCoverage）
   * ——恢复结果不得灌进已开始的对话（旧历史可能晚于新轮返回）。
   */
  const interactedRef = useRef(false)
  /** PR5：C-05 判定回调 + bindSession 回调（runTurn 闭包内经 ref 读取） */
  const c05DispatchReadyRef = useRef<(() => boolean) | undefined>(undefined)
  c05DispatchReadyRef.current = c05DispatchReady
  const bindSessionRef = useRef<((sessionId: string) => void) | undefined>(undefined)
  bindSessionRef.current = onBindSession
  /**
   * mount 恢复去重（StrictMode 双挂载友好）：cleanup（首轮被取消）会清
   * 状态允许重跑；completed 后同 project 不再重试。
   */
  const restoreStateRef = useRef<{ projectId: string | null; done: boolean }>({
    projectId: null,
    done: false,
  })

  /**
   * PR-5a（D2）：会话控制器。仅在显式传入 `session` 时创建；生命周期与
   * `sessionKey` 绑定（StrictMode 双挂载由 runtime 引用计数吸收）。
   */
  const [conversation, setConversation] = useState<ConversationController | null>(null)
  const sessionOptionsRef = useRef<UseResearchChatSessionOptions | undefined>(session)
  sessionOptionsRef.current = session
  const controllerRef = useRef<ConversationController | null>(null)
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const conversationKey = session === undefined ? null : sessionKey(session.ref)
  const sessionMode = session !== undefined

  // 认证代次变化时必须重新取得 controller（review-2 B1）：旧实例绑定旧
  // authGeneration，继续复用会让新请求被 runtime 判为 stale。
  const authRuntime = session?.runtime
  const [authEpoch, setAuthEpoch] = useState(
    () => authRuntime?.getSnapshot().authGeneration ?? 0,
  )
  useEffect(() => {
    if (authRuntime === undefined) return
    const sync = (): void => {
      const next = authRuntime.getSnapshot().authGeneration
      setAuthEpoch((prev) => (prev === next ? prev : next))
    }
    sync()
    return authRuntime.subscribe(sync)
  }, [authRuntime])

  useEffect(() => {
    const options = sessionOptionsRef.current
    if (options === undefined || conversationKey === null) {
      return
    }
    const ref = options.ref
    const releaseHold = options.onReleaseHold
    const clearAfterSubmission = options.onClearAfterSubmission
    const transport: ConversationTransport = {
      openStream: (input) => {
        // §6.2 wire 请求：global 必须用冻结的 source_scope，禁止顶层 source_ids；
        // source kind 以路径 source_id 定位（review-1 P1-#2）。
        const request: ResearchChatRequest = {
          query: input.query,
          model_id: input.modelId,
        }
        if (ref.kind === 'global') {
          if (input.scope !== null) {
            request.source_scope = {
              mode: input.scope.mode,
              source_ids: [...input.scope.sourceIds],
              single_source_id: input.scope.singleSourceId,
            }
          }
          request.note_ids = [...input.noteIds]
        } else {
          request.source_ids = ref.sourceId === null ? [] : [ref.sourceId]
        }
        const abort = openResearchChatStream({
          protocol: 'research-session-v1',
          projectId: projectIdRef.current,
          kind: ref.kind,
          sessionRef: ref,
          editorRevision: input.editorRevision,
          draftToken: input.draftToken,
          editorIntentHash: input.editorIntentHash,
          idempotencyKey: input.idempotencyKey,
          lastEventId: input.lastEventId,
          request,
          onEvent: input.onEvent,
          onEnd: input.onEnd,
          onHttpError: input.onHttpError,
          onNetworkError: input.onNetworkError,
          onProtocolError: input.onProtocolError,
          onIdleTimeout: input.onIdleTimeout,
          onResponseMeta: (headers: Headers) => {
            input.onResponseMeta?.({ sessionId: headers.get('x-chat-session-id') })
          },
        })
        return {
          abort: (reason) => {
            // `superseded` 仅停止本地读取；服务端继续执行（§6.5 浏览器断开≠取消）。
            abort(reason === 'superseded' ? 'page_change' : reason)
          },
        }
      },
      getSubmission: ({ token }) => getChatSubmission(
        projectIdRef.current,
        { kind: ref.kind, sourceId: ref.sourceId },
        ref.sessionId,
        token,
      ),
      loadDetail: ({ cursor }) => getResearchChatSession(
        projectIdRef.current,
        ref.sessionId,
        cursor === null || cursor === undefined ? {} : { cursor },
      ),
      releaseHold: (operationId) => releaseHold?.(operationId),
      clearAfterSubmission: (receipt, operationId) => clearAfterSubmission?.(receipt, operationId),
    }
    const controller = options.runtime.conversation(ref, { transport })
    controllerRef.current = controller
    setConversation(controller)
    // 冷启动/切换返回：durable detail 恢复完整消息，替换临时轮（§6.5）；
    // 缺口水位不会据此续接 SSE，只用于渲染（review-1 P1-#10）。
    // 认证刷新/重新挂载后，若上一次离开把 turn 标记为 detached，必须主动
    // 重新接管并继续查回结算（review-3 #2）。
    const snapshot = controller.getSnapshot()
    if (snapshot.turn !== null && snapshot.turn.identity.detached) {
      void controller.reattach()
    }
    void controller.load().then((result) => {
      if (result.status !== 'ok') return
      if (interactedRef.current || activeRef.current) return
      const rows = (result.value?.messages ?? []) as ResearchGlobalChatMessage[]
      const restored = rows
        .map((row) => messageRowToTurn(row as DurableMessageRow))
        .filter((turn): turn is ResearchChatTurn => turn !== null)
      if (restored.length > 0) setTurns(restored)
    })
    return () => {
      // 离开会话/卸载：只标记 detach 并中止本地读取（服务端继续执行）。
      controller.detach()
      options.runtime.releaseConversation(ref, controller)
      if (controllerRef.current === controller) {
        controllerRef.current = null
        setConversation(null)
      }
    }
  }, [conversationKey, authEpoch])

  /**
   * RWV2-23（D2）：会话 origin 解析缓存——按阅读顺序累积的行、已见
   * message_id 集合与上次键集游标（无 end-cursor token 时以“已见去重 +
   * 单调行列表”续读，会话 ≤50 行时单次 GET）。惰性：仅在用户点 Save
   * 且目标 turn 尚未解析时拉取。
   */
  const sessionOriginCacheRef = useRef<{
    sessionId: string | null
    rows: ChatOriginRow[]
    seen: Set<string>
    lastCursor: string | null
  }>({ sessionId: null, rows: [], seen: new Set(), lastCursor: null })
  const originInflightRef = useRef<
    Map<string, Promise<ResearchChatSaveOrigin | null>>
  >(new Map())
  // turn 最新快照镜像：解析回调内读取目标 turn 的 user query / assistant
  // content（避免闭包读到过期 turns）。
  const turnsRef = useRef<ResearchChatTurn[]>([])
  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  const patchAssistant = useCallback((turnId: string, patch: Partial<ResearchChatTurn>) => {
    setTurns((prev) => {
      const index = prev.findIndex((t) => t.id === turnId)
      if (index < 0) return prev
      const next = [...prev]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [])

  /**
   * RWV2-23（D2）：解析 assistant turn 的持久化 origin（message_id +
   * generation_id）。恢复行在 messageRowToTurn 已解析；live 行按需拉取
   * 会话行并用 chat-origin 纯规则绑定；不可解析/网络瞬时失败 → null。
   * 同一 turn 的并发解析共享同一 in-flight promise（防双拉）。
   */
  const resolveChatOrigin = useCallback(
    async (turnId: string): Promise<ResearchChatSaveOrigin | null> => {
      const inflight = originInflightRef.current.get(turnId)
      if (inflight) return inflight
      const promise = (async (): Promise<ResearchChatSaveOrigin | null> => {
        const index = turnsRef.current.findIndex((t) => t.id === turnId)
        if (index < 0) return null
        const assistant = turnsRef.current[index]
        if (assistant.role !== 'assistant') return null
        const userTurn = index > 0 ? turnsRef.current[index - 1] : null
        if (userTurn === null || userTurn.role !== 'user') return null
        // 已解析（恢复/重开/此前成功回填）：直接返回，不再拉取。
        if (assistant.generationId !== null && assistant.serverMessageId !== null) {
          return { messageId: assistant.serverMessageId, generationId: assistant.generationId }
        }
        // 恢复行但 message_id 形状不可解析（非 gen_ 形态）：无可解析路径。
        if (assistant.serverMessageId !== null && assistant.generationId === null) {
          return null
        }
        const query = userTurn.content
        const content = assistant.content
        if (!query.trim() || !content.trim()) return null
        const sessionId = sessionIdRef.current
        if (!sessionId) return null
        const cache = sessionOriginCacheRef.current
        if (cache.sessionId !== sessionId) {
          cache.sessionId = sessionId
          cache.rows = []
          cache.seen = new Set()
          cache.lastCursor = null
        }
        const fromCache = selectBoundAssistantRow(cache.rows, query, content)
        if (fromCache !== null) {
          patchAssistant(turnId, {
            serverMessageId: fromCache.messageId,
            generationId: fromCache.generationId,
          })
          return fromCache
        }
        // 从上次键集游标续读（首次=page1）。RDLens 会话读取在末页返回
        // next_cursor=null（无“末行之后”的续读 token），故以 message_id
        // 去重 + 单调行列表保证不重复绑定；页数保护与 restore 同常量。
        let cursor: string | null = cache.lastCursor
        for (let page = 0; page < SESSION_READ_PAGE_CAP; page += 1) {
          let detail
          try {
            detail = await getResearchChatSession(
              projectId,
              sessionId,
              cursor ? { cursor } : {},
            )
          } catch {
            // 瞬时失败（5xx/网络）：保留已拉行按现状匹配；不抛、不猜测
            break
          }
          for (const message of detail.messages) {
            if (cache.seen.has(message.message_id)) continue
            cache.seen.add(message.message_id)
            cache.rows.push(message)
          }
          if (detail.next_cursor) {
            cache.lastCursor = detail.next_cursor
            cursor = detail.next_cursor
          }
          if (!detail.next_cursor) break
        }
        const found = selectBoundAssistantRow(cache.rows, query, content)
        if (found !== null) {
          patchAssistant(turnId, {
            serverMessageId: found.messageId,
            generationId: found.generationId,
          })
        }
        return found
      })()
      originInflightRef.current.set(turnId, promise)
      // settle 后移除：并发点击共享同一次解析；成功后字段已回填（不再调用），
      // 失败后允许用户再次点击重试（行缓存使重复解析近乎零成本）。
      void promise.finally(() => {
        originInflightRef.current.delete(turnId)
      })
      return promise
    },
    [patchAssistant, projectId],
  )

  const stopActive = useCallback((reason: 'user_cancel' | 'identity' | 'page_change' = 'user_cancel') => {
    const active = activeRef.current
    if (!active) return
    if (active.abort) active.abort(reason)
    if (active.reconnectTimer) clearTimeout(active.reconnectTimer)
    activeRef.current = null
  }, [])

  /**
   * #292 P0：不可恢复终态（SSE done/error、非 409 HTTP 错误、网络重连
   * 耗尽）后释放 activeRef，且只对当前 turnId 生效——迟到事件来自旧 turn
   * 时不得清理或覆盖新 turn 的 ref。修复后 activeRef 的不变量是「仅代表
   * 真正仍在执行/重连的 turn」，send() 的抢占标记因此不会再改写已完成
   * 或已失败的上一轮。409 generation_in_progress（同键自愈）与仍可重试
   * 的网络错误不清理。
   */
  const clearActiveIfCurrent = useCallback((turnId: string) => {
    const current = activeRef.current
    if (!current || current.turnId !== turnId) return
    if (current.reconnectTimer) {
      clearTimeout(current.reconnectTimer)
      current.reconnectTimer = null
    }
    // 评审 MEDIUM-6：终态（done/error/不可恢复 HTTP 错误）之后必须**真的**
    // 释放传输——只把 abort 置 null 会让看门狗与 reader 一直挂到页面卸载，
    // 而那时 activeRef 已空、再也释放不掉。`terminal_reached` 表示"已到终态、
    // 不得据此重试"（仅 timeout 可重试，见 §5.3）。
    current.abort?.('terminal_reached')
    current.abort = null
    activeRef.current = null
  }, [])

  // 卸载 = 页面变化：中止必须带原因（不得被当成 timeout 进入有界重试）
  useEffect(() => () => stopActive('page_change'), [stopActive])

  // Issue #302：mount 刷新恢复——持久化过最近 session 则拉取详情重放为
  // turns。sessionIdRef 先同步为存储值：恢复完成前用户抢发也续接同一
  // 会话（服务端不会因前端未恢复而另开）；恢复结果晚到且用户已交互时
  // 丢弃（interactedRef 闸），不把旧历史灌进已开始的对话。
  useEffect(() => {
    // 会话控制器模式由 durable controller.load() 负责恢复；旧 localStorage
    // 恢复只服务无 session 的 legacy 路径（PR-5b 面板接线前的兼容）。
    if (sessionMode) return
    const restoreState = restoreStateRef.current
    if (restoreState.projectId === projectId && restoreState.done) return
    const storedId = readStoredSessionId(projectId)
    if (!storedId) return
    restoreStateRef.current = { projectId, done: false }
    sessionIdRef.current = storedId
    // R1-H5：恢复路径立即核验会话身份——异会话的持久 pin 在**首请求前**
    // 清除（新对话默认 all，不继承限定）；同会话 pin 得到绑定。
    bindSessionRef.current?.(storedId)
    let cancelled = false

    void (async () => {
      const rows: ResearchGlobalChatMessage[] = []
      const seenMessageIds = new Set<string>()
      let cards: ResearchGlobalChatCard[] = []
      let cursor: string | null = null
      for (let page = 0; page < SESSION_READ_PAGE_CAP; page += 1) {
        let detail
        try {
          detail = await getResearchChatSession(
            projectId,
            storedId,
            cursor ? { cursor } : {},
          )
        } catch (error) {
          if (cancelled) return
          const status = (error as { status?: unknown })?.status
          const responseStatus = (error as { response?: { status?: unknown } })?.response
            ?.status
          if (status === 404 || status === 403 || responseStatus === 404 || responseStatus === 403) {
            // 会话不存在 / 非本 Owner：失效记录清除，静默回退空态
            clearStoredSessionId(projectId)
            sessionIdRef.current = null
          }
          // 其余瞬时错误（5xx/网络）：保留存储 id（下次刷新重试），静默
          // 空态符合 #302 验收（不弹错阻塞）；同 mount 不再重试
          restoreStateRef.current = { projectId, done: true }
          return
        }
        // 评审 MEDIUM-1：分页窗口内 commit 会 UPSERT 重写 user 行
        // created_at，键集游标下一页可能重复返回同一 message_id——
        // 按 message_id 去重（首见保留），防重复 React key/气泡
        for (const message of detail.messages) {
          if (seenMessageIds.has(message.message_id)) continue
          seenMessageIds.add(message.message_id)
          rows.push(message)
        }
        cards = detail.cards
        cursor = detail.next_cursor ?? null
        if (!cursor) break
      }
      if (cancelled) return
      if (interactedRef.current || activeRef.current) return
      const restored = rows
        .map(messageRowToTurn)
        .filter((turn): turn is ResearchChatTurn => turn !== null)
      if (restored.length === 0 && cards.length === 0) return
      setTurns(restored)
      // 无消息但有在途卡（首轮未提交即刷新）时提示仍要如实呈现
      setBackgroundNotice(noticeFromCards(cards))
      restoreStateRef.current = { projectId, done: true }
    })()

    return () => {
      cancelled = true
      // StrictMode/卸载重挂：本轮被取消则清状态，允许后续 effect 重跑恢复
      const state = restoreStateRef.current
      if (state.projectId === projectId && !state.done) {
        restoreStateRef.current = { projectId: null, done: false }
      }
    }
  }, [projectId, sessionMode])

  const runTurn = (active: ActiveTurn): void => {
    const { turnId } = active
    const scheduleReconnect = (): void => {
      const current = activeRef.current
      if (!current || current.turnId !== turnId) return
      current.attempt += 1
      current.reconnectCount += 1
      patchAssistant(turnId, {
        status: 'reconnecting',
        reconnectCount: current.reconnectCount,
      })
      const delay = RECONNECT_BACKOFF_MS * 2 ** (current.attempt - 2)
      current.reconnectTimer = setTimeout(() => {
        if (activeRef.current?.turnId === turnId) {
          runTurn(current)
        }
      }, delay)
    }

    // D-22（评审 MEDIUM-11）：**首次尝试**用登记 consent 时冻结的完整 wire
    // 请求（含 session_id、契约选择与 source_scope 形状）；重连仍按 active
    // 重建——冻结体不具备响应头回显的 session_id 与 Last-Event-ID 恢复游标。
    const requestForAttempt: ResearchChatRequest = active.attempt === 1 && active.initialRequest !== null
      ? active.initialRequest
      : active.contract === 'c05-v1'
        ? {
            // PR5（B3）：C-05 分支——source_scope 载荷，禁止顶层 source_ids
            query: active.query,
            session_id: active.sessionId ?? undefined,
            model_id: active.modelId,
            source_scope: buildSourceScope({
              mode: active.scopeSnapshot.mode,
              sourceIds: active.scopeSnapshot.sourceIds,
              noteIds: active.scopeSnapshot.noteIds,
              singleSourceId: active.scopeSnapshot.singleSourceId,
            }),
            note_ids: active.noteIds,
          }
        : {
            // #238：v1 契约显式透传执行偏好（不变量 2：后端不隐式补值）；
            // #243 §6.7：类型必填，快照缺失时 startTurn 已 fail-closed，重连
            // 路径无 undefined 兜底
            query: active.query,
            source_ids: active.sourceIds,
            note_ids: active.noteIds,
            session_id: active.sessionId ?? undefined,
            model_id: active.modelId,
          }
    active.abort = openResearchChatStream({
      projectId,
      request: requestForAttempt,
      contract: active.contract,
      idempotencyKey: active.idempotencyKey,
      lastEventId: active.lastEventId,
      // Issue #302：响应头首知 session_id 即持久化——刷新窗口比 done 更早
      // 关闭（在途轮刷新后恢复仍能定位同一会话）
      onResponseMeta: (headers) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        const headerSessionId = headers.get('X-Chat-Session-Id')
        if (headerSessionId) {
          current.sessionId = headerSessionId
          sessionIdRef.current = headerSessionId
          persistSessionId(projectId, headerSessionId)
          // PR5（D-04）：会话身份确认 → 绑定/清除 single 限定
          bindSessionRef.current?.(headerSessionId)
        }
      },
      onEvent: (event: ResearchSseEvent) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        const sse = applySseEvent(current.sse, event)
        current.sse = sse
        current.lastEventId = sse.lastEventId
        if (sse.terminal === 'done') {
          current.sessionId = sse.sessionId ?? current.sessionId
          sessionIdRef.current = current.sessionId
          if (current.sessionId) {
            persistSessionId(projectId, current.sessionId)
          }
        }
        const patch: Partial<ResearchChatTurn> = {
          content: sse.answer,
          thinking: sse.thinking,
          citations: sse.citations,
          usage: sse.usage,
          resolvedMode: sse.resolvedMode,
        }
        if (sse.terminal === 'done') {
          patch.status = 'done'
        } else if (sse.terminal === 'error') {
          patch.status = 'error'
          patch.errorCode = sse.errorCode
          patch.errorMessage = sse.errorMessage
        } else {
          // 非终态事件（含重连恢复后的首个事件）回到 streaming
          patch.status = 'streaming'
        }
        patchAssistant(turnId, patch)
        // #292 P0：done/error 终态后在 identity guard 下释放 activeRef，
        // 下一轮 send() 不再把已终态 turn 改写为 superseded
        if (sse.terminal === 'done' || sse.terminal === 'error') {
          clearActiveIfCurrent(turnId)
        }
      },
      onHttpError: (status, body) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        // R1-B2 修复：C-05 契约分支统一消费动作表（classifyC05Error），
        // 恢复材料（activeRef + 原键）按 acceptance/recovery_action 处置；
        // 旧 v1 分支保持既有 409 语义不变。
        if (current.contract === 'c05-v1') {
          // 构造 axios 形状错误以复用分类器（detail 从 body 提取）
          const classified = classifyC05Error({ response: { status, data: body } })
          if (status === 409 && classified.action === 'read_original_result') {
            // generation_in_progress：同键自愈路径。R1-B2：与网络重连
            // **共用 attempt 计数**（≤3）。
            if (current.attempt >= MAX_STREAM_ATTEMPTS) {
              // R2-B2/R2-N2：耗尽 → **待确认终态**。activeRef 释放（与
              // #292 P0 不变量一致），但 errorCode/errorMessage 已落 turn
              // 记录可回访；acceptance_retry_exhausted 文案明确"待确认，
              // 不因耗尽判定服务端失败"。重发同一问题生成新幂等键 =
              // 用户明确的新意图（服务端幂等行仍按原键保留原失败）。
              patchAssistant(turnId, {
                status: 'error',
                errorCode: 'acceptance_retry_exhausted',
                errorMessage: httpErrorMessage(status, body),
              })
              clearActiveIfCurrent(turnId)
              return
            }
            scheduleReconnect()
            return
          }
          if (classified.action === 'retry_same_key') {
            // R2-B2/R2-N2：服务端明确 retry_same_key（临时不可用）→ 有界
            // 重连（attempt 共用 ≤3）；耗尽走上方 acceptance_retry_exhausted。
            if (current.attempt >= MAX_STREAM_ATTEMPTS) {
              patchAssistant(turnId, {
                status: 'error',
                errorCode: 'acceptance_retry_exhausted',
                errorMessage: httpErrorMessage(status, body),
              })
              clearActiveIfCurrent(turnId)
              return
            }
            scheduleReconnect()
            return
          }
          if (classified.acceptance === 'unknown' && classified.action === 'reconcile_then_retry') {
            // acceptance_outcome_unknown：**保留 activeRef 与原键材料**，
            // 呈现待确认（不写成失败、不产生新键）
            patchAssistant(turnId, {
              status: 'reconnecting',
              errorCode: classified.code,
              errorMessage: httpErrorMessage(status, body),
            })
            return
          }
          // 确定性结论（字符串冲突 / 422 / 终态 stop_and_confirm）→
          // 终态错误呈现并清 activeRef（材料保留在 turn 记录中可查证）
          patchAssistant(turnId, {
            status: 'error',
            errorCode: classified.code ?? 'conflict_busy',
            errorMessage: httpErrorMessage(status, body),
          })
          clearActiveIfCurrent(turnId)
          return
        }
        if (status === 409) {
          // 409 语义按 body 区分（评审 R-A/R-B：全局 /chat 的 409 detail
          // 形态已核实——纯字符串 = begin_turn 会话占用；对象带
          // code='generation_in_progress' = 同幂等键重试命中自己仍
          // running 的 gen，必然自愈到 completed-replay（单次计费恢复
          // 机制，须保留退避重连）；对象 code='chat_conflict'/failed
          // state 等 = 终态门，重试恒 409）。
          const detail = (body as { detail?: unknown } | null)?.detail
          const detailCode =
            typeof detail === 'object' && detail !== null
              ? (detail as { code?: unknown }).code
              : undefined
          if (detailCode === 'generation_in_progress') {
            // 同键重试自愈路径（首事件前断线的既有防护机制）：原 gen
            // 完成后同键 POST 走 completed-replay 回放，不产生新轮
            scheduleReconnect()
            return
          }
          // 其余 409 = 会话级冲突/终态门（评审 HIGH-1——刷新恢复后续接
          // 同一会话重发时同会话仍有在途 turn 占用；服务端已把本 gen
          // 收敛 failed，重试命中 failed 行恒 409 死锁，reconnecting
          // 永续锁死发送按钮）。按终态错误呈现，用户可稍后在旧轮完成
          // 后重发（每次 send 都是新幂等键）。
          patchAssistant(turnId, {
            status: 'error',
            errorCode: 'conflict_busy',
            errorMessage: httpErrorMessage(status, body),
          })
          // #292 P0：冲突 409 是不可恢复终态
          clearActiveIfCurrent(turnId)
          return
        }
        patchAssistant(turnId, {
          status: 'error',
          errorCode: 'http_error',
          errorMessage: httpErrorMessage(status, body),
        })
        // #292 P0：非 409 HTTP 错误是不可恢复终态
        clearActiveIfCurrent(turnId)
      },
      onProtocolError: (reason) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        // D-24/§5.3：非 SSE Content-Type = 协议违反，fail-closed。
        // 重试只会拿到同样的非流响应 → **不**进入有界重连。
        patchAssistant(turnId, {
          status: 'error',
          errorCode: 'stream_protocol_error',
          errorMessage: reason,
        })
        clearActiveIfCurrent(turnId)
      },
      onIdleTimeout: () => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        // D-24/§5.3：timeout 是**唯一**可进入既有有界策略的 abort 原因
        if (current.attempt >= MAX_STREAM_ATTEMPTS) {
          patchAssistant(turnId, {
            status: 'error',
            errorCode: 'stream_idle_timeout',
            errorMessage: `No stream data within the idle budget after ${MAX_STREAM_ATTEMPTS} attempts`,
          })
          clearActiveIfCurrent(turnId)
          return
        }
        scheduleReconnect()
      },
      onNetworkError: (error) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        if (current.attempt >= MAX_STREAM_ATTEMPTS) {
          patchAssistant(turnId, {
            status: 'error',
            errorCode: 'stream_lost',
            errorMessage: `Connection lost after ${MAX_STREAM_ATTEMPTS} attempts: ${error.message}`,
          })
          // #292 P0：重连耗尽是不可恢复终态；仍可重试的断线不清理
          clearActiveIfCurrent(turnId)
          return
        }
        scheduleReconnect()
      },
    })
  }

  const startTurn = (
    trimmed: string,
    turnId: string,
    selection: ResearchChatSelection | undefined,
    modelId: string,
    frozenIdempotencyKey?: string,
    frozenContract?: 'v1' | 'c05-v1',
    /** PR5（D-22）：登记时冻结的完整 wire 请求（首次尝试原样发送） */
    frozenRequest?: ResearchChatRequest,
  ): void => {
    // #243 §6.4：modelId 由调用方传入（confirmed 全局模型快照），本 hook
    // 不再读取执行偏好——显示什么就执行什么，且快照不随后续切换漂移。
    if (!modelId) {
      // fail-closed：无 confirmed 模型不发请求（后端不隐式补值）
      patchAssistant(turnId, {
        status: 'error',
        errorCode: 'model_required',
        errorMessage: 'Select a research model before sending',
      })
      return
    }
    // PR5（C6）：契约判定在派发时刻执行一次，重连沿用同契约（不重判）。
    // PR5（D-22）：若调用方在登记 consent 前已冻结契约，则以冻结值为准
    //（确认期间能力翻转不得改变已登记请求的契约）。
    const contract: 'v1' | 'c05-v1' = frozenContract
      ?? (c05DispatchReadyRef.current?.() === true ? 'c05-v1' : 'v1')
    const active: ActiveTurn = {
      turnId,
      query: trimmed,
      sourceIds: selection?.sourceIds ?? [],
      noteIds: selection?.noteIds ?? [],
      scopeSnapshot: deriveScopeSnapshot(selection),
      contract,
      modelId,
      // PR5（D-22）：登记时冻结的键优先；缺省（旧接线）仍是每轮新键
      idempotencyKey: frozenIdempotencyKey ?? newIdempotencyKey(),
      attempt: 1,
      reconnectCount: 0,
      lastEventId: 0,
      sessionId: sessionIdRef.current,
      /**
       * 审查轮 2 B1：冻结请求里的 `session_id` 是**恢复游标**，可能已被会话
       * 失效（持久会话 404 → sessionIdRef 置 null）而在确认时过期。此时若原样
       * 发出，同一轮会出现两个会话身份（首次尝试用旧 id、重连用 null）。
       * 身份一旦不再一致就丢弃冻结体，改由 hook 用当前身份重建。
       */
      initialRequest: frozenRequestMatchesSession(frozenRequest, sessionIdRef.current)
        ? frozenRequest ?? null
        : null,
      sse: createSseState(),
      abort: null,
      reconnectTimer: null,
    }
    activeRef.current = active
    runTurn(active)
  }

  /**
   * PR5（D-22，评审 MEDIUM-11）：把当前会话身份交给调用方，使"登记时的
   * 完整 wire 请求"能真正包含 session_id（此前只能由 hook 在派发时刻注入，
   * 于是登记体与实际请求不同源）。
   */
  const getCurrentSessionId = useCallback((): string | null => sessionIdRef.current, [])

  const send = (
    query: string,
    selection: ResearchChatSelection | undefined,
    modelId: string,
    /**
     * PR5（D-22）：调用方在**登记 consent 之前**冻结的幂等键。确认后必须
     * 复用它派发——否则"同意取消 → 重试"会换键（D-13 表① 禁止）。
     * 缺省（旧接线）保持每轮新键的既有语义。
     */
    frozenIdempotencyKey?: string,
    /** PR5（D-22）：登记的契约选择（确认后不再重判能力） */
    frozenContract?: 'v1' | 'c05-v1',
    /** PR5（D-22）：登记时冻结的完整 wire 请求（首次尝试原样发送） */
    frozenRequest?: ResearchChatRequest,
  ): void => {
    const trimmed = query.trim()
    if (!trimmed) return
    interactedRef.current = true
    // 新轮开始后不再提示恢复期遗留的在途/失败后台卡
    setBackgroundNotice(null)
    const previous = activeRef.current
    stopActive()
    if (previous) {
      // 抢占在途 turn 时补终态，避免其永久停留在 streaming（isStreaming 恒 true）
      patchAssistant(previous.turnId, {
        status: 'error',
        errorCode: 'superseded',
        errorMessage: 'Superseded by a newer request',
      })
    }
    const turnId = randomId()
    // RWV2-11（K8）：派发时刻冻结快照，写入 user/assistant turn 永久记录
    const scopeSnapshot = deriveScopeSnapshot(selection)
    const userTurn: ResearchChatTurn = {
      id: `user_${turnId}`,
      role: 'user',
      content: trimmed,
      thinking: '',
      citations: [],
      usage: null,
      resolvedMode: null,
      status: 'done',
      reconnectCount: 0,
      errorCode: null,
      errorMessage: null,
      coverageJobId: null,
      scopeSnapshot,
      serverMessageId: null,
      generationId: null,
    }
    const assistantTurn: ResearchChatTurn = {
      id: turnId,
      role: 'assistant',
      content: '',
      thinking: '',
      citations: [],
      usage: null,
      resolvedMode: null,
      status: 'streaming',
      reconnectCount: 0,
      errorCode: null,
      errorMessage: null,
      coverageJobId: null,
      scopeSnapshot,
      serverMessageId: null,
      generationId: null,
    }
    setTurns((prev) => [...prev, userTurn, assistantTurn])
    startTurn(trimmed, turnId, selection, modelId, frozenIdempotencyKey, frozenContract, frozenRequest)
  }

  const sendCoverage = (
    query: string,
    selection: ResearchChatSelection | undefined,
    modelId: string,
    submit: (
      request: CoverageSubmitRequest,
      idempotencyKey: string,
    ) => Promise<{ job_id: string }>,
  ): void => {
    const trimmed = query.trim()
    if (!trimmed) return
    // Issue #302：与 send 同语义——新工作开始后恢复结果（历史+在途卡）
    // 不再灌入/提示本对话
    interactedRef.current = true
    setBackgroundNotice(null)
    const previous = activeRef.current
    stopActive()
    if (previous) {
      patchAssistant(previous.turnId, {
        status: 'error',
        errorCode: 'superseded',
        errorMessage: 'Superseded by a newer request',
      })
    }
    const turnId = randomId()
    const patch = (patch: Partial<ResearchChatTurn>): void => patchAssistant(turnId, patch)
    // RWV2-11（K8）：与 send 同语义——派发时刻冻结快照写入 turn 记录
    const scopeSnapshot = deriveScopeSnapshot(selection)
    const userTurn: ResearchChatTurn = {
      id: `user_${turnId}`,
      role: 'user',
      content: trimmed,
      thinking: '',
      citations: [],
      usage: null,
      resolvedMode: null,
      status: 'done',
      reconnectCount: 0,
      errorCode: null,
      errorMessage: null,
      coverageJobId: null,
      scopeSnapshot,
      serverMessageId: null,
      generationId: null,
    }
    const assistantTurn: ResearchChatTurn = {
      id: turnId,
      role: 'assistant',
      content: '',
      thinking: '',
      citations: [],
      usage: null,
      resolvedMode: null,
      status: 'streaming',
      reconnectCount: 0,
      errorCode: null,
      errorMessage: null,
      coverageJobId: null,
      scopeSnapshot,
      serverMessageId: null,
      generationId: null,
    }
    setTurns((prev) => [...prev, userTurn, assistantTurn])
    if (!modelId) {
      // fail-closed：无 confirmed 模型不发请求（与 send 一致，#243 §6.4）
      patch({
        status: 'error',
        errorCode: 'model_required',
        errorMessage: 'Select a research model before sending',
      })
      return
    }
    const idempotencyKey = newIdempotencyKey()
    const snapshot = deriveScopeSnapshot(selection)
    submit(
      {
        query: trimmed,
        source_ids: selection?.sourceIds ?? [],
        // Notes 不支持 Coverage（§6.1）：防御性恒空，即使调用方漏检
        note_ids: [],
        model_id: modelId,
        scopeMode: snapshot.mode,
        singleSourceId: snapshot.singleSourceId,
      },
      idempotencyKey,
    )
      .then(({ job_id }) => {
        patch({ status: 'done', coverageJobId: job_id })
      })
      .catch((error: Error) => {
        // #358：解析后端结构化 detail.code/detail.message——用户不再看到
        // 通用 Axios 503；code 进入稳定错误码通道（面板映射本地化文案），
        // message 作为诊断行。解析失败（非 axios 错误/无 detail）兜底原始
        // error.message。
        const detail = researchApiErrorDetail(error)
        patch({
          status: 'error',
          errorCode: detail.code ?? 'coverage_submit_failed',
          errorMessage:
            detail.message ||
            error.message ||
            'Coverage submission failed',
        })
      })
  }

  const isStreaming = turns.some((t) => t.status === 'streaming' || t.status === 'reconnecting')

  return {
    turns,
    /** PR5（D-22）：当前会话身份（供调用方在登记时冻结进 wire 请求） */
    getCurrentSessionId,
    isStreaming,
    backgroundNotice,
    send,
    sendCoverage,
    resolveChatOrigin,
    conversation,
  }
}
