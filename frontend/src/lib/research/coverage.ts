/**
 * Coverage Job 状态纯函数（COV-09，契约 §6.3/§6.4/§12.2）。
 *
 * - ``target_coverage`` 计数由服务端从 target_results 推导，本模块只做
 *   展示层归并与防御性回退，不参与业务计算；
 * - outcome_unknown 是「可能已产生费用、禁止自动重发」的稳定表达，
 *   UI 必须给出人工提示与显式重试入口（§12.2）。
 */

import type { ResearchCoverageJobView, ResearchJob } from './types'

/** Job failed 且关联 Generation outcome_unknown → 需要显式人工重试 */
export function isCoverageOutcomeUnknown(job: ResearchJob): boolean {
  const generation = job.coverage?.generation
  return job.status === 'failed' && generation?.state === 'outcome_unknown'
}

/** completed 且 render_report 已产出报告 Artifact → 报告可读 */
export function isCoverageReportAvailable(job: ResearchJob): boolean {
  return job.status === 'completed' && Boolean(job.coverage?.report_ref)
}

export interface CoverageTargetCounts {
  requested: number
  analyzed: number
  failed: number
  status: 'complete' | 'partial' | 'failed'
}

/** 目标覆盖计数：优先服务端权威值；缺失时从 target_results 防御性推导。 */
export function targetCoverageCounts(
  job: ResearchJob,
): CoverageTargetCounts | null {
  const view = job.coverage
  if (!view) return null
  if (view.target_coverage) return view.target_coverage
  const results = view.target_results
  if (!results || results.length === 0) return null
  const analyzed = results.filter((result) => result.status === 'analyzed').length
  const failed = results.length - analyzed
  return {
    requested: results.length,
    analyzed,
    failed,
    status:
      analyzed === results.length ? 'complete' : analyzed === 0 ? 'failed' : 'partial',
  }
}

/** verification_status 三态透传；未校验 → null（不猜测） */
export function coverageVerificationStatus(
  view: ResearchCoverageJobView | undefined,
): 'verified' | 'critic_issues' | 'degraded' | null {
  return view?.verification_status ?? null
}
