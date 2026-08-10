import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ResearchJobList } from './ResearchJobList'
import type { ResearchJob } from '@/lib/research/types'

// UI-03 Red：Job 列表（契约 §10）——运行中显示进度并可显式取消；
// 终态（completed/cancelled/failed）无取消按钮；result_ref 只展示引用
// （正文不经 Job API 返回）。

function job(overrides: Partial<ResearchJob>): ResearchJob {
  return {
    job_id: 'job_1',
    project_id: 'p1',
    job_type: 'deep_compare',
    status: 'running',
    stage: 'group_evidence',
    progress: 0.4,
    model_id: 'qwen3.6-35b-a3b-fp8',
    generation_epoch: 7,
    retry_count: 0,
    last_error: null,
    result_ref: null,
    created_at: '2026-08-06T02:00:00Z',
    updated_at: '2026-08-06T02:00:00Z',
    ...overrides,
  }
}

describe('ResearchJobList', () => {
  afterEach(cleanup)

  it('运行中 Job 显示 stage/进度并可取消', () => {
    const onCancel = vi.fn()
    render(<ResearchJobList jobs={[job({})]} isCreating={false} onCancel={onCancel} />)
    expect(screen.getByText(/group_evidence/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledWith('job_1')
  })

  it('completed Job 展示 result_ref 引用且无取消按钮', () => {
    render(
      <ResearchJobList
        jobs={[job({ status: 'completed', progress: 1, result_ref: 'art_compare_1' })]}
        isCreating={false}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('art_compare_1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('cancelling/cancelled 均不可再取消（终态一次）', () => {
    const onCancel = vi.fn()
    render(
      <ResearchJobList
        jobs={[job({ status: 'cancelling' }), job({ job_id: 'job_2', status: 'cancelled' })]}
        isCreating={false}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryAllByRole('button', { name: /cancel/i })).toHaveLength(0)
  })

  it('failed Job 显示 last_error 与重试次数，无取消按钮', () => {
    render(
      <ResearchJobList
        jobs={[job({ status: 'failed', last_error: 'admission timeout', retry_count: 3 })]}
        isCreating={false}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('admission timeout')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('空列表显示空态', () => {
    render(<ResearchJobList jobs={[]} isCreating={false} onCancel={vi.fn()} />)
    expect(screen.getByText('research.jobsEmpty')).toBeInTheDocument()
  })
})
