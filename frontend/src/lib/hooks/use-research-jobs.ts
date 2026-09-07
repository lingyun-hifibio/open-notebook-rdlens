'use client'

/**
 * Research 持久 Job 交互状态机（UI-03，契约 v0 §8.3/§10；REQ-JOB-02；
 * RWV2-41 Fork #46 Activity Center）。
 *
 * - Job 是服务端持久实体；本地只缓存最近一次 GET 快照 + job_id 集合。
 *   `localStorage` 仅存 job_id（浏览器关闭后恢复查看），**状态永远以
 *   服务端 GET 为准**——本地组件状态不是持久 Job 状态（任务卡验收）。
 * - Issue #311：服务端列表恢复——mount 时拉 `GET .../jobs`（cursor
 *   穷尽，limit=100/页）∪ localStorage job_id 并集，逐个回源；列表失败
 *   静默回退 localStorage（旧后端/离线兼容，双端部署顺序无关）。
 * - RWV2-41 触发矩阵（v4）：
 *   - 项目 mount / Activity Dialog open → 全量枚举（cursor 穷尽）；
 *   - window focus → 第一页刷新 + 30s 冷却（跨设备“新”任务必在最新端）；
 *   - 创建/登记成功 → 第一页刷新。
 *   全量枚举逐页流式 merge，每页 await 后重查项目（切换即中止）；单飞。
 * - 轮询非终态 Job（间隔 POLL_INTERVAL_MS）；终态一次：已观察到终态后，
 *   迟到的非终态响应不回归卡片。
 * - purge（404）确认策略（#313 minor2 + 审查 M-A/M-B）：首次 404 摘出
 *   轮询并调度一次延时确认回源；确认仍 404 → 摘卡 + 剪 localStorage +
 *   清理锁集合 + 记 `removedIdsRef` 墓碑；确认非 404（成功或网络错误）
 *   → 中止 purge、重新登记轮询（保守自愈）。墓碑仅由服务端列表再次包含
 *   清除（单次 GET 成功不清除——防迟到 in-flight 响应复活幽灵）。
 * - 权威对账（审查 M-D）：全量枚举成功后，剔除 state 中既不在服务端
 *   id 集、也不在 localStorage 并集的残留（终态 purge 幽灵收口）。
 * - coverage 富化（审查 H1）：coverage Job 的列表行不含 `coverage` 段；
 *   Activity 打开后对可见 coverage 行调用 `ensureCoverageDetails` 回源
 *   详情（报告重开/outcome_unknown 重试依赖该段）。
 * - 取消必须显式（POST /jobs/{id}/cancel；契约 §10.3）：queued/running →
 *   cancelling → cancelled；已终态取消即报错（completed → 409 语义）。
 * - Compare 创建前置校验（REQ-QUOTA-01）：51 篇 → 拒绝且不发请求。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { isAxiosError } from 'axios'
import {
  cancelJob,
  createCompare,
  getJob,
  listJobs,
  newIdempotencyKey,
  retryCoverageJob,
} from '@/lib/research/api'
import { canCancelJob, isJobTerminal } from '@/lib/research/jobs'
import { checkCompareSelection, COMPARE_HARD_MAX } from '@/lib/research/compare'
import { extractResearchErrorCode } from '@/lib/research/errors'
import type { ResearchJob } from '@/lib/research/types'

export const POLL_INTERVAL_MS = 3000

/** RWV2-41：列表刷新单飞防抖下，focus 触发的第一页刷新的冷却时长。 */
export const FOCUS_LIST_REFRESH_COOLDOWN_MS = 30_000

/** RWV2-41：purge 确认回源延时（首次 404 后等待确认再落定）。 */
export const PURGE_CONFIRM_DELAY_MS = 1000

/** RWV2-41：全量枚举页数上限（防御畸形 cursor/超长历史）。 */
export const MAX_JOB_LIST_PAGES = 100

const STORAGE_PREFIX = 'rdlens.research.jobs.'

/** 列表恢复拉满服务端单页上限（limit 合法域 1..100）。 */
const LIST_FETCH_LIMIT = 100

export type ResearchJobListStatus = 'loading' | 'ready' | 'error'

export function readStoredJobIds(projectId: string): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
  } catch {
    return []
  }
}

function writeStoredJobId(projectId: string, jobId: string): void {
  try {
    const ids = readStoredJobIds(projectId)
    if (!ids.includes(jobId)) {
      ids.push(jobId)
      localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(ids))
    }
  } catch {
    // 存储不可用（隐私模式等）：仅失去跨会话恢复，不影响本次会话
  }
}

function removeStoredJobId(projectId: string, jobId: string): void {
  try {
    const ids = readStoredJobIds(projectId).filter((id) => id !== jobId)
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(ids))
  } catch {
    // 存储不可用：跳过剪除（读侧容错）
  }
}

export interface UseResearchJobsResult {
  jobs: ResearchJob[]
  isCreating: boolean
  error: string | null
  /**
   * RWV2-42：最近一次创建/取消/重试错误的稳定码（HTTP detail.code 或本地
   * 防御性前置校验码 compare-empty/compare-over-hard/no-model）。raw
   * message 语义不变（`error`），code 仅供 UI 映射层使用；additive。
   */
  errorCode: string | null
  /**
   * RWV2-41：Activity 内 cancel/coverage-retry 的动作错误（可关闭）。
   * 与 `error`（Compare 创建等既有通道）分离，避免相互污染展示面；
   * cancel/retry 失败同时写 `error` 以保持既有消费方/断言兼容。
   */
  actionError: string | null
  clearActionError: () => void
  /**
   * RWV2-41：服务端列表状态。'loading' = 初始/重试加载中；
   * 'ready' = 最近一次全量/第一页刷新成功；'error' = 全量刷新失败
   * （UI 依 localStorage 是否有兜底 id 分级为非破坏提示或错误态）。
   */
  listStatus: ResearchJobListStatus
  listError: string | null
  /** 重试全量列表刷新（从 'error' 恢复）。 */
  retryList: () => void
  /** RWV2-41：Activity Dialog 打开时触发的全量刷新（对账宿主）。 */
  refreshActivity: () => void
  /** RWV2-41：对给定 job_id 批量回源详情（coverage 富化，去重）。 */
  ensureCoverageDetails: (jobIds: readonly string[]) => void
  /**
   * Issue #243 §6.4：modelId 是 required——调用方必须传入调用时刻捕获的
   * confirmed 全局模型快照。本 hook 不在执行时读取执行偏好，因此后续切换
   * 模型不会影响已创建的 Job（不变量 4）。Compare 固定 workspace 上下文。
   * 返回 null 表示前置校验拒绝（未发请求）。
   */
  createCompare: (
    documentIds: readonly string[],
    modelId: string,
    groupSize?: number,
  ) => ResearchJob | null
  cancel: (jobId: string) => void
  /**
   * COV-09：把 all_selected 受理的 research_coverage Job 登记进本 hook 的
   * 已知集合（localStorage + 立即回源）——Chat 创建的任务在 Activity 可见、
   * 刷新后继续轮询同一 Job（§12.2/REQ-COV-09）。
   */
  registerCoverageJob: (jobId: string) => void
  /**
   * COV-09：outcome_unknown 显式人工重试（§12.2）。新幂等键 + 确认计费
   * 风险；成功后立即回源（Job 重新 queued）。返回是否已受理。
   */
  retryCoverage: (jobId: string) => Promise<boolean>
}

export function useResearchJobs({ projectId }: { projectId: string }): UseResearchJobsResult {
  const [jobs, setJobs] = useState<ResearchJob[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [listStatus, setListStatus] = useState<ResearchJobListStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const terminalLockedRef = useRef<Set<string>>(new Set())
  const knownIdsRef = useRef<Set<string>>(new Set())
  /** RWV2-41：purge 墓碑——merge 拒绝；仅由列表权威证活清除。 */
  const removedIdsRef = useRef<Set<string>>(new Set())
  /** RWV2-41：coverage 富化去重（成功回源后记入；项目切换清空）。 */
  const enrichedIdsRef = useRef<Set<string>>(new Set())
  /** RWV2-41：purge 确认 timer（job_id → handle；单实例可取消）。 */
  const purgeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  /** RWV2-41：全量刷新单飞。 */
  const refreshingRef = useRef(false)
  /** RWV2-41：focus 第一页刷新冷却。 */
  const lastFocusPage1AtRef = useRef(0)
  // Issue #311：项目切换守卫——在途 listJobs/getJob 响应返回时若项目已
  // 切换则丢弃，防止旧项目任务卡污染新项目视图（并在轮询中跨项目 404）。
  const projectIdRef = useRef<string>(projectId)

  /** 合并一次服务端快照；终态一次（非终态响应不得回归已终态卡片）。 */
  const mergeJob = useCallback((incoming: ResearchJob) => {
    setJobs((prev) => {
      if (removedIdsRef.current.has(incoming.job_id)) {
        // purge 墓碑：拒绝迟到/非权威响应复活幽灵
        return prev
      }
      const index = prev.findIndex((j) => j.job_id === incoming.job_id)
      if (index < 0) {
        if (isJobTerminal(incoming.status)) {
          terminalLockedRef.current.add(incoming.job_id)
        }
        return [...prev, incoming]
      }
      const existing = prev[index]
      const existingTerminal = isJobTerminal(existing.status)
      if (existingTerminal && !isJobTerminal(incoming.status)) {
        // 终态一次：忽略迟到的非终态响应
        return prev
      }
      if (isJobTerminal(incoming.status)) {
        terminalLockedRef.current.add(incoming.job_id)
      }
      const next = [...prev]
      next[index] = incoming
      return next
    })
  }, [])

  /** purge 落地：移卡 + 剪 localStorage + 清锁集合 + 记墓碑。 */
  const finalizePurge = useCallback((pid: string, jobId: string) => {
    if (projectIdRef.current !== pid) return
    removedIdsRef.current.add(jobId)
    terminalLockedRef.current.delete(jobId)
    knownIdsRef.current.delete(jobId)
    enrichedIdsRef.current.delete(jobId)
    purgeTimersRef.current.delete(jobId)
    setJobs((prev) => prev.filter((j) => j.job_id !== jobId))
    removeStoredJobId(pid, jobId)
  }, [])

  /** purge 确认：404#1 后延时回源一次；404#2 落定，非 404 中止恢复。 */
  const schedulePurgeConfirm = useCallback((pid: string, jobId: string) => {
    if (purgeTimersRef.current.has(jobId)) return
    const timer = setTimeout(() => {
      purgeTimersRef.current.delete(jobId)
      if (projectIdRef.current !== pid) return
      getJob(pid, jobId)
        .then((job) => {
          if (projectIdRef.current !== pid) return
          // 证活：中止 purge、恢复登记轮询（不写墓碑）
          knownIdsRef.current.add(jobId)
          mergeJob(job)
        })
        .catch((err: unknown) => {
          if (projectIdRef.current !== pid) return
          if (isAxiosError(err) && err.response?.status === 404) {
            finalizePurge(pid, jobId)
            return
          }
          // M-B：瞬时错误（5xx/网络）不误判 purge——恢复轮询自愈
          knownIdsRef.current.add(jobId)
        })
    }, PURGE_CONFIRM_DELAY_MS)
    purgeTimersRef.current.set(jobId, timer)
  }, [finalizePurge, mergeJob])

  /**
   * 单 Job 安全回源：成功 merge；404（Job 已 purge）→ 摘轮询 + 延时确认；
   * 其他错误保留上轮快照。项目已切换时丢弃响应。墓碑 id 不发请求。
   */
  const getJobSafe = useCallback(async (jobId: string): Promise<ResearchJob | null> => {
    if (removedIdsRef.current.has(jobId)) return null
    const pid = projectId
    try {
      const job = await getJob(pid, jobId)
      if (projectIdRef.current !== pid) return job
      mergeJob(job)
      return job
    } catch (err) {
      if (
        isAxiosError(err)
        && err.response?.status === 404
        && projectIdRef.current === pid
      ) {
        knownIdsRef.current.delete(jobId)
        schedulePurgeConfirm(pid, jobId)
      }
      return null
    }
  }, [mergeJob, projectId, schedulePurgeConfirm])

  /** 把一批服务端列表行并入（权威证活 → 清墓碑 → merge）。 */
  const mergeServerPage = useCallback((items: readonly ResearchJob[]) => {
    for (const item of items) {
      removedIdsRef.current.delete(item.job_id)
      knownIdsRef.current.add(item.job_id)
      mergeJob(item)
    }
  }, [mergeJob])

  /** 权威对账：全量成功后在 state 中剔除“不在服务端集且不在 localStorage 集”的残留。 */
  const reconcileState = useCallback((pid: string, serverIds: Set<string>) => {
    const stored = new Set(readStoredJobIds(pid))
    setJobs((prev) => {
      const dropped = prev.filter(
        (j) => !serverIds.has(j.job_id) && !stored.has(j.job_id),
      )
      if (dropped.length === 0) return prev
      for (const job of dropped) {
        // 服务端/本地都不存在 → 视同 purge：墓碑防迟到响应复活
        removedIdsRef.current.add(job.job_id)
        terminalLockedRef.current.delete(job.job_id)
        knownIdsRef.current.delete(job.job_id)
        enrichedIdsRef.current.delete(job.job_id)
      }
      return prev.filter((j) => serverIds.has(j.job_id) || stored.has(j.job_id))
    })
  }, [])

  /**
   * 全量枚举（mount / Activity open / retry）。单飞；逐页流式 merge；
   * 每页 await 后重查项目（切换即中止）；重复 cursor 守卫 + 页数上限。
   */
  const refreshFull = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    const pid = projectId
    const serverIds = new Set<string>()
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let pages = 0
    let truncated = false
    try {
      do {
        if (projectIdRef.current !== pid) return
        const page = await listJobs(
          pid,
          cursor === undefined ? { limit: LIST_FETCH_LIMIT } : { limit: LIST_FETCH_LIMIT, cursor },
        )
        if (projectIdRef.current !== pid) return
        for (const item of page.items) serverIds.add(item.job_id)
        mergeServerPage(page.items)
        pages += 1
        const next = page.next_cursor ?? undefined
        if (next !== undefined) {
          if (seenCursors.has(next) || next === cursor) {
            // 畸形响应：防死循环，按失败处理
            throw new Error('research jobs list returned a repeated cursor')
          }
          seenCursors.add(next)
        }
        cursor = next
        if (pages >= MAX_JOB_LIST_PAGES) {
          // 截断：只记录不续拉；此时服务端集合不完整，跳过权威对账，
          // 避免把页上限之后的活 job 误判为残留
          truncated = cursor !== undefined
          cursor = undefined
        }
      } while (cursor !== undefined)
      if (!truncated) reconcileState(pid, serverIds)
      setListError(null)
      setListStatus('ready')
    } catch (err) {
      if (projectIdRef.current === pid) {
        setListError(err instanceof Error ? err.message : String(err))
        setListStatus('error')
      }
    } finally {
      // 项目切换时新项目 effect 已复位 refreshingRef；旧飞行不得覆盖
      if (projectIdRef.current === pid) {
        refreshingRef.current = false
      }
    }
  }, [mergeServerPage, projectId, reconcileState])

  /** 第一页刷新（focus / 创建登记后；静默失败，保留现状）。 */
  const refreshPage1 = useCallback(async (): Promise<void> => {
    const pid = projectId
    try {
      const page = await listJobs(pid, { limit: LIST_FETCH_LIMIT })
      if (projectIdRef.current !== pid) return
      mergeServerPage(page.items)
      setListStatus((prev) => (prev === 'error' ? 'ready' : prev))
      setListError(null)
    } catch {
      // 静默回退：列表端点失败（旧后端 404/网络）不影响 localStorage 恢复
    }
  }, [mergeServerPage, projectId])

  const retryList = useCallback(() => {
    setListStatus('loading')
    void refreshFull()
  }, [refreshFull])

  /** Activity Dialog open → 全量刷新（对账 + 富化宿主）。 */
  const refreshActivity = useCallback(() => {
    void refreshFull()
  }, [refreshFull])

  /** coverage 富化：对指定可见 job 回源详情（去重，成功后才记 enriched）。 */
  const ensureCoverageDetails = useCallback((jobIds: readonly string[]) => {
    for (const jobId of jobIds) {
      if (enrichedIdsRef.current.has(jobId)) continue
      if (removedIdsRef.current.has(jobId)) continue
      void getJobSafe(jobId).then((job) => {
        if (job !== null) enrichedIdsRef.current.add(jobId)
      })
    }
  }, [getJobSafe])

  useEffect(() => {
    if (!projectId) return undefined
    projectIdRef.current = projectId
    // 项目切换：清空视图状态与全部会话内集合（旧项目不得残留）。
    // purge timer Map 对象在本 effect 生命周期内保持同一引用（只 clear
    // 不复引用），局部副本供清理函数安全使用。
    const purgeTimers = purgeTimersRef.current
    for (const timer of purgeTimers.values()) clearTimeout(timer)
    purgeTimers.clear()
    removedIdsRef.current = new Set()
    enrichedIdsRef.current = new Set()
    refreshingRef.current = false
    lastFocusPage1AtRef.current = 0
    terminalLockedRef.current = new Set()
    knownIdsRef.current = new Set(readStoredJobIds(projectId))
    setJobs([])
    setListError(null)
    setListStatus('loading')
    setActionError(null)

    // 服务端全量列表 ∪ localStorage 并集（Issue #311 / RWV2-41）
    void refreshFull()

    // 恢复查看：localStorage 逐 job_id 回源（REQ-JOB-02；兜底旧后端与
    // 超出列表第一页的 id）
    for (const jobId of [...knownIdsRef.current]) {
      void getJobSafe(jobId)
    }

    const timer = setInterval(() => {
      for (const jobId of knownIdsRef.current) {
        if (terminalLockedRef.current.has(jobId)) continue
        if (removedIdsRef.current.has(jobId)) continue
        void getJobSafe(jobId)
      }
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(timer)
      for (const purgeTimer of purgeTimers.values()) clearTimeout(purgeTimer)
      purgeTimers.clear()
    }
  }, [getJobSafe, projectId, refreshFull])

  // Issue #311/#46：窗口重新聚焦 → 第一页刷新（30s 冷却；跨设备新任务
  // 必在最新端，page-1 足够；已知活动任务由轮询集合持续覆盖）
  useEffect(() => {
    if (!projectId) return undefined
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusPage1AtRef.current < FOCUS_LIST_REFRESH_COOLDOWN_MS) return
      lastFocusPage1AtRef.current = now
      void refreshPage1()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectId, refreshPage1])

  const createCompareJob = useCallback((
    documentIds: readonly string[],
    modelId: string,
    groupSize?: number,
  ): ResearchJob | null => {
    setError(null)
    setErrorCode(null)
    const check = checkCompareSelection(documentIds)
    if (!check.ok) {
      if (check.reason === 'over_hard') {
        setError(`Cannot compare more than ${COMPARE_HARD_MAX} documents (selected ${check.count})`)
        setErrorCode('compare-over-hard')
      } else {
        setError('Select at least one source document to compare')
        setErrorCode('compare-empty')
      }
      return null
    }
    if (!modelId) {
      // fail-closed：无 confirmed 模型不创建（后端不隐式补值，不变量 2）
      setError('Select a research model before starting a comparison')
      setErrorCode('no-model')
      return null
    }
    setIsCreating(true)
    createCompare(projectId, {
      job_type: 'deep_compare', // 契约 §8.3 必填（RDLens JobCreateRequest）
      document_ids: [...documentIds],
      group_size: groupSize,
      mode: 'deep_compare',
      model_id: modelId,
    })
      .then(({ job_id }) => {
        knownIdsRef.current.add(job_id)
        writeStoredJobId(projectId, job_id)
        void getJobSafe(job_id)
        void refreshPage1()
      })
      .catch((err: Error) => {
        setError(err.message || '')
        setErrorCode(extractResearchErrorCode(err))
      })
      .finally(() => {
        setIsCreating(false)
      })
    return null
  }, [getJobSafe, projectId, refreshPage1])

  const cancel = useCallback((jobId: string) => {
    setError(null)
    setErrorCode(null)
    setActionError(null)
    const existing = jobs.find((j) => j.job_id === jobId)
    if (!existing || !canCancelJob(existing.status)) {
      // completed → cancel 为 409 语义；本地不静默
      const message = 'This job is already finished and cannot be cancelled'
      setError(message)
      setActionError(message)
      return
    }
    // 乐观展示 cancelling；真实状态以下一轮 GET 为准
    mergeJob({ ...existing, status: 'cancelling' })
    cancelJob(projectId, jobId)
      .then(() => getJobSafe(jobId))
      .catch((err: Error) => {
        const message = err.message || 'job.cancelFailed'
        setError(message)
        setActionError(message)
        // 恢复服务端状态
        getJobSafe(jobId)
      })
  }, [getJobSafe, jobs, mergeJob, projectId])

  // COV-09：登记 all_selected 受理的 Job（Chat 侧创建；Activity 可见 + 轮询）
  const registerCoverageJob = useCallback((jobId: string) => {
    knownIdsRef.current.add(jobId)
    writeStoredJobId(projectId, jobId)
    void getJobSafe(jobId)
    void refreshPage1()
  }, [getJobSafe, projectId, refreshPage1])

  // COV-09：outcome_unknown 显式人工重试（§12.2）——新幂等键 + 确认计费
  // 风险；不得复用旧唯一键静默发送（复用 → 服务端 409）。
  const retryCoverage = useCallback(async (jobId: string): Promise<boolean> => {
    setError(null)
    setErrorCode(null)
    setActionError(null)
    try {
      await retryCoverageJob(projectId, jobId, newIdempotencyKey())
      registerCoverageJob(jobId)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setActionError(message)
      return false
    }
  }, [projectId, registerCoverageJob])

  return {
    jobs,
    isCreating,
    error,
    errorCode,
    actionError,
    clearActionError: () => setActionError(null),
    listStatus,
    listError,
    retryList,
    refreshActivity,
    ensureCoverageDetails,
    createCompare: createCompareJob,
    cancel,
    registerCoverageJob,
    retryCoverage,
  }
}
