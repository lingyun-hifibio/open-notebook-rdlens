'use client'

/**
 * Issue #54 S4（R-02/R-06/R-08/C-06/C-09/C-10）：AI Insight 提交编排 hook。
 *
 * 本 hook 是 AI Insight 的唯一实现面：Scope 解析复用 S2 的唯一 resolver 结果
 * （由调用方传入已解析的 id 集），失败分类复用 S3 的唯一状态机，风险 marker 与
 * 幂等 attempt 复用 S3 的唯一存储。组件只渲染，不持有第二套 Scope/Job 状态。
 *
 * 关键不变量：
 * 1. **幂等键只在 consent 成功后的 operation 内生成**——consent 取消零 key、
 *    零 marker、零 POST（C-06）。
 * 2. **先写 marker 再 POST**；写失败则不发送（FR-03）。
 * 3. **同 key 重试复用冻结请求**；任何不确定结果都不隐式换 key（C-09）。
 * 4. 只有确定终局才清 marker；未知/可重试保留，协议冲突升级为需人工确认。
 * 5. 缓存合并与 Jobs 登记按**派发时的 projectId** 收敛（迟到响应不污染当前
 *    项目）；表单重置/toast 等 UI 副作用由令牌 + mounted 约束（FR-09/FR-10）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  aiInsightOutcomeFromResponse,
  createAiInsight,
  type AiInsightHttpResponse,
  type CreateAiInsightRequest,
} from './ai-insight'
import { classifyAiInsightFailure } from './ai-insight-disposition'
import {
  buildAiInsightAttempt,
  clearAiInsightRiskMarker,
  isAiInsightKeyRetryable,
  listAiInsightRiskMarkers,
  markAiInsightAttempt,
  markerActionForDisposition,
  type AiInsightAttempt,
  type AiInsightRiskMarker,
} from './ai-insight-risk'
import { newIdempotencyKey } from './api'
import { extractResearchErrorCode } from './errors'
import { QUERY_KEYS } from '@/lib/api/query-client'
import type { ResearchInsight, ResearchPage } from '@/lib/types/research'

export type AiInsightSubmitStatus =
  | 'idle'
  | 'dispatching'
  | 'created'
  | 'queued'
  | 'blocked_empty_scope'
  | 'outcome_unknown'
  | 'protocol_conflict'
  | 'failed'

export interface AiInsightSubmitInput {
  title: string
  /** AI 生成指令（非正文） */
  content: string
  /** S2 唯一 resolver 解析出的冻结 id 集 */
  sourceIds: string[]
  noteIds: string[]
  responseLanguage: 'zh' | 'en'
  modelId: string
  /** consent 弹窗 Scope 行（与请求同源快照） */
  scopeLabel?: string
}

export interface AiInsightSubmitResult {
  status: AiInsightSubmitStatus
  errorCode: string | null
  /** 已派发但结果未知/可重试的冻结尝试（可在 24h 内同 key 重试） */
  retryableAttempt: AiInsightAttempt<CreateAiInsightRequest> | null
  /** 检测到的旧 marker（页面恢复或协议冲突）——需用户明确确认才能开新执行 */
  pendingMarker: AiInsightRiskMarker | null
  /** 用户确认承担重复风险（清理旧 marker 语义由调用方决定，本 hook 记录放行） */
  confirmDuplicateRisk: () => void
  /** 放弃旧 marker 并回到空闲 */
  discardDuplicateRisk: () => void
}

interface Options {
  projectId: string
  userId: string
  /** 根级统一闸门（本地即时 / 外部模型 consent）；返回 undefined = 未执行 */
  dispatch: <T>(
    operation: (modelId: string) => Promise<T>,
    options?: { scopeLabel?: string },
  ) => Promise<T | undefined>
  /** 幂等键工厂（默认 `newIdempotencyKey`） */
  newKey?: () => string
  /** attempt id 工厂（默认 crypto.randomUUID） */
  newAttemptId?: () => string
  /** 注入时钟（默认 performance.now；测试用） */
  now?: () => number
  onCreated?: (insight: ResearchInsight, generationId: string) => void
  onQueued?: (jobId: string, generationId: string) => void
  onBlockedEmptyScope?: () => void
  onOutcomeUnknown?: () => void
  onProtocolConflict?: () => void
  onFailed?: (code: string | null) => void
}

function defaultAttemptId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

export function useAiInsightSubmit(options: Options): {
  submit: (input: AiInsightSubmitInput) => Promise<AiInsightSubmitStatus>
  result: AiInsightSubmitResult
  isSubmitting: boolean
} {
  const {
    projectId,
    userId,
    dispatch,
    newKey = newIdempotencyKey,
    newAttemptId = defaultAttemptId,
    now = monotonicNow,
    onCreated,
    onQueued,
    onBlockedEmptyScope,
    onOutcomeUnknown,
    onProtocolConflict,
    onFailed,
  } = options
  const queryClient = useQueryClient()

  const [status, setStatus] = useState<AiInsightSubmitStatus>('idle')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [retryableAttempt, setRetryableAttempt] =
    useState<AiInsightAttempt<CreateAiInsightRequest> | null>(null)
  const [pendingMarker, setPendingMarker] = useState<AiInsightRiskMarker | null>(null)

  /** 最近一次需要用户显式处置的结果（protocol_conflict / outcome_unknown）——
   *  它是「提交」与「再提交」之间的闸门：未处置前严禁再次外发 */
  const noticeRef = useRef<'protocol_conflict' | 'outcome_unknown' | null>(null)
  const activeAttemptRef = useRef<AiInsightAttempt<CreateAiInsightRequest> | null>(null)
  const riskAcknowledgedRef = useRef<Set<string>>(new Set())
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const identity = `${userId}/${projectId}`
  const identityRef = useRef(identity)
  identityRef.current = identity

  const clearOwnMarker = useCallback((attemptId: string) => {
    activeAttemptRef.current = null
    if (mountedRef.current) setRetryableAttempt(null)
    clearAiInsightRiskMarker(userId, projectId, attemptId)
  }, [projectId, userId])

  const confirmDuplicateRisk = useCallback(() => {
    noticeRef.current = null
    setPendingMarker((current) => {
      if (current === null) return null
      riskAcknowledgedRef.current.add(current.markerId)
      return null
    })
  }, [])

  const discardDuplicateRisk = useCallback(() => {
    noticeRef.current = null
    activeAttemptRef.current = null
    setPendingMarker((current) => {
      if (current !== null) {
        clearAiInsightRiskMarker(userId, projectId, current.markerId)
      }
      return null
    })
    if (mountedRef.current) {
      setStatus('idle')
      setErrorCode(null)
    }
  }, [projectId, userId])

  const submit = useCallback(async (input: AiInsightSubmitInput): Promise<AiInsightSubmitStatus> => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const identityAtStart = identityRef.current
    /** UI 可见态写入（陈旧执行流一律跳过；返回值仍真实） */
    const publish = (next: AiInsightSubmitStatus, code: string | null = null): AiInsightSubmitStatus => {
      if (generation === generationRef.current && mountedRef.current && identityRef.current === identityAtStart) {
        setStatus(next)
        setErrorCode(code)
      }
      return next
    }

    if (input.sourceIds.length + input.noteIds.length === 0) {
      onBlockedEmptyScope?.()
      return publish('blocked_empty_scope')
    }

    // 协议冲突态不得重发：这类结果无法用同 key 收敛（同 key 已证明是冲突），
    // 必须由用户先明确处置——确认重复风险或放弃（S3 protocol_conflict 语义）。
    // 注：outcome_unknown 不在此列——同 key 重试是它的**唯一安全动作**，
    // 但仍由每次提交开头的恢复 gate 展示 marker（用户可见地再发）。
    if (noticeRef.current === 'protocol_conflict') {
      const markers = listAiInsightRiskMarkers(userId, projectId)
      setPendingMarker(
        markers[0] ?? {
          markerId: activeAttemptRef.current?.attemptId ?? 'unknown-attempt',
          kind: 'recovery',
          recordedAt: 0,
        },
      )
      onProtocolConflict?.()
      return publish('protocol_conflict')
    }

    // 同 key 重试：必须复用冻结 attempt（不换 key、不重建 request）
    const existingAttempt = activeAttemptRef.current
    if (existingAttempt !== null && !isAiInsightKeyRetryable(existingAttempt, now())) {
      // ≥24h：Host 幂等窗口外重放可能成为新执行 → 必须先确认重复风险
      const markers = listAiInsightRiskMarkers(userId, projectId)
      setPendingMarker(
        markers[0] ?? { markerId: existingAttempt.attemptId, kind: 'recovery', recordedAt: 0 },
      )
      activeAttemptRef.current = null
      if (mountedRef.current) setRetryableAttempt(null)
      return publish('protocol_conflict')
    }

    // 恢复态 gate：存在未确认的旧 marker（他页/前次崩溃）→ 先让用户明确选择
    if (existingAttempt === null) {
      const unacknowledged = listAiInsightRiskMarkers(userId, projectId).filter(
        (marker) => !riskAcknowledgedRef.current.has(marker.markerId),
      )
      if (unacknowledged.length > 0) {
        setPendingMarker(unacknowledged[0] as AiInsightRiskMarker)
        return publish('protocol_conflict')
      }
    }

    const request: CreateAiInsightRequest = existingAttempt?.request ?? {
      title: input.title,
      content: input.content,
      insight_type: 'ai',
      model_id: input.modelId,
      context_level: 'focused',
      source_ids: input.sourceIds,
      note_ids: input.noteIds,
      response_language: input.responseLanguage,
    }
    /** 哨兵：区分「consent 取消」与「marker 写入失败」 */
    const MARKER_WRITE_FAILED = Symbol('marker_write_failed')
    const attemptId = existingAttempt?.attemptId ?? newAttemptId()
    const frozen: AiInsightAttempt<CreateAiInsightRequest> = existingAttempt ??
      buildAiInsightAttempt(request, { id: attemptId, key: newKey(), now })
    const scopeLabelOptions = input.scopeLabel !== undefined ? { scopeLabel: input.scopeLabel } : undefined

    // FR-03/C-06：market 与 POST 都在**真正的 operation 内**。
    // - 外部模型且 consent 未生效：dispatch 只登记 op（返回 undefined）→
    //   operation 不执行 → 零 key、零 marker、零 POST；
    // - consent 确认后（含跨组件卸载）operation 才执行：先写自己 marker，
    //   写失败则不发送。
    // 重试路径不入闸门：key/marker 已存在，consent 已在首派发时确认。
    const firstAttemptOperation = async () => {
      if (generation !== generationRef.current) return undefined
      if (!markAiInsightAttempt(userId, projectId, frozen.attemptId, 'fresh')) {
        return MARKER_WRITE_FAILED
      }
      activeAttemptRef.current = frozen
      if (mountedRef.current) setRetryableAttempt(frozen)
      return createAiInsight(projectId, frozen.request, { idempotencyKey: frozen.idempotencyKey })
    }
    const retryOperation = async () => {
      activeAttemptRef.current = frozen
      if (mountedRef.current) setRetryableAttempt(frozen)
      return createAiInsight(projectId, frozen.request, { idempotencyKey: frozen.idempotencyKey })
    }

    publish('dispatching')

    const runOperation = existingAttempt === null ? firstAttemptOperation : retryOperation
    let httpResponse: AiInsightHttpResponse | undefined | typeof MARKER_WRITE_FAILED
    try {
      // modelId 入参不消费：请求载荷的 model_id 在冻结 request 时已固定
      // （模型切换不得改变在途/重试载荷，C-04）
      httpResponse = await dispatch(
        () => runOperation(),
        scopeLabelOptions,
      )
    } catch (error) {
      const disposition = classifyAiInsightFailure(error)
      const action = markerActionForDisposition(disposition)
      if (action === 'escalate') {
        // 协议冲突：保留并升级 marker（fresh → recovery），禁止自动重发
        markAiInsightAttempt(userId, projectId, frozen.attemptId, 'recovery')
        noticeRef.current = 'protocol_conflict'
        onProtocolConflict?.()
        return publish('protocol_conflict')
      }
      if (action === 'clear' || action === 'clear_and_refresh_consent') {
        const code = extractResearchErrorCode(error)
        noticeRef.current = null
        clearOwnMarker(frozen.attemptId)
        onFailed?.(code)
        return publish('failed', code)
      }
      // keep：结果未知/可同 key 重试（仍需用户显式确认后才能重发）
      noticeRef.current = 'outcome_unknown'
      onOutcomeUnknown?.()
      return publish('outcome_unknown')
    }

    // marker 写入失败 → 不发送请求（未受保护）
    if (httpResponse === MARKER_WRITE_FAILED) {
      onFailed?.(null)
      return publish('failed')
    }
    // 二次 consent 判定的未执行路径（探针通过后取消/代际作废）→ 保持零副作用
    if (httpResponse === undefined) {
      activeAttemptRef.current = null
      if (mountedRef.current) setRetryableAttempt(null)
      return publish('idle')
    }

    const outcome = aiInsightOutcomeFromResponse(httpResponse)
    if (outcome.kind === 'created') {
      // FR-10：按 insight_id 合并进派发时项目的缓存，不立即 invalidate
      queryClient.setQueryData<ResearchPage<ResearchInsight>>(
        QUERY_KEYS.researchInsights(projectId),
        (previous) => {
          const items = previous?.items ?? []
          if (items.some((item) => item.insight_id === outcome.insight.insight_id)) return previous
          return { items: [outcome.insight, ...items], next_cursor: previous?.next_cursor ?? null }
        },
      )
      noticeRef.current = null
      clearOwnMarker(frozen.attemptId)
      onCreated?.(outcome.insight, outcome.generationId)
      return publish('created')
    }
    if (outcome.kind === 'queued') {
      noticeRef.current = null
      clearOwnMarker(frozen.attemptId)
      onQueued?.(outcome.jobId, outcome.generationId)
      return publish('queued')
    }
    // 缺契约头/畸形载荷/未知 2xx：绝不当成功，保留 marker 供同 key 重试
    noticeRef.current = 'outcome_unknown'
    onOutcomeUnknown?.()
    return publish('outcome_unknown')
  }, [
    clearOwnMarker, dispatch, newAttemptId, newKey, now, onBlockedEmptyScope, onCreated,
    onFailed, onOutcomeUnknown, onProtocolConflict, onQueued, projectId, queryClient, userId,
  ])

  return {
    submit,
    isSubmitting: status === 'dispatching',
    result: {
      status,
      errorCode,
      retryableAttempt,
      pendingMarker,
      confirmDuplicateRisk,
      discardDuplicateRisk,
    },
  }
}
