import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResearchJobs, POLL_INTERVAL_MS } from './use-research-jobs'
import { createCompare, getJob, cancelJob } from '@/lib/research/api'
import type { ResearchJob } from '@/lib/research/types'

// UI-03 Red：Job 交互状态机（契约 v0 §10）——浏览器关闭后按 job_id 恢复
// 查看（REQ-JOB-02）、终态一次（轮询不回归）、显式取消（queued/running →
// cancelling → cancelled）、Compare 51 篇不入队（REQ-QUOTA-01）、
// 本地状态不是持久 Job 状态（每轮询以服务端为准）。

vi.mock('@/lib/research/api', () => ({
  createCompare: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
}))

function job(id: string, status: ResearchJob['status'], overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    job_id: id,
    project_id: 'proj_1',
    job_type: 'deep_compare',
    status,
    stage: null,
    progress: 0,
    model_id: null,
    generation_epoch: 1,
    retry_count: 0,
    last_error: null,
    result_ref: null,
    created_at: '2026-08-06T02:00:00Z',
    updated_at: '2026-08-06T02:00:00Z',
    ...overrides,
  }
}

describe('useResearchJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('挂载后从 localStorage 恢复 job_id 并 GET 回源（浏览器关闭后可恢复查看）', async () => {
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_9']))
    vi.mocked(getJob).mockResolvedValue(job('job_9', 'completed', { result_ref: 'art_1', progress: 1 }))

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(getJob).toHaveBeenCalledWith('proj_1', 'job_9')
    expect(result.current.jobs).toHaveLength(1)
    expect(result.current.jobs[0]).toMatchObject({ job_id: 'job_9', status: 'completed', result_ref: 'art_1' })
  })

  it('Compare 51 篇：拒绝且不调用创建 API；空选拒绝', async () => {
    vi.mocked(getJob).mockResolvedValue(job('job_new', 'queued'))
    vi.mocked(createCompare).mockResolvedValue({ job_id: 'job_new', status: 'queued' })
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))

    const over50 = Array.from({ length: 51 }, (_, i) => `doc_${i}`)
    let created: ResearchJob | null = null
    act(() => {
      created = result.current.createCompare(over50)
    })
    expect(created).toBeNull()
    expect(createCompare).not.toHaveBeenCalled()
    expect(result.current.error).toMatch(/50/)

    act(() => {
      created = result.current.createCompare([])
    })
    expect(created).toBeNull()
    expect(createCompare).not.toHaveBeenCalled()

    act(() => {
      result.current.createCompare(['doc_1', 'doc_2'])
    })
    expect(createCompare).toHaveBeenCalledWith('proj_1', {
      document_ids: ['doc_1', 'doc_2'],
      mode: 'deep_compare',
    })
  })

  it('创建 Compare 成功后写入 localStorage 并拉取 Job 状态', async () => {
    vi.mocked(createCompare).mockResolvedValue({ job_id: 'job_new', status: 'queued' })
    vi.mocked(getJob).mockResolvedValue(job('job_new', 'queued'))

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      result.current.createCompare(['doc_1'])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(JSON.parse(localStorage.getItem('rdlens.research.jobs.proj_1') ?? '[]')).toEqual(['job_new'])
    expect(result.current.jobs.some((j) => j.job_id === 'job_new')).toBe(true)
  })

  it('轮询更新非终态 Job；终态一次——迟到 running 响应不回归已完成状态', async () => {
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_1']))
    let n = 0
    vi.mocked(getJob).mockImplementation(async (_pid, jid) => {
      n += 1
      // 挂载恢复 → running；第一次轮询 → completed；之后迟到旧响应 → running
      if (n === 1) return job(jid, 'running', { progress: 0.5 })
      if (n === 2) return job(jid, 'completed', { progress: 1, result_ref: 'art_1' })
      return job(jid, 'running', { progress: 0.5 })
    })

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(result.current.jobs[0].status).toBe('completed')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(result.current.jobs[0].status).toBe('completed')
    expect(result.current.jobs[0].result_ref).toBe('art_1')
  })

  it('显式取消：running → cancel POST；乐观 cancelling → 轮询到 cancelled 终态', async () => {
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_1']))
    const log: string[] = []
    let n = 0
    vi.mocked(getJob).mockImplementation(async (_pid, jid) => {
      n += 1
      const statuses: ResearchJob['status'][] = ['running', 'cancelling', 'cancelled']
      const status = statuses[n - 1] ?? 'cancelled'
      log.push(`getJob#${n}->${status}`)
      return job(jid, status)
    })
    vi.mocked(cancelJob).mockResolvedValue(undefined)

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    await act(async () => {
      result.current.cancel('job_1')
      // 刷新 cancel 链（POST → 回源）后推进轮询，一次完成全部状态转换
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(cancelJob).toHaveBeenCalledWith('proj_1', 'job_1')
    expect(log).toEqual(['getJob#1->running', 'getJob#2->cancelling', 'getJob#3->cancelled'])
    expect(result.current.jobs[0].status).toBe('cancelled')
  })

  it('取消已终态 Job：不调用 API 并报错（契约 §10.3：completed → 409）', async () => {
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_1']))
    vi.mocked(getJob).mockImplementation(async (_pid, jid) => job(jid, 'completed', { progress: 1 }))
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      result.current.cancel('job_1')
    })
    expect(cancelJob).not.toHaveBeenCalled()
    expect(result.current.error).toMatch(/cancel/i)
  })

  it('取消失败（HTTP 错误）恢复服务端状态并报错', async () => {
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_1']))
    vi.mocked(getJob).mockResolvedValue(job('job_1', 'running'))
    vi.mocked(cancelJob).mockRejectedValue(new Error('409 Conflict'))
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => {
      result.current.cancel('job_1')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.error).toBe('409 Conflict')
    expect(result.current.jobs[0].status).toBe('running')
  })
})
