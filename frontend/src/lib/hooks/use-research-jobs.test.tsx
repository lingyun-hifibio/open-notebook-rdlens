import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResearchJobs, POLL_INTERVAL_MS } from './use-research-jobs'
import {
  cancelJob,
  createCompare,
  getJob,
  listJobs,
  retryCoverageJob,
} from '@/lib/research/api'
import type { ResearchJob } from '@/lib/research/types'
import type { ResearchPage } from '@/lib/types/research'

/** #243 §6.4：调用方传入的 confirmed 全局模型快照 */
const MODEL = 'm-local'

// UI-03 Red：Job 交互状态机（契约 v0 §10）——浏览器关闭后按 job_id 恢复
// 查看（REQ-JOB-02）、终态一次（轮询不回归）、显式取消（queued/running →
// cancelling → cancelled）、Compare 51 篇不入队（REQ-QUOTA-01）、
// 本地状态不是持久 Job 状态（每轮询以服务端为准）。
// #243 §6.4：createCompare 接受 required modelId（confirmed 全局模型快照），
// 不在执行时读取执行偏好；无模型 fail-closed 不创建。

vi.mock('@/lib/research/api', () => ({
  createCompare: vi.fn(),
  getJob: vi.fn(),
  // Issue #311：必须给默认空页——裸 vi.fn() 返回 undefined 会让
  // refreshList 抛 TypeError 被静默 catch 吞掉，测试假绿
  listJobs: vi.fn(async (): Promise<ResearchPage<ResearchJob>> => ({
    items: [],
    next_cursor: null,
  })),
  cancelJob: vi.fn(),
  retryCoverageJob: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'ik-retry'),
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
      created = result.current.createCompare(over50, MODEL)
    })
    expect(created).toBeNull()
    expect(createCompare).not.toHaveBeenCalled()
    expect(result.current.error).toMatch(/50/)

    act(() => {
      created = result.current.createCompare([], MODEL)
    })
    expect(created).toBeNull()
    expect(createCompare).not.toHaveBeenCalled()

    act(() => {
      result.current.createCompare(['doc_1', 'doc_2'], MODEL)
    })
    // 创建链（POST → GET 回源）为异步：冲刷后再断言，避免游离更新
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(createCompare).toHaveBeenCalledWith('proj_1', {
      job_type: 'deep_compare', // 契约 §8.3 必填；镜像 RDLens
      // test_compare.py::TestCompareApi::test_fork_ui_serialized_body_creates_deep_compare_job
      document_ids: ['doc_1', 'doc_2'],
      group_size: undefined,
      mode: 'deep_compare',
      model_id: 'm-local',
    })
  })

  it('#243 §6.4：无 confirmed 模型 → 拒绝创建且不调用 API', () => {
    vi.mocked(getJob).mockResolvedValue(job('job_new', 'queued'))
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))

    act(() => {
      result.current.createCompare(['doc_1'], '')
    })
    expect(createCompare).not.toHaveBeenCalled()
    expect(result.current.error).toMatch(/select a research model/i)
  })

  it('创建 Compare 成功后写入 localStorage 并拉取 Job 状态', async () => {
    vi.mocked(createCompare).mockResolvedValue({ job_id: 'job_new', status: 'queued' })
    vi.mocked(getJob).mockResolvedValue(job('job_new', 'queued'))

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      result.current.createCompare(['doc_1'], MODEL)
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

// ── COV-09：Coverage Job 登记与 outcome_unknown 人工重试（§12.2） ──

describe('useResearchJobs coverage（COV-09）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('registerCoverageJob：写 localStorage + 立即回源 + 进入轮询列表（刷新后可恢复）', async () => {
    vi.mocked(getJob).mockResolvedValue(job('job_cov', 'queued', { job_type: 'research_coverage' }))
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      result.current.registerCoverageJob('job_cov')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(localStorage.getItem('rdlens.research.jobs.proj_1')).toContain('job_cov')
    expect(getJob).toHaveBeenCalledWith('proj_1', 'job_cov')
    expect(result.current.jobs).toHaveLength(1)
    expect(result.current.jobs[0]).toMatchObject({ job_id: 'job_cov', job_type: 'research_coverage' })
  })

  it('retryCoverage 成功：新幂等键 + 确认计费风险 → 回源刷新，返回 true', async () => {
    const queued = job('job_cov', 'queued', { job_type: 'research_coverage' })
    vi.mocked(getJob).mockResolvedValue(queued)
    vi.mocked(retryCoverageJob).mockResolvedValue({
      job_id: 'job_cov', status: 'queued', generation_id: 'gen_new', session_id: 's1',
      retry_of_generation_id: 'gen_old',
    })
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      result.current.registerCoverageJob('job_cov')
      await vi.advanceTimersByTimeAsync(0)
    })
    let ok = false
    await act(async () => {
      ok = await result.current.retryCoverage('job_cov')
    })
    expect(ok).toBe(true)
    expect(retryCoverageJob).toHaveBeenCalledWith('proj_1', 'job_cov', 'ik-retry')
    // 重试后立即回源刷新（Job 回到 queued，轮询继续）
    expect(getJob).toHaveBeenCalledTimes(2)
  })

  it('retryCoverage 失败：返回 false 且 error 可见', async () => {
    vi.mocked(getJob).mockResolvedValue(job('job_cov', 'failed', { job_type: 'research_coverage' }))
    vi.mocked(retryCoverageJob).mockRejectedValue(new Error('409: reuse of old idempotency key'))
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    let ok: boolean | null = null
    await act(async () => {
      ok = await result.current.retryCoverage('job_cov')
    })
    expect(ok).toBe(false)
    expect(result.current.error).toContain('409')
  })
})

// ── Issue #311：服务端列表恢复（换设备不失联） ──

/** 伪造 axios 404 错误（isAxiosError 按属性判定，plain object 即可） */
function axios404(): Error {
  return Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true,
    response: { status: 404 },
  })
}

describe('useResearchJobs 服务端列表恢复（Issue #311）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.clearAllMocks()
    // clearAllMocks 不清除工厂默认实现，这里显式恢复空页（防用例间泄漏）
    vi.mocked(listJobs).mockResolvedValue({ items: [], next_cursor: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('挂载合并服务端列表与 localStorage 去重（并集无重复；storage-only id 仍回源）', async () => {
    vi.mocked(listJobs).mockResolvedValue({
      items: [job('job_1', 'completed', { progress: 1 }), job('job_2', 'running', { progress: 0.5 })],
      next_cursor: null,
    })
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_2', 'job_3']))
    vi.mocked(getJob).mockResolvedValue(job('job_3', 'queued'))

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(listJobs).toHaveBeenCalledWith('proj_1', { limit: 100 })
    expect(getJob).toHaveBeenCalledWith('proj_1', 'job_3')
    const ids = result.current.jobs.map((j) => j.job_id).sort()
    expect(ids).toEqual(['job_1', 'job_2', 'job_3'])
  })

  it('listJobs 失败 → 静默回退 localStorage 恢复，error 为 null（旧后端兼容）', async () => {
    vi.mocked(listJobs).mockRejectedValue(axios404())
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_9']))
    vi.mocked(getJob).mockResolvedValue(job('job_9', 'completed', { progress: 1 }))

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(result.current.jobs).toHaveLength(1)
    expect(result.current.jobs[0]).toMatchObject({ job_id: 'job_9' })
    expect(result.current.error).toBeNull()
  })

  it('window focus 触发列表刷新：新 Job 入列并进入轮询（跨设备可见）', async () => {
    vi.mocked(getJob).mockResolvedValue(job('job_focus', 'queued'))
    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(listJobs).toHaveBeenCalledTimes(1)

    vi.mocked(listJobs).mockResolvedValue({
      items: [job('job_focus', 'queued', { progress: 0.2 })],
      next_cursor: null,
    })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(listJobs).toHaveBeenCalledTimes(2)
    expect(result.current.jobs.some((j) => j.job_id === 'job_focus')).toBe(true)

    // 新 Job 进入轮询集合
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(getJob).toHaveBeenCalledWith('proj_1', 'job_focus')
  })

  it('终态列表 Job 不参与轮询（terminalLockedRef）', async () => {
    vi.mocked(listJobs).mockResolvedValue({
      items: [job('job_done', 'completed', { progress: 1 })],
      next_cursor: null,
    })
    vi.mocked(getJob).mockResolvedValue(job('job_done', 'completed', { progress: 1 }))

    renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    })
    expect(getJob).not.toHaveBeenCalledWith('proj_1', 'job_done')
  })

  it('非终态列表 Job 进入轮询', async () => {
    vi.mocked(listJobs).mockResolvedValue({
      items: [job('job_run', 'running', { progress: 0.3 })],
      next_cursor: null,
    })
    vi.mocked(getJob).mockResolvedValue(job('job_run', 'running', { progress: 0.6 }))

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(getJob).toHaveBeenCalledWith('proj_1', 'job_run')
    expect(result.current.jobs[0]).toMatchObject({ job_id: 'job_run', progress: 0.6 })
  })

  it('创建 Compare 成功后刷新服务端列表', async () => {
    vi.mocked(createCompare).mockResolvedValue({ job_id: 'job_new', status: 'queued' })
    vi.mocked(getJob).mockResolvedValue(job('job_new', 'queued'))

    const { result } = renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(listJobs).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.createCompare(['doc_1'], MODEL)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(listJobs).toHaveBeenCalledTimes(2)
  })

  it('getJob 404（Job 已 purge）→ 移出轮询集合，不再空轮询', async () => {
    localStorage.setItem(
      'rdlens.research.jobs.proj_1',
      JSON.stringify(['job_dead', 'job_live']),
    )
    vi.mocked(getJob).mockImplementation(async (_pid, jid) => {
      if (jid === 'job_dead') throw axios404()
      return job(jid, 'queued')
    })

    renderHook(() => useResearchJobs({ projectId: 'proj_1' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })

    const deadCalls = vi
      .mocked(getJob)
      .mock.calls.filter(([, jid]) => jid === 'job_dead').length
    expect(deadCalls).toBe(1)
    const liveCalls = vi
      .mocked(getJob)
      .mock.calls.filter(([, jid]) => jid === 'job_live').length
    expect(liveCalls).toBeGreaterThanOrEqual(3)
  })

  it('projectId 切换：jobs 清空 + 旧项目在途列表响应不合并（跨项目污染守卫）', async () => {
    let resolveP1:
      | ((page: ResearchPage<ResearchJob>) => void)
      | null = null
    vi.mocked(getJob).mockResolvedValue(job('job_9', 'running'))
    vi.mocked(listJobs).mockImplementation(async (pid) => {
      if (pid === 'proj_1') {
        return new Promise((resolve) => {
          resolveP1 = resolve
        })
      }
      return { items: [], next_cursor: null }
    })

    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_9']))
    const { result, rerender } = renderHook(
      ({ projectId }) => useResearchJobs({ projectId }),
      { initialProps: { projectId: 'proj_1' } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.jobs).toHaveLength(1)

    // 切换项目：视图立即清空
    rerender({ projectId: 'proj_2' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.jobs).toHaveLength(0)

    // proj_1 的在途列表响应迟到返回：不得合并进 proj_2 视图
    await act(async () => {
      resolveP1?.({ items: [job('job_old_proj_1', 'running')], next_cursor: null })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.jobs).toHaveLength(0)
    expect(
      result.current.jobs.some((j) => j.job_id === 'job_old_proj_1'),
    ).toBe(false)
  })
})
