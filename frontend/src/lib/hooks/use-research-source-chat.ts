'use client'

/**
 * Source-scoped Research Chat 状态机（Issue #182，/research 下半屏）。
 *
 * 与全局 `useResearchChat` 的关系：只复用低层 sse reducer/parser、
 * Research bearer token 与参数化后的 stream transport（`path` 指向
 * `/sources/{source_id}/chat`），不抽象通用聊天框架，不复用上游
 * SessionManager/ChatPanel。与全局语义的差异：
 *
 * - `session_id` 在发送首条消息**前**预生成 `sess_<uuid>`（首轮断线恢复
 *   不依赖 done 事件才获知 session_id；服务端以 X-Chat-Session-Id 回显，
 *   仅存储 + 不匹配告警，不作行为依赖）。
 * - 断线恢复边界（契约 §9.5）：非终态网络异常/**正常 EOF** 均进入有限
 *   指数退避重连（Last-Event-ID + 同 session_id）；收到 done/error 后的
 *   正常 EOF 不重连。
 * - 409 二分语义（detail 结构化为 {"message", "resume_after"}）：`resume_after`
 *   为 **SSE event_id 游标**（服务端缓冲最早可用事件，非秒数）时 → 以
 *   `Last-Event-ID = resume_after - 1` 接受缺口续放（有限退避）；为 null/缺失
 *  （同 Source 同 session 活动 turn 冲突 / 缓冲缺失）→ 直接终态报错，不盲重试。
 * - Gateway 不可用（404/503）：fail-closed 终态错误 + 重放入口；
 *   绝不回退原生 `/api/source-chat`。
 * - 默认新会话，**不自动选择**最近会话；选择历史会话走 GET session detail
 *   冷恢复（17 字段 Citation 快照映射为统一展示形态）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  getSourceChatSession,
  listSourceChatSessions,
  newIdempotencyKey,
  openResearchChatStream,
  type ResearchSourceChatMessage,
  type ResearchSourceChatSessionSummary,
} from '@/lib/research/api'
import { applySseEvent, createSseState, type ResearchSseState } from '@/lib/research/sse'
import type {
  ResearchCitationDisplayItem,
  ResearchSseEvent,
  ResearchSourceRef,
  ResearchTokenUsage,
} from '@/lib/research/types'
import type { ResearchCitation as ResearchCitationSnapshot } from '@/lib/types/research'

/** 断线/EOF/可恢复 409 的最大尝试次数（含首次） */
export const SOURCE_CHAT_MAX_STREAM_ATTEMPTS = 3

/** 重连退避基数（ms）；第 n 次重试等待 base * 2^(n-1) */
export const SOURCE_CHAT_RECONNECT_BACKOFF_MS = 300

export type ResearchSourceChatTurnStatus = 'streaming' | 'reconnecting' | 'done' | 'error'

/** source_ref 的 camelCase 展示视图（turn 层起使用） */
export interface SourceChatSourceRefView {
  sourceId: string
  documentId: string
  documentVersion: string
}

export interface ResearchSourceChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  citations: ResearchCitationDisplayItem[]
  usage: ResearchTokenUsage | null
  resolvedMode: string | null
  degradationReasons: string[]
  sourceRef: SourceChatSourceRefView | null
  status: ResearchSourceChatTurnStatus
  reconnectCount: number
  errorCode: string | null
  errorMessage: string | null
}

export interface UseResearchSourceChatResult {
  turns: ResearchSourceChatTurn[]
  isStreaming: boolean
  /**
   * Issue #243 §6.4：modelId 是 required——调用方必须传入调用时刻捕获的
   * confirmed 全局模型快照。本 hook 不在执行时读取执行偏好，重放（retry）
   * 也沿用同一快照，因此后续切换模型不会影响在途/重放 turn（不变量 4）。
   */
  send: (query: string, modelId: string) => void
  /** source-scoped 会话列表（首页 limit 20；不做游标翻页） */
  sessions: ResearchSourceChatSessionSummary[]
  /** 当前绑定会话；null = 新会话（尚未隐式创建） */
  activeSessionId: string | null
  /** 选择历史会话冷恢复；null = 回到新会话并清空本地消息 */
  selectSession: (sessionId: string | null) => void
  loadDetailError: string | null
  /** 最近一次终态失败的 query（供 UI 重放入口）；成功发送后清空 */
  retryableQuery: string | null
  retry: () => void
}

interface ActiveTurn {
  turnId: string
  query: string
  modelId: string
  /** 每 turn 生成一次；断线重连必须复用（新键 = 新 Generation 双扣） */
  idempotencyKey: string
  attempt: number
  reconnectCount: number
  lastEventId: number
  sessionId: string
  sse: ResearchSseState
  abort: (() => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

/** 首条消息发送前预生成 session_id（Issue #182 恢复边界） */
export function generateSourceChatSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sess_${crypto.randomUUID()}`
  }
  // 非 secure context 兜底：保持 sess_ 前缀与足够熵即可
  const fallback = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
    .padEnd(32, '0')
    .slice(0, 32)
  return `sess_${fallback.slice(0, 8)}-${fallback.slice(8, 12)}-${fallback.slice(12, 16)}-${fallback.slice(16, 20)}-${fallback.slice(20, 32)}`
}

function randomTurnId(): string {
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function httpErrorMessage(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string' && detail) {
    return detail
  }
  // 结构化 detail：{"message": str, "resume_after": int|null}
  if (isRecord(detail)) {
    const message = detail.message
    if (typeof message === 'string' && message) {
      return message
    }
  }
  return `Research stream HTTP ${status}`
}

/**
 * 409 detail.resume_after：**SSE event_id 游标**（服务端缓冲最早可用事件的
 * event_id，非秒数）。仅「缓冲缺口且任务进行中」时为 int；并发 turn 冲突 /
 * 缓冲缺失时为 null。null/缺失/非法 → null（区分两类 409）。
 */
function extractResumeAfterCursor(body: unknown): number | null {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (!isRecord(detail)) {
    return null
  }
  const raw = detail.resume_after
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    return raw
  }
  return null
}

function mapSourceRef(ref: ResearchSourceRef | null | undefined): SourceChatSourceRefView | null {
  if (!ref) return null
  return {
    sourceId: ref.source_id,
    documentId: ref.document_id,
    documentVersion: ref.document_version,
  }
}

/** 17 字段持久化 Citation 快照 → 轻量展示形态（与 SSE 形态共用渲染组件） */
function mapSnapshotCitation(citation: ResearchCitationSnapshot): ResearchCitationDisplayItem {
  return {
    citation_id: citation.citation_id,
    claim: citation.claim,
    doc_id: citation.doc_id,
    page_idx: citation.page_idx,
    confidence: citation.confidence,
  }
}

function emptyAssistantTurn(id: string): ResearchSourceChatTurn {
  return {
    id,
    role: 'assistant',
    content: '',
    thinking: '',
    citations: [],
    usage: null,
    resolvedMode: null,
    degradationReasons: [],
    sourceRef: null,
    status: 'streaming',
    reconnectCount: 0,
    errorCode: null,
    errorMessage: null,
  }
}

function makeUserTurn(turnId: string, content: string): ResearchSourceChatTurn {
  return {
    id: `user_${turnId}`,
    role: 'user',
    content,
    thinking: '',
    citations: [],
    usage: null,
    resolvedMode: null,
    degradationReasons: [],
    sourceRef: null,
    status: 'done',
    reconnectCount: 0,
    errorCode: null,
    errorMessage: null,
  }
}

/** 冷恢复：GET session detail 持久化消息 → 与 live turn 相同展示形态 */
function mapColdMessage(message: ResearchSourceChatMessage): ResearchSourceChatTurn {
  return {
    id: message.message_id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content ?? '',
    thinking: message.thinking ?? '',
    citations: (message.citations ?? []).map(mapSnapshotCitation),
    usage: message.usage ?? null,
    resolvedMode: message.resolved_mode ?? null,
    degradationReasons: message.degradation_reasons ?? [],
    sourceRef: mapSourceRef(message.source_ref),
    status: 'done',
    reconnectCount: 0,
    errorCode: null,
    errorMessage: null,
  }
}

export function useResearchSourceChat({
  projectId,
  sourceId,
}: {
  projectId: string
  sourceId: string
}): UseResearchSourceChatResult {
  const [turns, setTurns] = useState<ResearchSourceChatTurn[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [loadDetailError, setLoadDetailError] = useState<string | null>(null)
  const [retryableQuery, setRetryableQuery] = useState<string | null>(null)
  const activeRef = useRef<ActiveTurn | null>(null)
  /** 跨轮次绑定的服务端 session（发送前预生成 / 冷恢复回填 / 回显采纳） */
  const sessionIdRef = useRef<string | null>(null)
  /** 终态失败 turn 的模型快照：重放沿用同一快照，不随后续切换漂移（不变量 4） */
  const retryModelRef = useRef<string | null>(null)

  const patchAssistant = useCallback((turnId: string, patch: Partial<ResearchSourceChatTurn>) => {
    setTurns((prev) => {
      const index = prev.findIndex((t) => t.id === turnId)
      if (index < 0) return prev
      const next = [...prev]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [])

  const stopActive = useCallback(() => {
    const active = activeRef.current
    if (!active) return
    if (active.abort) active.abort()
    if (active.reconnectTimer) clearTimeout(active.reconnectTimer)
    activeRef.current = null
  }, [])

  // 切换 Source（含卸载）：中止旧流本地读取并清空会话引用；
  // 服务端旧 turn 不受影响（浏览器断开 ≠ 取消）
  useEffect(() => {
    stopActive()
    sessionIdRef.current = null
    setActiveSessionId(null)
    setLoadDetailError(null)
    setRetryableQuery(null)
    retryModelRef.current = null
    setTurns([])
  }, [sourceId, stopActive])

  useEffect(() => stopActive, [stopActive])

  const sessionsQuery = useQuery({
    // Issue #182：research-source-chat 前缀，避免与上游 source-chat 缓存冲突
    queryKey: ['research-source-chat', 'sessions', projectId, sourceId],
    queryFn: () => listSourceChatSessions(projectId, sourceId, { limit: 20 }),
    enabled: Boolean(projectId && sourceId),
  })
  const sessions = useMemo(() => sessionsQuery.data?.items ?? [], [sessionsQuery.data])

  const runTurn = (active: ActiveTurn): void => {
    const { turnId } = active

    const finishError = (errorCode: string, errorMessage: string): void => {
      patchAssistant(turnId, {
        status: 'error',
        errorCode,
        errorMessage,
      })
      setRetryableQuery(active.query)
    }

    const scheduleReconnect = (opts?: { resumeFrom?: number }): void => {
      const current = activeRef.current
      if (!current || current.turnId !== turnId) return
      if (current.attempt >= SOURCE_CHAT_MAX_STREAM_ATTEMPTS) {
        finishError(
          'stream_lost',
          `Connection lost after ${SOURCE_CHAT_MAX_STREAM_ATTEMPTS} attempts`,
        )
        return
      }
      current.attempt += 1
      current.reconnectCount += 1
      if (opts?.resumeFrom !== undefined) {
        // 接受缺口：水位前跳到服务端缓冲最早可用事件的前一个
        // （Last-Event-ID = resume_after - 1；不回退已收到的本地进度）
        const watermark = Math.max(current.sse.lastEventId, opts.resumeFrom - 1)
        if (watermark > current.sse.lastEventId) {
          current.sse = {
            ...current.sse,
            lastEventId: watermark,
            pending: current.sse.pending.filter((e) => e.event_id > watermark),
          }
          current.lastEventId = watermark
        }
      }
      patchAssistant(turnId, {
        status: 'reconnecting',
        reconnectCount: current.reconnectCount,
      })
      const delay = SOURCE_CHAT_RECONNECT_BACKOFF_MS * 2 ** (current.attempt - 2)
      current.reconnectTimer = setTimeout(() => {
        if (activeRef.current?.turnId === turnId) {
          runTurn(current)
        }
      }, delay)
    }

    active.abort = openResearchChatStream({
      projectId,
      path: `/sources/${encodeURIComponent(sourceId)}/chat`,
      request: {
        query: active.query,
        session_id: active.sessionId,
        // #238：v1 契约显式透传执行偏好（不变量 2：后端不隐式补值）
        model_id: active.modelId,
      },
      idempotencyKey: active.idempotencyKey,
      lastEventId: active.lastEventId,
      onResponseMeta: (headers) => {
        // X-Chat-Session-Id 回显：仅存储 + 不匹配告警，不作行为依赖（Issue #182）
        const echoed = headers.get('x-chat-session-id')
        if (!echoed || echoed === active.sessionId) return
        console.warn(
          `[source-chat] X-Chat-Session-Id mismatch: sent ${active.sessionId}, server echoed ${echoed}`,
        )
        active.sessionId = echoed
        sessionIdRef.current = echoed
        setActiveSessionId(echoed)
      },
      onEvent: (event: ResearchSseEvent) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        const sse = applySseEvent(current.sse, event)
        current.sse = sse
        current.lastEventId = sse.lastEventId
        const patch: Partial<ResearchSourceChatTurn> = {
          content: sse.answer,
          thinking: sse.thinking,
          citations: sse.citations,
          usage: sse.usage,
          resolvedMode: sse.resolvedMode,
          degradationReasons: sse.degradationReasons,
          sourceRef: mapSourceRef(sse.sourceRef),
        }
        if (sse.terminal === 'done') {
          current.sessionId = sse.sessionId ?? current.sessionId
          sessionIdRef.current = current.sessionId
          setActiveSessionId(current.sessionId)
          patch.status = 'done'
          setRetryableQuery(null)
          retryModelRef.current = null
        } else if (sse.terminal === 'error') {
          patch.status = 'error'
          patch.errorCode = sse.errorCode
          patch.errorMessage = sse.errorMessage
          setRetryableQuery(active.query)
        } else {
          // 非终态事件（含重连恢复后的首个事件）回到 streaming
          patch.status = 'streaming'
        }
        patchAssistant(turnId, patch)
      },
      onHttpError: (status, body) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        if (status === 409) {
          const resumeFrom = extractResumeAfterCursor(body)
          if (resumeFrom !== null) {
            // 缓冲缺口且任务进行中：以 Last-Event-ID=resume_after-1 接受缺口续放
            // （resume_after 为事件游标；计入有限退避预算）
            scheduleReconnect({ resumeFrom })
            return
          }
          // 同 Source 同 session 活动 turn 冲突 / 缓冲缺失：终态报错，不盲重试
          finishError('conflict_busy', httpErrorMessage(status, body))
          return
        }
        if (status === 404 || status === 503) {
          // Gateway/Surreal/Admission 依赖不可用或来源不可达：fail-closed
          finishError('gateway_unavailable', httpErrorMessage(status, body))
          return
        }
        finishError('http_error', httpErrorMessage(status, body))
      },
      onNetworkError: (error) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        if (current.attempt >= SOURCE_CHAT_MAX_STREAM_ATTEMPTS) {
          finishError(
            'stream_lost',
            `Connection lost after ${SOURCE_CHAT_MAX_STREAM_ATTEMPTS} attempts: ${error.message}`,
          )
          return
        }
        scheduleReconnect()
      },
      onEnd: () => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        // 未收到终态的正常 EOF 同样进入有限指数退避重连（Issue #182 §9.5）
        if (!current.sse.terminal) {
          scheduleReconnect()
        }
        // 已收到 done/error 的正常 EOF：不重连
      },
    })
  }

  const startTurn = (
    trimmed: string,
    sessionId: string,
    turnId: string,
    modelId: string,
  ): void => {
    // #243 §6.4：modelId 由调用方传入（confirmed 全局模型快照），本 hook
    // 不再在执行时读取执行偏好——显示什么就执行什么，快照不随后续切换漂移。
    if (!modelId) {
      // fail-closed：无 confirmed 模型不发请求（后端不隐式补值，不变量 2）
      patchAssistant(turnId, {
        status: 'error',
        errorCode: 'model_required',
        errorMessage: 'Select a research model before sending',
      })
      return
    }
    const active: ActiveTurn = {
      turnId,
      query: trimmed,
      modelId,
      idempotencyKey: newIdempotencyKey(),
      attempt: 1,
      reconnectCount: 0,
      lastEventId: 0,
      sessionId,
      sse: createSseState(),
      abort: null,
      reconnectTimer: null,
    }
    activeRef.current = active
    runTurn(active)
  }

  const send = (query: string, modelId: string): void => {
    const trimmed = query.trim()
    if (!trimmed || !projectId || !sourceId) return
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
    setRetryableQuery(null)
    retryModelRef.current = null
    if (sessionIdRef.current === null) {
      sessionIdRef.current = generateSourceChatSessionId()
    }
    const sessionId = sessionIdRef.current
    setActiveSessionId(sessionId)

    const turnId = randomTurnId()
    setTurns((prev) => [...prev, makeUserTurn(turnId, trimmed), emptyAssistantTurn(turnId)])

    retryModelRef.current = modelId
    startTurn(trimmed, sessionId, turnId, modelId)
  }

  const selectSession = useCallback((sessionId: string | null): void => {
    stopActive()
    sessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
    setRetryableQuery(null)
    retryModelRef.current = null
    setLoadDetailError(null)
    if (sessionId === null) {
      setTurns([])
      return
    }
    void (async () => {
      try {
        const detail = await getSourceChatSession(projectId, sourceId, sessionId)
        if (sessionIdRef.current !== sessionId) return // 选择已切换，丢弃过期结果
        setTurns(detail.messages.map(mapColdMessage))
      } catch (err) {
        if (sessionIdRef.current !== sessionId) return
        setLoadDetailError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [projectId, sourceId, stopActive])

  const retry = (): void => {
    if (retryableQuery === null) return
    const modelId = retryModelRef.current
    if (modelId === null) return // 无快照可复用 → fail-closed，不重放
    send(retryableQuery, modelId)
  }

  const isStreaming = turns.some((t) => t.status === 'streaming' || t.status === 'reconnecting')

  return {
    turns,
    isStreaming,
    send,
    sessions,
    activeSessionId,
    selectSession,
    loadDetailError,
    retryableQuery,
    retry,
  }
}
