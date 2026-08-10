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
