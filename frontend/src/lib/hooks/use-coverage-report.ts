'use client'

/**
 * COV-09：最终报告一次性读取（COV-08 §12.1 GET /jobs/{id}/report）。
 *
 * 只在 ``enabled``（Job completed 且 render_report 已产出报告）时发起
 * 一次请求；409 ``coverage_report_unavailable`` 等失败以 error 呈现，
 * 不静默重试（报告内容由服务端确定性渲染，读取失败属于服务端状态）。
 */

import { useEffect, useState } from 'react'
import { getCoverageReport } from '@/lib/research/api'
import type { ResearchCoverageReportResponse } from '@/lib/research/types'

export interface UseCoverageReportState {
  report: ResearchCoverageReportResponse | null
  error: string | null
  loading: boolean
}

export function useCoverageReport(
  projectId: string,
  jobId: string | null,
  enabled: boolean,
  /** #307：可注入同端点分支 fetcher（compare 报告复用同一读取时序） */
  fetcher: (
    projectId: string,
    jobId: string,
  ) => Promise<ResearchCoverageReportResponse> = getCoverageReport,
): UseCoverageReportState {
  const [state, setState] = useState<UseCoverageReportState>({
    report: null,
    error: null,
    loading: false,
  })

  useEffect(() => {
    if (!enabled || !jobId || !projectId) {
      setState({ report: null, error: null, loading: false })
      return
    }
    let cancelled = false
    setState({ report: null, error: null, loading: true })
    fetcher(projectId, jobId)
      .then((report) => {
        if (!cancelled) setState({ report, error: null, loading: false })
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setState({ report: null, error: err.message || 'Report unavailable', loading: false })
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled, jobId, projectId])

  return state
}
