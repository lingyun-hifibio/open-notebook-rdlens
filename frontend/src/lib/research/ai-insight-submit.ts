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
  type CreateAiInsightRequest,
} from './ai-insight'
import { classifyAiInsightFailure } from './ai-insight-disposition'
import {
  buildAiInsightAttempt,
  clearAcknowledgedRiskMarkers,
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

/** operation 的收敛结果（真实 runGuarded 可能在 consent 确认后才执行本闭包） */
type OperationResult =
  | { kind: 'not_executed' }
  | { kind: 'abandoned' }
  | { kind: 'marker_write_failed' }
  | { kind: 'settled'; status: AiInsightSubmitStatus; errorCode?: string | null }

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
  /** S2 解析出的 stale 计数（派发成功后才展示） */
  staleSourceCount?: number
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
  /** consent 失效时刷新服务端 consent（下一派发重新确认 + 新 key） */
  onRefreshConsent?: () => void
  onCreated?: (insight: ResearchInsight, generationId: string) => void
  onQueued?: (jobId: string, generationId: string) => void
  onBlockedEmptyScope?: () => void
  /** stale Source 计数（派发时置位；consent 取消不留痕） */
  onStaleSourceCount?: (count: number) => void
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
    onRefreshConsent,
    onStaleSourceCount,
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
  // M-1：身份切换必须丢弃上一身份的冻结 attempt / 终态闸门 / 待确认 marker，否则
  // 会以旧项目的 Scope 向新项目派发（或把新项目提交拦成旧项目的冲突）。
  // N-3：ref 写入放在 effect（渲染期写 ref 违反 React 约定，且被丢弃的并发渲染
  // 也会清掉 ref）；effect 在提交后、任何用户事件前执行，故 submit() 看到的总是
  // 已重置状态。
  useEffect(() => {
    if (identityRef.current === identity) return
    identityRef.current = identity
    activeAttemptRef.current = null
    noticeRef.current = null
    riskAcknowledgedRef.current = new Set()
    setPendingMarker(null)
    setRetryableAttempt(null)
    setStatus('idle')
    setErrorCode(null)
  }, [identity])

  // FR-03：他标签页写入/清除 marker 时同步展示（无需用户先点一次提交才发现）
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = () => {
      if (!mountedRef.current) return
      const markers = listAiInsightRiskMarkers(userId, projectId)
      const unacknowledged = markers.filter(
        (marker) => !riskAcknowledgedRef.current.has(marker.markerId),
      )
      setPendingMarker(unacknowledged.length > 0 ? (unacknowledged[0] as AiInsightRiskMarker) : null)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [projectId, userId])



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
      // 仍存在未确认的旧 marker（多标签页并发）→ 继续展示下一枚，而不是让
      // 用户在下一次提交时被"静默再拦一次"
      const next = listAiInsightRiskMarkers(userId, projectId).find(
        (marker) => marker.markerId !== current.markerId &&
          !riskAcknowledgedRef.current.has(marker.markerId),
      )
      return next ?? null
    })
  }, [projectId, userId])

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
        // 与 409 升级路径同款回调：调用方需要可见反馈才能驱动用户确认
        onProtocolConflict?.()
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
    const attemptId = existingAttempt?.attemptId ?? newAttemptId()
    const scopeLabelOptions = input.scopeLabel !== undefined ? { scopeLabel: input.scopeLabel } : undefined
    /** 冻结派发目标：迟到的 200/202 必须收敛回**派发时**的项目 */
    const dispatchProjectId = projectId
    const dispatchUserId = userId

    /** 回调仅在组件存活且身份未切换时执行（FR-09）；缓存/ marker 收敛无条件 */
    const alive = (): boolean =>
      mountedRef.current && identityRef.current === `${dispatchUserId}/${dispatchProjectId}`
    /** 状态发布（同 publish，但使用冻结身份——operation 晚于 submit 执行） */
    const progress = (next: AiInsightSubmitStatus, code: string | null = null): void => {
      if (generation === generationRef.current && alive()) {
        setStatus(next)
        setErrorCode(code)
      }
    }

    /**
     * 完整 operation：marker → （惰性 key）→ POST → 解析 → disposition →
     * marker 生命周期 → 缓存合并 → Job 登记 → 回调。
     *
     * 关键：真实 `runGuarded` 在需要 consent 时**只登记不执行**，稍后由
     * `confirmConsent` 用捕获的快照 await 本 operation。因此所有「派发后」
     * 处理都必须在本闭包内完成——写在 dispatch 之后会被那条已返回的执行流
     * 丢弃（外部模型路径：付费外发已发生，但结果不合并、Job 不登记、marker
     * 不清、无错误提示）。
     */
    const runOperation = async (): Promise<OperationResult> => {
      // 登记后到确认之间发生新一代提交 / 身份切换 → 放弃本次（零外发）
      if (generation !== generationRef.current) return { kind: 'abandoned' }
      if (identityRef.current !== `${dispatchUserId}/${dispatchProjectId}`) {
        return { kind: 'abandoned' }
      }
      if (existingAttempt === null) {
        // FR-03：先写自己的 marker（写失败不发送）；此处才生成幂等键——
        // consent 未确认时本闭包不执行 ⇒ 零 key、零 marker、零 POST（C-06）
        if (!markAiInsightAttempt(dispatchUserId, dispatchProjectId, attemptId, 'fresh')) {
          // N-2：通知同样要在 operation 内（deferred consent 下 submit() 已返回）
          if (alive()) {
            onFailed?.(null)
            progress('failed')
          }
          return { kind: 'marker_write_failed' }
        }
        // H-2：用户已确认承担重复风险的旧 marker，在本轮新执行写入成功后才
        // 清除（否则刷新后旧 marker 重新变成未确认，每次会话首派发都被拦）
        const acknowledged = [...riskAcknowledgedRef.current]
        if (acknowledged.length > 0) {
          riskAcknowledgedRef.current.clear()
          clearAcknowledgedRiskMarkers(dispatchUserId, dispatchProjectId, acknowledged)
        }
        // L-2：已知晓的 stale 计数随真正派发置位（consent 取消不留痕）
        onStaleSourceCount?.(input.staleSourceCount ?? 0)
        if (alive()) progress('dispatching')
        const attempt = buildAiInsightAttempt(request, { id: attemptId, key: newKey(), now })
        activeAttemptRef.current = attempt
        if (mountedRef.current) setRetryableAttempt(attempt)
      } else {
        if (alive()) progress('dispatching')
      }
      try {
        const response = await createAiInsight(dispatchProjectId, request, {
          idempotencyKey: existingAttempt?.idempotencyKey ?? activeAttemptRef.current?.idempotencyKey ?? '',
        })
        const outcome = aiInsightOutcomeFromResponse(response)
        if (outcome.kind === 'created') {
          // FR-10：按 insight_id 合并进派发时项目的缓存，不立即 invalidate
          queryClient.setQueryData<ResearchPage<ResearchInsight>>(
            QUERY_KEYS.researchInsights(dispatchProjectId),
            (previous) => {
              const items = previous?.items ?? []
              if (items.some((item) => item.insight_id === outcome.insight.insight_id)) return previous
              return { items: [outcome.insight, ...items], next_cursor: previous?.next_cursor ?? null }
            },
          )
          noticeRef.current = null
          clearOwnMarker(attemptId)
          if (alive()) {
            onCreated?.(outcome.insight, outcome.generationId)
            progress('created')
          }
          return { kind: 'settled', status: 'created' }
        }
        if (outcome.kind === 'queued') {
          noticeRef.current = null
          clearOwnMarker(attemptId)
          if (alive()) {
            onQueued?.(outcome.jobId, outcome.generationId)
            progress('queued')
          }
          return { kind: 'settled', status: 'queued' }
        }
        // 缺契约头/畸形载荷/未知 2xx：绝不当成功，保留 marker 供同 key 重试
        noticeRef.current = 'outcome_unknown'
        if (alive()) {
          onOutcomeUnknown?.()
          progress('outcome_unknown')
        }
        return { kind: 'settled', status: 'outcome_unknown' }
      } catch (error) {
        const disposition = classifyAiInsightFailure(error)
        const action = markerActionForDisposition(disposition)
        if (action === 'escalate') {
          // 协议冲突：保留并升级 marker（fresh → recovery），禁止自动重发
          markAiInsightAttempt(dispatchUserId, dispatchProjectId, attemptId, 'recovery')
          noticeRef.current = 'protocol_conflict'
          if (alive()) {
            onProtocolConflict?.()
            progress('protocol_conflict')
          }
          return { kind: 'settled', status: 'protocol_conflict' }
        }
        if (action === 'clear' || action === 'clear_and_refresh_consent') {
          const code = extractResearchErrorCode(error)
          noticeRef.current = null
          clearOwnMarker(attemptId)
          if (action === 'clear_and_refresh_consent') {
            // consent 失效：刷新服务端 consent，下一次派发重新走确认（新 key）
            onRefreshConsent?.()
          }
          if (alive()) {
            onFailed?.(code)
            progress('failed', code)
          }
          return { kind: 'settled', status: 'failed', errorCode: code }
        }
        // keep：结果未知/可同 key 重试（仍需用户显式确认后才能重发）
        noticeRef.current = 'outcome_unknown'
        if (alive()) {
          onOutcomeUnknown?.()
          progress('outcome_unknown')
        }
        return { kind: 'settled', status: 'outcome_unknown' }
      }
    }

    publish('dispatching')

    let result: OperationResult
    try {
      // modelId 入参不消费：请求载荷的 model_id 在冻结 request 时已固定
      // （模型切换不得改变在途/重试载荷，C-04）
      result = (await dispatch(() => runOperation(), scopeLabelOptions)) ?? { kind: 'not_executed' }
    } catch {
      // operation 自身抛错（理论上已在内部收敛；此处兜底为结果未知，保留 marker）
      noticeRef.current = 'outcome_unknown'
      onOutcomeUnknown?.()
      return publish('outcome_unknown')
    }

    if (result.kind === 'not_executed') {
      // consent 未执行（取消/未确认）：零 key、零 marker、零 POST
      activeAttemptRef.current = null
      if (mountedRef.current) setRetryableAttempt(null)
      return publish('idle')
    }
    if (result.kind === 'abandoned') {
      return publish('idle')
    }
    if (result.kind === 'marker_write_failed') {
      onFailed?.(null)
      return publish('failed')
    }
    return publish(result.status, result.errorCode ?? null)
  }, [
    clearOwnMarker, dispatch, newAttemptId, newKey, now, onBlockedEmptyScope, onCreated,
    onFailed, onOutcomeUnknown, onProtocolConflict, onQueued, onRefreshConsent,
    onStaleSourceCount, projectId, queryClient, userId,
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
