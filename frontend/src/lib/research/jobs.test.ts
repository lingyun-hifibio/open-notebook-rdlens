import { describe, expect, it } from 'vitest'
import {
  canCancelJob,
  isJobTerminal,
  jobProgressPercent,
  JOB_TERMINAL_STATUSES,
} from './jobs'
import type { ResearchJob, ResearchJobStatus } from './types'

// UI-03 Red：Job 状态机纯函数（契约 v0 §10）——终态不可逆、取消仅
// queued/running 允许（completed → cancel 是 409 语义）、进度边界。

const ALL_STATUSES: ResearchJobStatus[] = ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed']

function job(status: ResearchJobStatus, progress = 0): ResearchJob {
  return {
    job_id: 'job_1',
    project_id: 'p1',
    job_type: 'deep_compare',
    status,
    stage: null,
    progress,
    model_id: null,
    generation_epoch: 1,
    retry_count: 0,
    last_error: null,
    result_ref: null,
    created_at: '2026-08-06T02:00:00Z',
    updated_at: '2026-08-06T02:00:00Z',
  }
}

describe('job state helpers', () => {
  it('终态集合为 cancelled/completed/failed', () => {
    expect(JOB_TERMINAL_STATUSES).toEqual(['cancelled', 'completed', 'failed'])
    for (const s of ALL_STATUSES) {
      expect(isJobTerminal(s)).toBe(
        s === 'cancelled' || s === 'completed' || s === 'failed',
      )
    }
  })

  it('只有 queued/running 允许取消（协作取消，契约 §10.3）', () => {
    expect(canCancelJob('queued')).toBe(true)
    expect(canCancelJob('running')).toBe(true)
    for (const s of ['cancelling', 'cancelled', 'completed', 'failed'] as ResearchJobStatus[]) {
      expect(canCancelJob(s)).toBe(false)
    }
  })

  it('进度归一为 0–100 百分比并夹取边界', () => {
    expect(jobProgressPercent(job('running', 0.4))).toBe(40)
    expect(jobProgressPercent(job('queued', 0))).toBe(0)
    expect(jobProgressPercent(job('completed', 1))).toBe(100)
    expect(jobProgressPercent(job('running', -0.5))).toBe(0)
    expect(jobProgressPercent(job('running', 1.5))).toBe(100)
  })

  it('failed 是终态但可重试（服务端 failed → queued 重试语义）', () => {
    expect(isJobTerminal('failed')).toBe(true)
  })
})
