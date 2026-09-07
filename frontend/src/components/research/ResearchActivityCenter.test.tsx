import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import { ResearchActivityCenter } from './ResearchActivityCenter'
import * as api from '@/lib/research/api'
import type { ResearchJob } from '@/lib/research/types'

// RWV2-41 Red：Activity Center——Active/History 分组与徽标口径一致；
// loading / list-unavailable / list-error / action-error / 空态互不混同；
// History 客户端切片（有界 DOM）；coverage 富化（列表行无 coverage 段）；
// Admin 消费层省略 cancel/retry。

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>()
  return {
    ...actual,
    listSources: vi.fn(async () => ({ items: [], next_cursor: null })),
    listNotes: vi.fn(async () => ({ items: [], next_cursor: null })),
    listJobs: vi.fn(async () => ({ items: [], next_cursor: null })),
    getJob: vi.fn(async () => ({}) as ResearchJob),
    cancelJob: vi.fn(async () => undefined),
    retryCoverageJob: vi.fn(async () => undefined),
    createCompare: vi.fn(),
  }
})

vi.mock('@/lib/hooks/use-research-global-model', () => ({
  useResearchGlobalModel: () => ({
    models: [
      { model_id: 'm1', display_name: 'Qwen Local', provider_id: null, data_egress: false },
    ],
    confirmedModelId: 'm1',
  }),
}))

const jobsByIdRef: { current: Map<string, ResearchJob> } = { current: new Map() }

function setJobs(list: ResearchJob[]) {
  jobsByIdRef.current = new Map(list.map((j) => [j.job_id, j]))
  vi.mocked(api.listJobs).mockResolvedValue({ items: list, next_cursor: null })
  vi.mocked(api.getJob).mockImplementation(async (_pid, jobId) => {
    const known = jobsByIdRef.current.get(jobId)
    return known ?? ({} as ResearchJob)
  })
}

function job(id: string, status: ResearchJob['status'], overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    job_id: id,
    project_id: 'proj_1',
    job_type: 'deep_compare',
    status,
    stage: null,
    progress: status === 'completed' ? 1 : 0.4,
    model_id: 'm1',
    generation_epoch: 1,
    retry_count: 0,
    last_error: null,
    result_ref: status === 'completed' ? 'art_1' : null,
    created_at: '2026-08-06T02:00:00Z',
    updated_at: '2026-08-06T02:00:00Z',
    ...overrides,
  }
}

function coverageJobWithDetails(id: string): ResearchJob {
  return job(id, 'completed', {
    job_type: 'research_coverage',
    result_ref: 'art_cov_1',
    progress: 1,
    coverage: {
      synthesis_scope: 'all_selected',
      contract_version: null,
      execution_plan_version: null,
      prompt_bundle_version: null,
      generation_id: null,
    },
  })
}

function failedOutcomeCoverage(id: string): ResearchJob {
  return job(id, 'failed', {
    job_type: 'research_coverage',
    progress: 0.8,
    last_error: 'outcome unknown',
    coverage: {
      synthesis_scope: 'all_selected',
      contract_version: null,
      execution_plan_version: null,
      prompt_bundle_version: null,
      generation_id: 'gen_old',
      generation: { generation_id: 'gen_old', state: 'outcome_unknown', failure_code: null },
    },
  })
}

function wrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const w = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId="proj_1" role={role}>
        <ResearchJobsProvider>
          <ResearchScopeProvider userId="u1" projectId="proj_1">
            {children}
          </ResearchScopeProvider>
        </ResearchJobsProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return w
}

describe('ResearchActivityCenter（RWV2-41）', () => {
  beforeEach(() => {
    vi.mocked(api.listJobs).mockClear()
    vi.mocked(api.getJob).mockClear()
    vi.mocked(api.cancelJob).mockClear()
    setJobs([])
    localStorage.clear()
  })
  afterEach(cleanup)

  it('loading：初始无内容时显示 loading 态，就绪后空态', async () => {
    const deferred: { current: ((p: never) => void) | null } = { current: null }
    vi.mocked(api.listJobs).mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.current = resolve as (p: never) => void
        }),
    )
    render(<ResearchActivityCenter />, { wrapper: wrapper() })
    expect(screen.getByTestId('activity-loading')).toBeInTheDocument()

    deferred.current?.({ items: [], next_cursor: null } as never)
    await waitFor(() => expect(screen.getByTestId('activity-empty')).toBeInTheDocument())
    expect(screen.queryByTestId('activity-loading')).toBeNull()
  })

  it('Active/History 分组渲染，状态与类型为任务导向英文 key', async () => {
    setJobs([
      job('job_run', 'running'),
      job('job_done', 'completed'),
      job('job_fail', 'failed', { last_error: 'admission timeout' }),
    ])
    render(<ResearchActivityCenter />, { wrapper: wrapper() })
    await waitFor(() => expect(screen.getByTestId('activity-active-section')).toBeInTheDocument())
    expect(screen.getByTestId('activity-history-section')).toBeInTheDocument()
    // running 卡在 Active，状态徽标为 label key（测试 t 返回 key 本身）
    expect(screen.getByTestId('job-job_run')).toBeInTheDocument()
    expect(screen.getByTestId('job-job_run').querySelector('[data-testid="job-status"]'))
      .toHaveTextContent('research.activity.state.running')
    expect(screen.getByTestId('job-job_run').querySelector('[data-testid="job-type"]'))
      .toHaveTextContent('research.activity.type.deepCompare')
    // meta：model 展示名（Qwen Local）+ created 时间存在
    expect(screen.getByTestId('job-job_run')).toHaveTextContent('Qwen Local')
    expect(screen.getByTestId('job-job_run').querySelector('[data-testid="job-created"]'))
      .not.toBeNull()
    // failed 卡展示错误信息
    expect(screen.getByText('admission timeout')).toBeInTheDocument()
  })

  it('History 客户端切片：初始 50 条 + Show more 逐批揭示且有界', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      job(`job_${String(i).padStart(3, '0')}`, 'completed'),
    )
    setJobs(many)
    render(<ResearchActivityCenter />, { wrapper: wrapper() })
    await waitFor(() => expect(screen.getByTestId('activity-history-show-more')).toBeInTheDocument())
    const countCards = () =>
      document.querySelectorAll('[data-testid^="job-job_"]').length
    expect(countCards()).toBe(50)

    fireEvent.click(screen.getByTestId('activity-history-show-more'))
    await waitFor(() => expect(countCards()).toBe(100))
    fireEvent.click(screen.getByTestId('activity-history-show-more'))
    await waitFor(() => expect(countCards()).toBe(120))
    expect(screen.queryByTestId('activity-history-show-more')).toBeNull()
  })

  it('list 失败但有 localStorage 兜底内容 → 非破坏提示（unavailable），内容仍可见', async () => {
    localStorage.setItem('rdlens.research.jobs.proj_1', JSON.stringify(['job_recovered']))
    vi.mocked(api.listJobs).mockRejectedValue(
      Object.assign(new Error('list failed'), { isAxiosError: true, response: { status: 404 } }),
    )
    vi.mocked(api.getJob).mockResolvedValue(job('job_recovered', 'running'))

    render(<ResearchActivityCenter />, { wrapper: wrapper() })
    await waitFor(() => expect(screen.getByTestId('activity-list-unavailable')).toBeInTheDocument())
    expect(screen.queryByTestId('activity-list-error')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('job-job_recovered')).toBeInTheDocument())
  })

  it('list 失败且无兜底 → 真错误态 + Retry 可恢复', async () => {
    vi.mocked(api.listJobs).mockRejectedValue(new Error('list failed'))
    render(<ResearchActivityCenter />, { wrapper: wrapper() })
    await waitFor(() => expect(screen.getByTestId('activity-list-error')).toBeInTheDocument())
    expect(screen.queryByTestId('activity-list-unavailable')).toBeNull()

    setJobs([job('job_ok', 'running')])
    fireEvent.click(screen.getByTestId('activity-list-retry'))
    await waitFor(() => expect(screen.getByTestId('job-job_ok')).toBeInTheDocument())
    expect(screen.queryByTestId('activity-list-error')).toBeNull()
  })

  it('Owner 可取消运行中任务；Admin 消费层省略 cancel/retry', async () => {
    setJobs([job('job_owner', 'running')])
    render(<ResearchActivityCenter />, { wrapper: wrapper('owner') })
    await waitFor(() => expect(screen.getByTestId('cancel-job_owner')).toBeInTheDocument())
    cleanup()

    setJobs([job('job_admin', 'running')])
    render(<ResearchActivityCenter />, { wrapper: wrapper('admin_readonly') })
    await waitFor(() => expect(screen.getByTestId('job-job_admin')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.jobsCancel' })).toBeNull()
  })

  it('actionError：cancel 失败展示可关闭的错误条（瞬时失败不产生幽灵）', async () => {
    setJobs([job('job_cx', 'running')])
    vi.mocked(api.cancelJob).mockRejectedValue(new Error('cancel failed'))
    render(<ResearchActivityCenter />, { wrapper: wrapper('owner') })
    await waitFor(() => expect(screen.getByTestId('job-job_cx')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('cancel-job_cx'))
    await waitFor(() => expect(screen.getByTestId('activity-action-error')).toBeInTheDocument())
    expect(screen.getByTestId('activity-action-error')).toHaveTextContent('cancel failed')
    // 卡片仍保留（瞬时失败不误删）
    expect(screen.getByTestId('job-job_cx')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'research.activity.actionErrorDismiss' }))
    await waitFor(() => expect(screen.queryByTestId('activity-action-error')).toBeNull())
  })

  it('coverage 富化：可见 coverage 终态行回源详情（报告/scope 依赖 coverage 段）', async () => {
    // 列表行（无 coverage 段）
    setJobs([job('job_cov', 'completed', { job_type: 'research_coverage', result_ref: 'art_cov_1', progress: 1 })])
    // 富化 GET 返回带 coverage 的详情
    vi.mocked(api.getJob).mockResolvedValue(coverageJobWithDetails('job_cov'))

    render(<ResearchActivityCenter />, { wrapper: wrapper() })
    await waitFor(() => expect(screen.getByTestId('job-job_cov')).toBeInTheDocument())
    // 打开 Activity 即对可见 coverage 行富化
    await waitFor(() =>
      expect(api.getJob).toHaveBeenCalledWith('proj_1', 'job_cov'),
    )
    // coverage 段附着后升级为富详情（scope 行 + coverage 详情）
    await waitFor(() => expect(screen.getByTestId('job-scope')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('coverage-job-details')).toBeInTheDocument())
  })

  it('Admin 消费层省略 coverage outcome_unknown 重试入口（Owner 保留，服务端仍权威）', async () => {
    setJobs([job('job_cov_fail', 'failed', { job_type: 'research_coverage', last_error: 'x' })])
    vi.mocked(api.getJob).mockResolvedValue(failedOutcomeCoverage('job_cov_fail'))

    // Owner：富化后 outcome_unknown 块给出显式重试入口
    render(<ResearchActivityCenter />, { wrapper: wrapper('owner') })
    await waitFor(() => expect(screen.getByTestId('coverage-outcome-unknown')).toBeInTheDocument())
    expect(screen.getByTestId('coverage-retry-trigger')).toBeInTheDocument()
    cleanup()

    // Admin：同内容，无 cancel/retry 回调 → 不渲染可点的重试入口
    render(<ResearchActivityCenter />, { wrapper: wrapper('admin_readonly') })
    await waitFor(() => expect(screen.getByTestId('coverage-outcome-unknown')).toBeInTheDocument())
    expect(screen.queryByTestId('coverage-retry-trigger')).toBeNull()
  })
})
