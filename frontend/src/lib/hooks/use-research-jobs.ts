'use client'

/**
 * Research 持久 Job 交互状态机（UI-03，契约 v0 §8.3/§10；REQ-JOB-02）。
 *
 * - Job 是服务端持久实体；本地只缓存最近一次 GET 快照 + job_id 集合。
 *   `localStorage` 仅存 job_id（浏览器关闭后恢复查看），**状态永远以
 *   服务端 GET 为准**——本地组件状态不是持久 Job 状态（任务卡验收）。
 * - 轮询非终态 Job（间隔 POLL_INTERVAL_MS）；终态一次：已观察到终态后，
 *   迟到的非终态响应不回归卡片。
 * - 取消必须显式（POST /jobs/{id}/cancel；契约 §10.3）：queued/running →
 *   cancelling → cancelled；已终态取消即报错（completed → 409 语义），
 *   本地不做静默处理。
 * - Compare 创建前置校验（REQ-QUOTA-01）：51 篇 → 拒绝且不发请求
 *   （服务端 422 的前置客户端校验）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelJob,
  createCompare,
  getJob,
} from '@/lib/research/api'
import { canCancelJob, isJobTerminal } from '@/lib/research/jobs'
import { checkCompareSelection, COMPARE_HARD_MAX } from '@/lib/research/compare'
import type { ResearchJob } from '@/lib/research/types'

export const POLL_INTERVAL_MS = 3000

const STORAGE_PREFIX = 'rdlens.research.jobs.'

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
  /** 返回 null 表示前置校验拒绝（未发请求） */
  createCompare: (documentIds: readonly string[], groupSize?: number) => ResearchJob | null
  cancel: (jobId: string) => void
}

export function useResearchJobs({ projectId }: { projectId: string }): UseResearchJobsResult {
  const [jobs, setJobs] = useState<ResearchJob[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const terminalLockedRef = useRef<Set<string>>(new Set())
  const knownIdsRef = useRef<Set<string>>(new Set())

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

  const fetchJob = useCallback(async (jobId: string) => {
    const job = await getJob(projectId, jobId)
    mergeJob(job)
    return job
  }, [mergeJob, projectId])

  useEffect(() => {
    if (!projectId) return undefined
    let cancelled = false
    knownIdsRef.current = new Set(readStoredJobIds(projectId))

    // 恢复查看：重新打开后按 job_id 回源（REQ-JOB-02）
    for (const jobId of knownIdsRef.current) {
      getJob(projectId, jobId)
        .then((job) => {
          if (!cancelled) mergeJob(job)
        })
        .catch(() => {
          // 单 job 恢复失败不阻塞工作区
        })
    }

    const timer = setInterval(() => {
      for (const jobId of knownIdsRef.current) {
        if (terminalLockedRef.current.has(jobId)) continue
        getJob(projectId, jobId)
          .then((job) => {
            if (!cancelled) mergeJob(job)
          })
          .catch(() => {
            // 轮询失败保留上次快照，下一轮再试
          })
      }
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mergeJob, projectId])

  const createCompareJob = useCallback((documentIds: readonly string[], groupSize?: number): ResearchJob | null => {
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
    setIsCreating(true)
    createCompare(projectId, {
      document_ids: [...documentIds],
      group_size: groupSize,
      mode: 'deep_compare',
    })
      .then(({ job_id }) => {
        knownIdsRef.current.add(job_id)
        writeStoredJobId(projectId, job_id)
        return fetchJob(job_id)
      })
      .catch((err: Error) => {
        setError(err.message || 'compare.createFailed')
      })
      .finally(() => {
        setIsCreating(false)
      })
    return null
  }, [fetchJob, projectId])

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
      .then(() => fetchJob(jobId))
      .catch((err: Error) => {
        setError(err.message || 'job.cancelFailed')
        // 恢复服务端状态
        fetchJob(jobId).catch(() => {})
      })
  }, [fetchJob, jobs, mergeJob, projectId])

  return { jobs, isCreating, error, createCompare: createCompareJob, cancel }
}
