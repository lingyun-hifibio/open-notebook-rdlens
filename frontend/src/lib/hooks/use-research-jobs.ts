'use client'

/**
 * Research 持久 Job 交互状态机（UI-03，契约 v0 §8.3/§10；REQ-JOB-02）。
 *
 * - Job 是服务端持久实体；本地只缓存最近一次 GET 快照 + job_id 集合。
 *   `localStorage` 仅存 job_id（浏览器关闭后恢复查看），**状态永远以
 *   服务端 GET 为准**——本地组件状态不是持久 Job 状态（任务卡验收）。
 * - Issue #311：服务端列表恢复——mount 时拉 `GET .../jobs` 第一页
 *   （limit=100 服务端上限，防老的非终态任务掉出默认页）∪ localStorage
 *   job_id 并集，逐个回源；列表失败静默回退 localStorage（旧后端/离线
 *   兼容，双端部署顺序无关）。
 * - 轮询非终态 Job（间隔 POLL_INTERVAL_MS）；终态一次：已观察到终态后，
 *   迟到的非终态响应不回归卡片。GET 404（job 已随项目 purge）→ 从轮询
 *   集合摘除，不做永久空轮询。
 * - 取消必须显式（POST /jobs/{id}/cancel；契约 §10.3）：queued/running →
 *   cancelling → cancelled；已终态取消即报错（completed → 409 语义），
 *   本地不做静默处理。
 * - Compare 创建前置校验（REQ-QUOTA-01）：51 篇 → 拒绝且不发请求
 *   （服务端 422 的前置客户端校验）。
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
import type { ResearchJob } from '@/lib/research/types'

export const POLL_INTERVAL_MS = 3000

const STORAGE_PREFIX = 'rdlens.research.jobs.'

/** Issue #311：列表恢复拉满服务端单页上限（limit 合法域 1..100）。 */
const LIST_FETCH_LIMIT = 100

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

export interface UseResearchJobsResult {
  jobs: ResearchJob[]
  isCreating: boolean
  error: string | null
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
   * 已知集合（localStorage + 立即回源）——Chat 创建的任务在 Jobs 页可见、
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
  const terminalLockedRef = useRef<Set<string>>(new Set())
  const knownIdsRef = useRef<Set<string>>(new Set())
  // Issue #311：项目切换守卫——在途 listJobs/getJob 响应返回时若项目已
  // 切换则丢弃，防止旧项目任务卡污染新项目视图（并在轮询中跨项目 404）。
  const projectIdRef = useRef<string>(projectId)

  /** 合并一次服务端快照；终态一次（非终态响应不得回归已终态卡片） */
  const mergeJob = useCallback((incoming: ResearchJob) => {
    setJobs((prev) => {
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

  /**
   * 单 Job 安全回源：成功 merge；404（Job 已 purge）→ 从轮询集合摘除；
   * 其他错误保留上轮快照。项目已切换时丢弃响应（不 merge、不摘除）。
   */
  const getJobSafe = useCallback(async (jobId: string): Promise<ResearchJob | null> => {
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
      }
      return null
    }
  }, [mergeJob, projectId])

  /**
   * Issue #311：服务端列表刷新（mount / window focus / 创建登记后）。
   * 失败静默回退 localStorage——不 setError、不阻塞工作区。
   */
  const refreshList = useCallback(async () => {
    const pid = projectId
    try {
      const page = await listJobs(pid, { limit: LIST_FETCH_LIMIT })
      if (projectIdRef.current !== pid) return
      for (const item of page.items) {
        knownIdsRef.current.add(item.job_id)
        mergeJob(item)
      }
    } catch {
      // 静默回退：列表端点失败（旧后端 404/网络）不影响 localStorage 恢复
    }
  }, [mergeJob, projectId])

  useEffect(() => {
    if (!projectId) return undefined
    projectIdRef.current = projectId
    // 项目切换：清空视图状态（旧项目卡片不得残留到新项目）
    setJobs([])
    terminalLockedRef.current = new Set()
    knownIdsRef.current = new Set(readStoredJobIds(projectId))

    // 服务端列表第一页 ∪ localStorage 并集（Issue #311）
    void refreshList()

    // 恢复查看：localStorage 逐 job_id 回源（REQ-JOB-02；兜底旧后端与
    // 超出列表第一页的 id）
    for (const jobId of knownIdsRef.current) {
      void getJobSafe(jobId)
    }

    const timer = setInterval(() => {
      for (const jobId of knownIdsRef.current) {
        if (terminalLockedRef.current.has(jobId)) continue
        void getJobSafe(jobId)
      }
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(timer)
    }
  }, [getJobSafe, refreshList, projectId])

  // Issue #311：窗口重新聚焦 → 刷新服务端列表（跨设备新任务可见）
  useEffect(() => {
    if (!projectId) return undefined
    const onFocus = () => {
      void refreshList()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshList, projectId])

  const createCompareJob = useCallback((
    documentIds: readonly string[],
    modelId: string,
    groupSize?: number,
  ): ResearchJob | null => {
    setError(null)
    const check = checkCompareSelection(documentIds)
    if (!check.ok) {
      if (check.reason === 'over_hard') {
        setError(`Cannot compare more than ${COMPARE_HARD_MAX} documents (selected ${check.count})`)
      } else {
        setError('Select at least one source document to compare')
      }
      return null
    }
    if (!modelId) {
      // fail-closed：无 confirmed 模型不创建（后端不隐式补值，不变量 2）
      setError('Select a research model before starting a comparison')
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
        void refreshList()
      })
      .catch((err: Error) => {
        setError(err.message || 'compare.createFailed')
      })
      .finally(() => {
        setIsCreating(false)
      })
    return null
  }, [getJobSafe, projectId, refreshList])

  const cancel = useCallback((jobId: string) => {
    setError(null)
    const existing = jobs.find((j) => j.job_id === jobId)
    if (!existing || !canCancelJob(existing.status)) {
      // completed → cancel 为 409 语义；本地不静默
      setError('This job is already finished and cannot be cancelled')
      return
    }
    // 乐观展示 cancelling；真实状态以下一轮 GET 为准
    mergeJob({ ...existing, status: 'cancelling' })
    cancelJob(projectId, jobId)
      .then(() => getJobSafe(jobId))
      .catch((err: Error) => {
        setError(err.message || 'job.cancelFailed')
        // 恢复服务端状态
        getJobSafe(jobId)
      })
  }, [getJobSafe, jobs, mergeJob, projectId])

  // COV-09：登记 all_selected 受理的 Job（Chat 侧创建；Jobs 页可见 + 轮询）
  const registerCoverageJob = useCallback((jobId: string) => {
    knownIdsRef.current.add(jobId)
    writeStoredJobId(projectId, jobId)
    void getJobSafe(jobId)
    void refreshList()
  }, [getJobSafe, projectId, refreshList])

  // COV-09：outcome_unknown 显式人工重试（§12.2）——新幂等键 + 确认计费
  // 风险；不得复用旧唯一键静默发送（复用 → 服务端 409）。
  const retryCoverage = useCallback(async (jobId: string): Promise<boolean> => {
    setError(null)
    try {
      await retryCoverageJob(projectId, jobId, newIdempotencyKey())
      registerCoverageJob(jobId)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [projectId, registerCoverageJob])

  return {
    jobs,
    isCreating,
    error,
    createCompare: createCompareJob,
    cancel,
    registerCoverageJob,
    retryCoverage,
  }
}
