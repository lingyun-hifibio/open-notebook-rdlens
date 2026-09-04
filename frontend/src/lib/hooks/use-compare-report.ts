'use client'

/**
 * #307：deep_compare Job 最终报告一次性读取。
 *
 * 与 coverage 报告共用 GET /jobs/{id}/report 端点（后端按 job_type
 * 分支返回 compare 形态：正文 + citations，无 coverage 专属字段）。
 * 只在 ``enabled``（Job completed 且 result_ref 已产出）时发起一次
 * 请求；409 ``report_unavailable`` 等失败以 error 呈现，不静默重试。
 */

import {
  useCoverageReport,
  type UseCoverageReportState,
} from './use-coverage-report'
import { getCompareReport } from '@/lib/research/api'
import type { ResearchCompareReportResponse } from '@/lib/research/types'

export type { UseCoverageReportState as UseCompareReportState }

export function useCompareReport(
  projectId: string,
  jobId: string | null,
  enabled: boolean,
): { report: ResearchCompareReportResponse | null; error: string | null; loading: boolean } {
  const state = useCoverageReport(projectId, jobId, enabled, getCompareReport)
  return {
    report: state.report,
    error: state.error,
    loading: state.loading,
  }
}
