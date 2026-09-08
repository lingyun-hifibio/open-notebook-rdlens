import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import { ResearchHeader } from './ResearchHeader'
import { ResearchActivityDialog } from './ResearchActivityDialog'
import * as api from '@/lib/research/api'
import type { ResearchJob } from '@/lib/research/types'

// RWV2-40 Red：Header（Current scope | Global model | Activity | Export）与
// Activity 兼容壳（JobList；Admin 无 cancel/retry；关闭 Dialog 后
// Citation → 组合根路由）。
// RWV2-UIOPT-A（fork #57）：技术 Project 段删除；Scope 靠左，
// Model/Activity/Export 以 ml-auto 聚合右侧（桌面单行）。

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.count ?? opts.name ?? '')}` : key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>()
  return {
    ...actual,
    listSources: vi.fn(async () => ({ items: [], next_cursor: null })),
    listNotes: vi.fn(async () => ({ items: [], next_cursor: null })),
    listJobs: vi.fn(async () => ({ items: [], next_cursor: null })),
    getJob: vi.fn(async (_pid: string, jobId: string) => {
      const known = activeJobsRef.current.find((j) => j.job_id === jobId)
      return known ?? ({} as ResearchJob)
    }),
    cancelJob: vi.fn(async () => undefined),
    retryCoverageJob: vi.fn(async () => undefined),
    createCompare: vi.fn(),
  }
})

const mediaQueryMocks = vi.hoisted(() => ({ isDesktop: vi.fn(() => true) }))
vi.mock('@/lib/hooks/use-media-query', () => ({
  useIsDesktop: () => mediaQueryMocks.isDesktop(),
}))

vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

// 供 listJobs/getJob mock 读取的活动任务集合（跨 test 重置）
const activeJobsRef: { current: ResearchJob[] } = { current: [] }

function setActiveJobs(jobs: ResearchJob[]) {
  activeJobsRef.current = jobs
  vi.mocked(api.listJobs).mockResolvedValue({ items: jobs, next_cursor: null })
  vi.mocked(api.getJob).mockImplementation(async (_pid: string, jobId: string) => {
    const known = activeJobsRef.current.find((j) => j.job_id === jobId)
    return known ?? ({} as ResearchJob)
  })
}

function job(overrides: Partial<ResearchJob>): ResearchJob {
  return {
    job_id: 'job_1',
    project_id: 'p1',
    job_type: 'deep_compare',
    status: 'running',
    stage: 'group_evidence',
    progress: 0.4,
    model_id: 'm1',
    generation_epoch: 7,
    retry_count: 0,
    last_error: null,
    result_ref: null,
    created_at: '2026-08-06T02:00:00Z',
    updated_at: '2026-08-06T02:00:00Z',
    ...overrides,
  }
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

describe('ResearchHeader（RWV2-40 五段）', () => {
  beforeEach(() => {
    toastMock.mockClear()
    mediaQueryMocks.isDesktop.mockReturnValue(true)
  })
  afterEach(cleanup)

  it('UIOPT-A：不再渲染技术 Project 段；Scope/Model/Activity/Export 段仍齐备', async () => {
    render(
      <ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />,
      { wrapper: wrapper() },
    )
    expect(screen.getByTestId('research-header')).toBeInTheDocument()
    // iframe 内技术 Project ID 段删除（可读项目名称由 RDLens 父页面展示）
    expect(screen.queryByTestId('header-project')).toBeNull()
    expect(screen.queryByText('research.header.project')).toBeNull()
    // 其余段完整保留：Scope 摘要 + Edit、模型 Trigger、Activity、Export
    await waitFor(() =>
      expect(screen.getByTestId('research-context-scope')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('scope-edit-button')).toBeInTheDocument()
    expect(screen.getByTestId('global-model-summary-trigger')).toBeInTheDocument()
    expect(screen.getByTestId('activity-trigger')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'research.workbench.exportAll' }),
    ).toBeInTheDocument()
  })

  it('UIOPT-A：桌面单行结构——Scope 靠左，Model/Activity/Export 以 ml-auto 聚合右侧', async () => {
    render(
      <ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />,
      { wrapper: wrapper() },
    )
    // Scope 段无 margin-left:auto（左对齐），右侧操作组聚合到行尾
    expect(screen.getByTestId('header-current-scope')).not.toHaveClass('ml-auto')
    expect(screen.getByTestId('header-actions')).toHaveClass('ml-auto')
    await waitFor(() =>
      expect(screen.getByTestId('research-context-scope')).toBeInTheDocument(),
    )
  })

  it('Header 五段可用（Edit scope 触发组合根统一链路）', async () => {
    const onEdit = vi.fn()
    render(<ResearchHeader onEditScopeAllStates={onEdit} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(screen.getByTestId('scope-edit-button')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('scope-edit-button'))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('Activity trigger 打开 Activity Dialog', async () => {
    render(
      <ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />,
      { wrapper: wrapper() },
    )
    fireEvent.click(screen.getByTestId('activity-trigger'))
    await waitFor(() => expect(screen.getByTestId('activity-dialog')).toBeInTheDocument())
  })
})

describe('ResearchActivityDialog（Jobs 兼容壳）', () => {
  beforeEach(() => {
    toastMock.mockClear()
    vi.mocked(api.listJobs).mockClear()
    vi.mocked(api.cancelJob).mockClear()
    setActiveJobs([])
    localStorage.clear()
  })
  afterEach(cleanup)

  it('Owner：渲染 JobList；运行中 Job 可 cancel（真回调）', async () => {
    setActiveJobs([job({})])
    render(
      <ResearchActivityDialog open onOpenChange={() => {}} onCitationJump={() => {}} />,
      { wrapper: wrapper('owner') },
    )
    await waitFor(() => expect(screen.getByTestId('job-job_1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.jobsCancel' }))
    await waitFor(() =>
      expect(api.cancelJob).toHaveBeenCalledWith('proj_1', 'job_1'),
    )
  })

  it('Admin：JobList 可见但无 cancel/retry 按钮（消费层省略回调）', async () => {
    setActiveJobs([job({})])
    render(
      <ResearchActivityDialog open onOpenChange={() => {}} onCitationJump={() => {}} />,
      { wrapper: wrapper('admin_readonly') },
    )
    await waitFor(() => expect(screen.getByTestId('job-job_1')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.jobsCancel' })).toBeNull()
  })

})

describe('ResearchHeader（RWV2-41 Activity 徽标计数）', () => {
  beforeEach(() => {
    toastMock.mockClear()
    mediaQueryMocks.isDesktop.mockReturnValue(true)
    vi.mocked(api.listJobs).mockClear()
    setActiveJobs([])
    localStorage.clear()
  })
  afterEach(cleanup)

  it('无非终态任务时不显示徽标（0 active）', async () => {
    render(<ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(screen.getByTestId('activity-trigger')).toBeInTheDocument())
    expect(screen.queryByTestId('activity-badge')).toBeNull()
    expect(screen.getByTestId('activity-trigger')).toHaveAttribute(
      'aria-label',
      'research.activity.title',
    )
  })

  it('徽标只计非终态：终态（completed/failed/cancelled）不计入', async () => {
    setActiveJobs([
      job({ job_id: 'run', status: 'running' }),
      job({ job_id: 'done', status: 'completed' }),
      job({ job_id: 'bad', status: 'failed' }),
      job({ job_id: 'cancelled_1', status: 'cancelled' }),
    ])
    render(<ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(screen.getByTestId('activity-badge')).toHaveTextContent('1'))
    expect(screen.getByTestId('activity-trigger')).toHaveAttribute(
      'aria-label',
      'research.activity.badgeActive:1',
    )
  })

  it('徽标计 queued/running/cancelling（cancelling 属进行中；可点性仍受 canCancelJob 约束）', async () => {
    setActiveJobs([
      job({ job_id: 'q', status: 'queued' }),
      job({ job_id: 'run', status: 'running' }),
      job({ job_id: 'cx', status: 'cancelling' }),
    ])
    render(<ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(screen.getByTestId('activity-badge')).toHaveTextContent('3'))
  })

  it('任务进入终态后徽标即时减少（经 focus 列表刷新推送服务端终态）', async () => {
    setActiveJobs([job({ job_id: 'run', status: 'running' })])
    render(<ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(screen.getByTestId('activity-badge')).toHaveTextContent('1'))
    // 服务端已终态：更新 mock 并经 focus 触发的第一页刷新合并
    setActiveJobs([job({ job_id: 'run', status: 'completed' })])
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(screen.queryByTestId('activity-badge')).toBeNull())
  })
})

// RWV2-43（fork #47）：Activity 非终态计数的隐藏 live region（R2-2/C-H2）。
// 规则：effect 依赖 [activeCount, activityOpen]；Dialog 打开时不写文本，
// 关闭时重同步当前计数；等价文本不重复播报。
describe('ResearchHeader（RWV2-43 Activity live region）', () => {
  beforeEach(() => {
    toastMock.mockClear()
    mediaQueryMocks.isDesktop.mockReturnValue(true)
    vi.mocked(api.listJobs).mockClear()
    setActiveJobs([])
    localStorage.clear()
  })
  afterEach(cleanup)

  it('计数 0 → >0（Dialog 关闭）→ live region 播报当前非终态计数', async () => {
    render(<ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    const region = await screen.findByTestId('activity-live-region')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
    expect(region.textContent).toBe('')
    setActiveJobs([job({ job_id: 'run', status: 'running' })])
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(region.textContent).toBe('research.activity.badgeActive:1'))
  })

  it('Dialog 打开期间计数变化被抑制；关闭后重同步当前计数（R2-2）', async () => {
    setActiveJobs([job({ job_id: 'run', status: 'running' })])
    render(<ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    const region = await screen.findByTestId('activity-live-region')
    await waitFor(() => expect(region.textContent).toBe('research.activity.badgeActive:1'))
    // 打开 Dialog → 计数 1 → 2（模拟轮询合并新任务）；live region 必须保持旧值
    fireEvent.click(screen.getByTestId('activity-trigger'))
    await waitFor(() => expect(screen.getByTestId('activity-dialog')).toBeInTheDocument())
    setActiveJobs([
      job({ job_id: 'run', status: 'running' }),
      job({ job_id: 'q2', status: 'queued' }),
    ])
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(screen.getByTestId('activity-badge')).toHaveTextContent('2'))
    expect(region.textContent).toBe('research.activity.badgeActive:1')
    // 关闭 Dialog → 关闭转移无条件重同步当前计数
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    await waitFor(() => expect(region.textContent).toBe('research.activity.badgeActive:2'))
  })

  it('计数无变化 → 不重复播报（等价文本不写）', async () => {
    render(<ResearchHeader onEditScopeAllStates={() => {}} onCitationJump={() => {}} />, {
      wrapper: wrapper(),
    })
    const region = await screen.findByTestId('activity-live-region')
    expect(region.textContent).toBe('')
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(region.textContent).toBe('')
  })
})
