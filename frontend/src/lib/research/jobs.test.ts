import { describe, expect, it } from 'vitest'
import {
  canCancelJob,
  countActiveJobs,
  isJobTerminal,
  jobProgressPercent,
  jobStatusLabelKey,
  jobTypeLabelKey,
  JOB_TERMINAL_STATUSES,
  partitionAndSortJobs,
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

describe('RWV2-41 activity helpers', () => {
  function j(overrides: Partial<ResearchJob>): ResearchJob {
    return { ...job('running'), ...overrides }
  }

  it('countActiveJobs 只计非终态（queued/running/cancelling；终态不计）', () => {
    const jobs = [
      j({ job_id: 'a', status: 'queued' }),
      j({ job_id: 'b', status: 'running' }),
      // cancelling 是向终态收敛的过渡但仍属进行中 → 计入徽标
      j({ job_id: 'c', status: 'cancelling' }),
      j({ job_id: 'd', status: 'cancelled' }),
      j({ job_id: 'e', status: 'completed' }),
      j({ job_id: 'f', status: 'failed' }),
    ]
    expect(countActiveJobs(jobs)).toBe(3)
    expect(countActiveJobs([])).toBe(0)
    expect(countActiveJobs(jobs.filter((x) => x.status === 'completed'))).toBe(0)
  })

  it('partitionAndSortJobs 分组稳定：Active=非终态、History=终态，均 created_at DESC/job_id DESC', () => {
    const jobs = [
      j({ job_id: 'old_done', status: 'completed', created_at: '2026-08-01T00:00:00Z' }),
      j({ job_id: 'new_run', status: 'running', created_at: '2026-08-03T00:00:00Z' }),
      j({ job_id: 'mid_queued', status: 'queued', created_at: '2026-08-02T00:00:00Z' }),
      j({ job_id: 'newest_fail', status: 'failed', created_at: '2026-08-04T00:00:00Z' }),
      // created_at 相同 → job_id DESC 决胜
      j({ job_id: 'b_tie', status: 'cancelled', created_at: '2026-08-05T00:00:00Z' }),
      j({ job_id: 'a_tie', status: 'cancelled', created_at: '2026-08-05T00:00:00Z' }),
    ]
    const { active, history } = partitionAndSortJobs(jobs)
    expect(active.map((x) => x.job_id)).toEqual(['new_run', 'mid_queued'])
    expect(history.map((x) => x.job_id)).toEqual(['b_tie', 'a_tie', 'newest_fail', 'old_done'])
  })

  it('jobStatusLabelKey 六态映射到任务导向英文 key', () => {
    expect(jobStatusLabelKey('queued')).toBe('research.activity.state.queued')
    expect(jobStatusLabelKey('running')).toBe('research.activity.state.running')
    expect(jobStatusLabelKey('cancelling')).toBe('research.activity.state.cancelling')
    expect(jobStatusLabelKey('cancelled')).toBe('research.activity.state.cancelled')
    expect(jobStatusLabelKey('completed')).toBe('research.activity.state.completed')
    expect(jobStatusLabelKey('failed')).toBe('research.activity.state.failed')
  })

  it('jobTypeLabelKey 已知类型映射 key；未知类型回退 raw job_type', () => {
    expect(jobTypeLabelKey('deep_compare')).toBe('research.activity.type.deepCompare')
    expect(jobTypeLabelKey('research_coverage')).toBe('research.activity.type.coverage')
    expect(jobTypeLabelKey('research_long')).toBe('research.activity.type.longResearch')
    expect(jobTypeLabelKey('research_extra_long')).toBe('research.activity.type.extraLongResearch')
    expect(jobTypeLabelKey('some_future_type')).toBe('some_future_type')
  })
})
