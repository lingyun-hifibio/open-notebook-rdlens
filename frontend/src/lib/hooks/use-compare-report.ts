'use client'

/**
 * #307：deep_compare Job 最终报告一次性读取。
 *
 * 与 coverage 报告共用 GET /jobs/{id}/report 端点（后端按 job_type
 * 分支返回 compare 形态：正文 + citations，无 coverage 专属字段）。
 * 只在 ``enabled``（Job completed 且 result_ref 已产出）时发起一次
 * 请求；失败**不静默重试**，按状态码落成可区分终态：
 *
 * - `restricted`（#1017）：HTTP 410
 *   `compare_report_sources_revoked` / `compare_report_sources_unverifiable`
 *   —— 现行权限判定拒绝（#1018 PR #1193 已合入）。此时 `report` 必须为
 *   `null`：**不得展示任何缓存/旧正文或引用**，只渲染受限占位；
 * - `retryable`：HTTP 503（authority/存储临时不可用，fail-closed）——
 *   显示可重试入口，重试发起新请求；
 * - `unavailable`：其余失败（409 `report_unavailable`、网络错误等）——
 *   既有错误文案呈现。
 *
 * 每次请求开始即清空 `report`（不保留陈旧正文），因此 410 之后即使同一
 * Job 之前读过成功报告也不会继续展示旧内容；`report` 只由本次成功响应
 * 赋值。
 */

import { useCallback, useEffect, useState } from 'react'
import { isAxiosError } from 'axios'
import { getCompareReport } from '@/lib/research/api'
import { extractResearchErrorCode } from '@/lib/research/errors'
import type { ResearchCompareReportResponse } from '@/lib/research/types'

/** 回访失败的可区分终态（计划 §2.9/§2.11）。 */
export type CompareReportFailureKind = 'restricted' | 'retryable' | 'unavailable'

export interface UseCompareReportState {
  report: ResearchCompareReportResponse | null
  error: string | null
  /** HTTP `detail.code`（有则用于受限占位的精确文案映射） */
  errorCode: string | null
  failureKind: CompareReportFailureKind | null
  loading: boolean
}

/** compare report 的受限稳定码（410；不返回正文/引用）。 */
export const COMPARE_REPORT_RESTRICTED_CODES = [
  'compare_report_sources_revoked',
  'compare_report_sources_unverifiable',
] as const

const RESTRICTED_CODE_SET: ReadonlySet<string> = new Set(COMPARE_REPORT_RESTRICTED_CODES)

function classifyFailure(err: unknown): {
  kind: CompareReportFailureKind
  code: string | null
  message: string
} {
  const code = extractResearchErrorCode(err)
  const status = isAxiosError(err) ? err.response?.status : undefined
  const message = err instanceof Error ? err.message : String(err)
  if (status === 410 || (code !== null && RESTRICTED_CODE_SET.has(code))) {
    return { kind: 'restricted', code, message }
  }
  if (status === 503) return { kind: 'retryable', code, message }
  return { kind: 'unavailable', code, message }
}

export function useCompareReport(
  projectId: string,
  jobId: string | null,
  enabled: boolean,
): UseCompareReportState & { retry: () => void } {
  const [state, setState] = useState<UseCompareReportState>({
    report: null,
    error: null,
    errorCode: null,
    failureKind: null,
    loading: false,
  })
  // 503 可重试：显式递增触发一次新请求（不做自动重试，保持 fork 无客户端
  // 自动重试的既有纪律）。
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    if (!enabled || !jobId || !projectId) {
      setState({
        report: null,
        error: null,
        errorCode: null,
        failureKind: null,
        loading: false,
      })
      return
    }
    let cancelled = false
    setState({
      report: null,
      error: null,
      errorCode: null,
      failureKind: null,
      loading: true,
    })
    getCompareReport(projectId, jobId)
      .then((report) => {
        if (!cancelled) {
          setState({
            report,
            error: null,
            errorCode: null,
            failureKind: null,
            loading: false,
          })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const failure = classifyFailure(err)
        // 失败即丢弃正文：410/503/409 都不得展示上一次成功拉取的报告。
        setState({
          report: null,
          error: failure.message,
          errorCode: failure.code,
          failureKind: failure.kind,
          loading: false,
        })
      })
    return () => {
      cancelled = true
    }
  }, [attempt, enabled, jobId, projectId])

  return { ...state, retry }
}
