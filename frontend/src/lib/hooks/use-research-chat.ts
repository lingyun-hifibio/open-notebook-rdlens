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
import { getExecutionPreferences, newIdempotencyKey, openResearchChatStream } from '@/lib/research/api'
import { applySseEvent, createSseState, type ResearchSseState } from '@/lib/research/sse'
import type { ResearchCitation, ResearchSseEvent, ResearchTokenUsage } from '@/lib/research/types'

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
  citations: ResearchCitation[]
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
  send: (query: string, selection?: ResearchChatSelection) => void
}

interface ActiveTurn {
  turnId: string
  query: string
  sourceIds: string[]
  noteIds: string[]
  modelId: string | null
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
  return `Research stream HTTP ${status}`
}

export function useResearchChat({ projectId }: { projectId: string }): UseResearchChatResult {
  const [turns, setTurns] = useState<ResearchChatTurn[]>([])
  const activeRef = useRef<ActiveTurn | null>(null)
  /** 单调 send 序号：偏好读取期间的新 send 使旧 turn 整体放弃（latest wins） */
  const latestSeqRef = useRef(0)
  /** 跨轮次续接的服务端 session_id（done 事件记录） */
  const sessionIdRef = useRef<string | null>(null)

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
        // #238：v1 契约显式透传执行偏好（不变量 2：后端不隐式补值）
        model_id: active.modelId ?? undefined,
      },
      idempotencyKey: active.idempotencyKey,
      lastEventId: active.lastEventId,
      onEvent: (event: ResearchSseEvent) => {
        const current = activeRef.current
        if (!current || current.turnId !== turnId) return
        const sse = applySseEvent(current.sse, event)
        current.sse = sse
        current.lastEventId = sse.lastEventId
        if (sse.terminal === 'done') {
          current.sessionId = sse.sessionId ?? current.sessionId
          sessionIdRef.current = current.sessionId
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
          // 缓冲不足且任务进行中：按退避重试（resume_after）
          scheduleReconnect()
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

  const startTurn = async (
    seq: number,
    trimmed: string,
    turnId: string,
    selection?: ResearchChatSelection,
  ): Promise<void> => {
    // #238：v1 契约要求显式 model_id——读取已保存执行偏好；
    // 无偏好阻止发送（后端不隐式补值，不变量 2）。
    let modelId: string | null = null
    try {
      const prefs = await getExecutionPreferences(projectId)
      modelId = prefs?.preferred_model_id ?? null
    } catch {
      // 偏好读取失败 = fail-closed：不发送
    }
    if (seq !== latestSeqRef.current) {
      // 偏好读取期间已被更新的 send 抢占 → 整体放弃（latest wins）
      return
    }
    if (!modelId) {
      patchAssistant(turnId, {
        status: 'error',
        errorCode: 'model_preference_required',
        errorMessage:
          'Select and save a model preference in the search panel first',
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

  const send = (query: string, selection?: ResearchChatSelection): void => {
    const trimmed = query.trim()
    if (!trimmed) return
    stopActive()
    const seq = latestSeqRef.current + 1
    latestSeqRef.current = seq
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
    void startTurn(seq, trimmed, turnId, selection)
  }

  const isStreaming = turns.some((t) => t.status === 'streaming' || t.status === 'reconnecting')

  return { turns, isStreaming, send }
}
