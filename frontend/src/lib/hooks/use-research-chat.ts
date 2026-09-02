'use client'

/**
 * Research Chat SSE 交互状态机（UI-03，契约 v0 §8.2/§9）。
 *
 * - 单轮 turn = 用户消息 + 助手消息；助手消息内容由 SSE reducer 维护
 *   （乱序/重复事件按 event_id 去重排序，终态恰好一次）。
 * - 断线（传输层）自动重连：第二次起携带 `Last-Event-ID`（§9.5）；
 *   409（缓冲不足且任务进行中）同样按退避重试。
 * - 服务端 `error` 终态不重连；可重试错误码由 UI 标记。
 * - 浏览器断开 ≠ 取消：中止 fetch 只是停止本地读取，服务端继续
 *   （§9.6）；本 hook 不提供 Chat 取消。
 * - `session_id` 在 done 事件后保留，供下一轮续接。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getResearchChatSession,
  newIdempotencyKey,
  openResearchChatStream,
  type ResearchGlobalChatCard,
  type ResearchGlobalChatMessage,
} from '@/lib/research/api'
import { applySseEvent, createSseState, type ResearchSseState } from '@/lib/research/sse'
import type {
  ResearchCitationDisplayItem,
  ResearchSseEvent,
  ResearchTokenUsage,
} from '@/lib/research/types'

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

/** 已持久化消息行 → 展示 turn（阅读顺序重放；completed 轮 status 恒 done） */
function messageRowToTurn(row: ResearchGlobalChatMessage): ResearchChatTurn | null {
  if (row.role !== 'user' && row.role !== 'assistant') {
    return null
  }
  const usage = row.usage
  const base = {
    id: row.message_id,
    role: row.role,
    content: row.content ?? '',
    thinking: '',
    citations: [] as ResearchCitationDisplayItem[],
    usage: null as ResearchTokenUsage | null,
    resolvedMode: null as string | null,
    status: 'done' as const,
    reconnectCount: 0,
    errorCode: null as string | null,
    errorMessage: null as string | null,
  }
  if (row.role === 'user') {
    return base
  }
  return {
    ...base,
    thinking: row.thinking ?? '',
    citations: Array.isArray(row.citations)
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

/** 断线/409 的最大重连尝试次数（含首次） */
export const MAX_STREAM_ATTEMPTS = 3

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
}

export interface ResearchChatSelection {
  sourceIds?: string[]
  noteIds?: string[]
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
  send: (
    query: string,
    selection: ResearchChatSelection | undefined,
    modelId: string,
  ) => void
}

interface ActiveTurn {
  turnId: string
  query: string
  sourceIds: string[]
  noteIds: string[]
  /** startTurn 已 fail-closed（空 modelId 直接 error 不建 turn），重连必非空 */
  modelId: string
  /** 每 turn 生成一次；断线重连必须复用同一键（后端同键同 hash 可重入，
   *  新键 = 新 Generation，首事件前断线会双扣） */
  idempotencyKey: string
  attempt: number
  reconnectCount: number
  lastEventId: number
  sessionId: string | null
  sse: ResearchSseState
  abort: (() => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
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

export function useResearchChat({ projectId }: { projectId: string }): UseResearchChatResult {
  const [turns, setTurns] = useState<ResearchChatTurn[]>([])
  const [backgroundNotice, setBackgroundNotice] = useState<ResearchBackgroundNotice | null>(null)
  const activeRef = useRef<ActiveTurn | null>(null)
  /** 跨轮次续接的服务端 session_id（done 事件/响应头/恢复记录） */
  const sessionIdRef = useRef<string | null>(null)
  /**
   * Issue #302：本 project 已发生过用户发问（mount 后任何 send）——恢复
   * 结果不得灌进已开始的对话（旧历史可能晚于新轮返回）。
   */
  const interactedRef = useRef(false)
  /**
   * mount 恢复去重（StrictMode 双挂载友好）：cleanup（首轮被取消）会清
   * 状态允许重跑；completed 后同 project 不再重试。
   */
  const restoreStateRef = useRef<{ projectId: string | null; done: boolean }>({
    projectId: null,
    done: false,
  })

  const patchAssistant = useCallback((turnId: string, patch: Partial<ResearchChatTurn>) => {
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

  useEffect(() => stopActive, [stopActive])

  // Issue #302：mount 刷新恢复——持久化过最近 session 则拉取详情重放为
  // turns。sessionIdRef 先同步为存储值：恢复完成前用户抢发也续接同一
  // 会话（服务端不会因前端未恢复而另开）；恢复结果晚到且用户已交互时
  // 丢弃（interactedRef 闸），不把旧历史灌进已开始的对话。
  useEffect(() => {
    const restoreState = restoreStateRef.current
    if (restoreState.projectId === projectId && restoreState.done) return
    const storedId = readStoredSessionId(projectId)
    if (!storedId) return
    restoreStateRef.current = { projectId, done: false }
    sessionIdRef.current = storedId
    let cancelled = false

    void (async () => {
      const rows: ResearchGlobalChatMessage[] = []
      const seenMessageIds = new Set<string>()
      let cards: ResearchGlobalChatCard[] = []
      let cursor: string | null = null
      for (let page = 0; page < 1000; page += 1) {
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
  }, [projectId])

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

    active.abort = openResearchChatStream({
      projectId,
      request: {
        query: active.query,
        source_ids: active.sourceIds,
        note_ids: active.noteIds,
        session_id: active.sessionId ?? undefined,
        // #238：v1 契约显式透传执行偏好（不变量 2：后端不隐式补值）；
        // #243 §6.7：类型必填，快照缺失时 startTurn 已 fail-closed，重连
        // 路径无 undefined 兜底
        model_id: active.modelId,
      },
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
      },
      onHttpError: (status, body) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
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
          return
        }
        patchAssistant(turnId, {
          status: 'error',
          errorCode: 'http_error',
          errorMessage: httpErrorMessage(status, body),
        })
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
    const active: ActiveTurn = {
      turnId,
      query: trimmed,
      sourceIds: selection?.sourceIds ?? [],
      noteIds: selection?.noteIds ?? [],
      modelId,
      idempotencyKey: newIdempotencyKey(),
      attempt: 1,
      reconnectCount: 0,
      lastEventId: 0,
      sessionId: sessionIdRef.current,
      sse: createSseState(),
      abort: null,
      reconnectTimer: null,
    }
    activeRef.current = active
    runTurn(active)
  }

  const send = (
    query: string,
    selection: ResearchChatSelection | undefined,
    modelId: string,
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
    }
    setTurns((prev) => [...prev, userTurn, assistantTurn])
    startTurn(trimmed, turnId, selection, modelId)
  }

  const isStreaming = turns.some((t) => t.status === 'streaming' || t.status === 'reconnecting')

  return { turns, isStreaming, backgroundNotice, send }
}
