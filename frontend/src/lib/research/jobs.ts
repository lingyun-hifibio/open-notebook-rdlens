/**
 * Job 状态机纯函数（UI-03，契约 v0 §10）。
 *
 * 状态机：queued → running → completed；queued/running → cancelling →
 * cancelled；failed → queued（管理员/策略显式重试，非自动回退）。
 * 终态不可逆；取消仅 queued/running 允许（completed → cancel 为 409）。
 */

import type { ResearchJob, ResearchJobStatus } from './types'

export const JOB_TERMINAL_STATUSES: readonly ResearchJobStatus[] = ['cancelled', 'completed', 'failed']

export function isJobTerminal(status: ResearchJobStatus): boolean {
  return (JOB_TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** 协作取消：仅 queued/running 可取消（契约 §10.3） */
export function canCancelJob(status: ResearchJobStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** progress（0..1）→ 0..100，夹取边界 */
export function jobProgressPercent(job: ResearchJob): number {
  const value = Math.round(job.progress * 100)
  return Math.min(100, Math.max(0, value))
}

/**
 * RWV2-41（Fork #46）：Activity Center 非终态计数。
 *
 * 徽标只计非终态（queued/running/cancelling）——cancelling 是向终态收敛
 * 的过渡但仍属“进行中”，计入徽标；它不可再点取消（canCancelJob 仍只
 * 允许 queued/running）。cancelled/completed/failed 不计。
 */
export function countActiveJobs(jobs: readonly ResearchJob[]): number {
  return jobs.reduce((count, job) => (isJobTerminal(job.status) ? count : count + 1), 0)
}

/**
 * RWV2-41（Fork #46）：按展示语义排序并分组。
 *
 * 服务端 keyset 为 created_at DESC, job_id DESC；本地合并（localStorage
 * 回源/轮询）可能乱序，展示前统一排序。分组：Active = 非终态，
 * History = 终态（可达但不计徽标）。
 */
export function partitionAndSortJobs(
  jobs: readonly ResearchJob[],
): { active: ResearchJob[]; history: ResearchJob[] } {
  const byNewestFirst = (a: ResearchJob, b: ResearchJob): number => {
    const timeCompare = b.created_at.localeCompare(a.created_at)
    if (timeCompare !== 0) return timeCompare
    return b.job_id.localeCompare(a.job_id)
  }
  const active: ResearchJob[] = []
  const history: ResearchJob[] = []
  for (const job of jobs) {
    (isJobTerminal(job.status) ? history : active).push(job)
  }
  active.sort(byNewestFirst)
  history.sort(byNewestFirst)
  return { active, history }
}

/** Job 状态 → i18n key（任务导向英文文案；RWV2-41 AC3）。 */
export function jobStatusLabelKey(status: ResearchJobStatus): string {
  const keys: Record<ResearchJobStatus, string> = {
    queued: 'research.activity.state.queued',
    running: 'research.activity.state.running',
    cancelling: 'research.activity.state.cancelling',
    cancelled: 'research.activity.state.cancelled',
    completed: 'research.activity.state.completed',
    failed: 'research.activity.state.failed',
  }
  return keys[status]
}

/** Job 类型 → i18n key；未知类型回退 raw job_type（不做硬编码枚举猜测）。 */
export function jobTypeLabelKey(jobType: string): string {
  const keys: Record<string, string> = {
    deep_compare: 'research.activity.type.deepCompare',
    research_coverage: 'research.activity.type.coverage',
    research_long: 'research.activity.type.longResearch',
    research_extra_long: 'research.activity.type.extraLongResearch',
  }
  return keys[jobType] ?? jobType
}
