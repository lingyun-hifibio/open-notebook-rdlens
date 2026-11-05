/**
 * Issue #1016（D1-G）主题概览入口卡测试（计划 §5.2 F-01/F-02）。
 *
 * 覆盖：
 * - F-01 能力位 fail-closed：`topic_overview` 缺失/false → 入口不渲染，
 *   且不发起概览读取（`enabled: false`）；
 * - F-02 入口状态：无概览/有概览（范围摘要+时间+受限徽标）/生成中/读失败
 *   （内联错误 + 手动重试，不自动重试）/资料变化（只提示不自动更新）；
 * - F-02 集成：入口卡存在时 Chat 输入/发送仍可用（不被遮挡/拦截），
 *   Dialog 未打开时无遮罩层。
 *
 * 替身：`use-research-topic-overview` hooks（Entry 状态机输入）+ `api`
 * 函数级替身（workspace 集成用例共享）；被测 Entry/Workspace 组件真实。
 */
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useResearchSources } from '@/lib/hooks/use-research'
import { ResearchWorkspace } from './ResearchWorkspace'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import { ResearchScopeProvider } from '@/lib/research/scope'
import {
  TopicOverviewEntry,
  topicOverviewGenerateMutationKey,
} from './TopicOverviewEntry'
import type { TopicOverviewWire } from '@/lib/research/topic-overview'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'
import { resetGlobalModelStub } from '@/test/global-model-stub'

const PROJECT_ID = 'proj_1'

const h = vi.hoisted(() => ({
  capability: false,
  overviewData: null as unknown,
  isLoading: false,
  isError: false,
  error: null as unknown,
  enabledCalls: [] as Array<{ enabled?: boolean } | undefined>,
  refetch: vi.fn(),
  listSources: vi.fn(),
  listNotes: vi.fn(),
  listModels: vi.fn(),
  openResearchChatStream: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}|${JSON.stringify(opts)}`,
  }),
}))

vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/lib/hooks/use-research-topic-overview', () => ({
  topicOverviewGenerateMutationKey: (projectId: string) => [
    'research',
    projectId,
    'topic-overview',
    'generate',
  ],
  useResearchTopicOverviewCapability: vi.fn(() => h.capability),
  useResearchTopicOverview: vi.fn(
    (_projectId: string, options?: { enabled?: boolean }) => {
      h.enabledCalls.push(options)
      return {
        data: h.overviewData,
        isLoading: h.isLoading,
        isError: h.isError,
        error: h.error,
        refetch: h.refetch,
      }
    },
  ),
  useGenerateTopicOverview: vi.fn(() => ({
    data: null,
    isPending: false,
    reset: vi.fn(),
    mutateAsync: vi.fn(async () => {
      throw new Error('unused-in-entry-tests')
    }),
  })),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    listSources: h.listSources,
    listNotes: h.listNotes,
    listModels: h.listModels,
    openResearchChatStream: h.openResearchChatStream,
  }
})

function source(overrides: Partial<ResearchSource> = {}): ResearchSource {
  return {
    source_id: 'src_1',
    document_id: 'doc_1',
    document_version: 'v1',
    status: 'ready',
    content_hash: null,
    synced_at: '2026-11-05T09:00:00+00:00',
    last_error: null,
    ...overrides,
  }
}

const note: ResearchNote = {
  note_id: 'note_1',
  project_id: PROJECT_ID,
  title: 'Note One',
  content: 'body',
  note_type: 'human',
  created_at: '2026-11-05T09:00:00+00:00',
  updated_at: '2026-11-05T09:00:00+00:00',
}

function readyOverview(overrides: Partial<TopicOverviewWire> = {}): TopicOverviewWire {
  return {
    overview_id: 'ovw_1',
    generation_id: 'gen_1',
    generated_at: '2026-11-05T10:00:00+00:00',
    generation_created_at: '2026-11-05T09:55:00+00:00',
    focus: null,
    visibility: 'ready',
    content_markdown: '正文',
    sections: {
      main_questions: 'Q',
      findings: 'F',
      disagreements: 'D',
      reading_priorities: 'R',
    },
    citations: [],
    scope: {
      mode: 'selected',
      contract_version: 'c05-v1',
      includes_exact_versions: true,
      captured_at: '2026-11-05T09:55:00+00:00',
      source_count: 2,
      refs_truncated: false,
      sources: [
        { document_id: 'doc_1', document_version: 'v1', source_id: 'src_1' },
        { document_id: 'doc_2', document_version: 'v1', source_id: 'src_2' },
      ],
      missing_source_ids: [],
      single_source_id: null,
    },
    processing: {
      resolved_mode: 'hybrid_rag',
      evidence_chunk_count: 2,
      citation_count: 1,
      citations_total: 1,
      citations_dropped: 0,
      evidence_modalities: { text: 2, table: 0, figure: 0, mixed: 0 },
      coverage: null,
      included_sources: [
        { document_id: 'doc_1', document_version: 'v1', chunk_count: 2, source_id: 'src_1' },
      ],
      degradations: [],
      degradation_reason: null,
      evidence_degraded: null,
      full_text_read: false,
    },
    model: { model_id: 'm-local', provider_id: 'p_local' },
    purpose: null,
    limitations: ['full_text_not_read'],
    warnings: [],
    ...overrides,
  }
}

let queryClient: QueryClient
let onOpen: Mock<() => void>

function queryWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function renderEntry() {
  return render(<TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} />, {
    wrapper: queryWrapper,
  })
}

/** 用真实 react-query 启一笔同 key 的挂起 mutation，观察「生成中」状态。 */
function GeneratingProbe() {
  const started = useRef(false)
  const mutation = useMutation({
    mutationKey: topicOverviewGenerateMutationKey(PROJECT_ID),
    mutationFn: () => new Promise<void>(() => {}),
  })
  useEffect(() => {
    if (started.current) return
    started.current = true
    void mutation.mutate()
  }, [mutation])
  return null
}

/** 让测试可观测「当前资料列表已载入」，再断言资料变化提示是否渲染。 */
function SourcesProbe() {
  const sourcesQuery = useResearchSources(PROJECT_ID)
  const status = sourcesQuery.data
    ? String(sourcesQuery.data.items.length)
    : sourcesQuery.isError
      ? 'error'
      : sourcesQuery.isLoading
        ? 'loading'
        : 'idle'
  return <output data-testid="sources-probe">{status}</output>
}

function workspaceWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId={PROJECT_ID} role="owner">
        <ResearchJobsProvider>
          <ResearchScopeProvider userId="u1" projectId={PROJECT_ID}>
            {children}
          </ResearchScopeProvider>
        </ResearchJobsProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

/** Admin 只读工作区（MEDIUM-A1：host 端点 Owner 专属，入口必须隐藏）。 */
function adminWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId={PROJECT_ID} role="admin_readonly">
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

function WorkspaceHarness() {
  const [action, setAction] = useState<'research-chat'>('research-chat')
  return (
    <ResearchWorkspace
      activeAction={action}
      onActiveActionChange={(next) => setAction(next as 'research-chat')}
      surfaceActive
      onCitationJump={vi.fn<(sourceId: string, pageIdx: number | null) => void>()}
      onEditScopeAllStates={vi.fn<() => void>()}
    />
  )
}

beforeEach(() => {
  localStorage.clear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  onOpen = vi.fn<() => void>()
  h.capability = false
  h.overviewData = null
  h.isLoading = false
  h.isError = false
  h.error = null
  h.enabledCalls = []
  h.refetch = vi.fn()
  h.listSources.mockReset()
  h.listSources.mockResolvedValue({ items: [source()], next_cursor: null })
  h.listNotes.mockReset()
  h.listNotes.mockResolvedValue({ items: [note], next_cursor: null })
  h.listModels.mockReset()
  h.listModels.mockResolvedValue({ models: [], capabilities: {} })
  h.openResearchChatStream.mockReset()
  h.openResearchChatStream.mockImplementation(() => () => {})
  resetGlobalModelStub()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('F-01：能力位 fail-closed', () => {
  it('capability 非 true → 入口不渲染，且概览读取保持 disabled', () => {
    h.capability = false
    h.overviewData = readyOverview()
    const { container } = renderEntry()

    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('topic-overview-entry')).toBeNull()
    // fail-closed：能力位未 true 时不发概览 GET
    expect(h.enabledCalls.at(-1)).toEqual({ enabled: false })
  })

  it('capability 为 true → 入口渲染', () => {
    h.capability = true
    renderEntry()
    expect(screen.getByTestId('topic-overview-entry')).toBeInTheDocument()
    expect(h.enabledCalls.at(-1)).toEqual({ enabled: true })
  })
})

describe('F-02：入口状态', () => {
  beforeEach(() => {
    h.capability = true
  })

  it('无概览 → 「生成概览」；点击打开 Dialog', () => {
    renderEntry()
    expect(screen.getByTestId('topic-overview-entry-empty')).toHaveTextContent(
      'research.topicOverview.entry.empty',
    )
    const open = screen.getByTestId('topic-overview-entry-open')
    expect(open).toHaveTextContent('research.topicOverview.entry.generate')
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('已有概览 → 「查看概览」+ 范围摘要 + 生成/快照时间', () => {
    h.overviewData = readyOverview()
    renderEntry()
    expect(screen.getByTestId('topic-overview-entry-open')).toHaveTextContent(
      'research.topicOverview.entry.view',
    )
    expect(screen.getByTestId('topic-overview-entry-scope')).toHaveTextContent(
      'research.topicOverview.scopeSummary',
    )
    expect(screen.getByTestId('topic-overview-entry-scope')).toHaveTextContent('"count":2')
    expect(screen.getByTestId('topic-overview-entry-captured')).toHaveTextContent(
      'research.topicOverview.capturedAt',
    )
    expect(screen.getByTestId('topic-overview-entry-generated')).toHaveTextContent(
      'research.topicOverview.generatedAt',
    )
    // 受限概览：入口仍可打开（Dialog 显示受限占位）
    expect(screen.queryByTestId('topic-overview-entry-restricted')).toBeNull()
  })

  it('受限概览 → 入口仍可打开并标出 Restricted', () => {
    h.overviewData = readyOverview({
      visibility: 'restricted',
      content_markdown: null,
      sections: null,
      citations: [],
      limitations: ['content_restricted'],
    })
    renderEntry()
    expect(screen.getByTestId('topic-overview-entry-restricted')).toHaveTextContent(
      'research.topicOverview.entry.restricted',
    )
    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('生成中 → 禁用并显示进行中文案', async () => {
    render(<><TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} /><GeneratingProbe /></>, {
      wrapper: queryWrapper,
    })
    await waitFor(() => {
      const open = screen.getByTestId('topic-overview-entry-open')
      expect(open).toBeDisabled()
      expect(open).toHaveTextContent('research.topicOverview.entry.generating')
    })
  })

  it('读失败 → 内联错误 + 手动重试（不自动重试）', () => {
    h.isError = true
    h.error = new Error('boom')
    renderEntry()

    expect(screen.getByTestId('topic-overview-entry-error')).toHaveTextContent(
      'research.errors.generic',
    )
    expect(h.refetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('topic-overview-entry-retry'))
    expect(h.refetch).toHaveBeenCalledTimes(1)
    // 读失败时不渲染生成/查看按钮（避免把失败当空态）
    expect(screen.queryByTestId('topic-overview-entry-open')).toBeNull()
  })

  it('资料变化 → 只提示计数与范围日期，不自动更新/不改 GET', () => {
    h.overviewData = readyOverview()
    // 当前资料：doc_1 版本变化（v1→v2）、doc_3 新增、doc_2 退役
    h.listSources.mockResolvedValue({
      items: [
        source({ source_id: 'src_1', document_id: 'doc_1', document_version: 'v2' }),
        source({ source_id: 'src_3', document_id: 'doc_3', document_version: 'v1' }),
      ],
      next_cursor: null,
    })
    renderEntry()

    // 资料列表异步载入后才出现变化提示
    return waitFor(() => {
      const notice = screen.getByTestId('topic-overview-entry-changes')
      expect(notice).toHaveTextContent('research.topicOverview.entry.changesNotice')
      expect(notice).toHaveTextContent('"added":1')
      expect(notice).toHaveTextContent('"versionChanged":1')
      expect(notice).toHaveTextContent('"retired":1')
      // 只提示：不自动触发更新/重读、不改 GET 内容
      expect(onOpen).not.toHaveBeenCalled()
      expect(h.refetch).not.toHaveBeenCalled()
    })
  })
})

describe('F-02/F-08 边界：受限概览不渲染资料变化提示', () => {
  it('restricted（scope.sources 按契约恒空）⇒ 不显示资料变化提示；ready ⇒ 仍显示', async () => {
    h.capability = true
    // 当前资料与 ready 概览范围不同：doc_1 版本变化 + doc_3 新增 + doc_2 退役
    h.listSources.mockResolvedValue({
      items: [
        source({ source_id: 'src_1', document_id: 'doc_1', document_version: 'v2' }),
        source({ source_id: 'src_3', document_id: 'doc_3', document_version: 'v1' }),
      ],
      next_cursor: null,
    })
    const base = readyOverview()
    // 1) restricted：wire 按设计 scope.sources=[] —— 若仍比较，会把当前全部
    //    资料误算成 added（视觉证据 LOW）；必须不渲染提示，且既有受限内容仍在。
    h.overviewData = readyOverview({
      visibility: 'restricted',
      content_markdown: null,
      sections: null,
      citations: [],
      scope: { ...base.scope!, sources: [] },
      limitations: ['content_restricted'],
      warnings: ['content_restricted'],
    })
    const boundary = (
      <>
        <TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} />
        <SourcesProbe />
      </>
    )
    const first = render(boundary, { wrapper: queryWrapper })
    const probe = await screen.findByTestId('sources-probe')
    await waitFor(() => expect(probe).toHaveTextContent('2'))
    expect(screen.queryByTestId('topic-overview-entry-changes')).toBeNull()
    expect(screen.getByTestId('topic-overview-entry-restricted')).toBeInTheDocument()
    first.unmount()

    // 2) ready：同一当前资料 → 提示仍按范围快照渲染（added/versionChanged/retired）。
    h.overviewData = readyOverview()
    render(boundary, { wrapper: queryWrapper })
    const changes = await screen.findByTestId('topic-overview-entry-changes')
    expect(changes).toHaveTextContent('research.topicOverview.entry.changesNotice')
    expect(changes).toHaveTextContent('"added":1')
    expect(changes).toHaveTextContent('"versionChanged":1')
    expect(changes).toHaveTextContent('"retired":1')
  })
})

describe('MEDIUM-A1：Admin 只读不渲染入口', () => {
  it('admin_readonly + capability true ⇒ 不渲染且不发起概览 GET；owner ⇒ 渲染', () => {
    h.capability = true
    h.overviewData = readyOverview()

    const admin = render(<TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} />, {
      wrapper: adminWrapper,
    })
    expect(admin.container.firstChild).toBeNull()
    expect(screen.queryByTestId('topic-overview-entry')).toBeNull()
    // Admin 下无意义 GET（必然 403）不发出
    expect(h.enabledCalls.at(-1)).toEqual({ enabled: false })
    admin.unmount()

    renderEntry()
    expect(screen.getByTestId('topic-overview-entry')).toBeInTheDocument()
    expect(h.enabledCalls.at(-1)).toEqual({ enabled: true })
  })
})

describe('MEDIUM-A2/LOW-A1：资料变化提示的数据可信度守卫（Entry）', () => {
  it('sources 加载中（无 data）⇒ 不显示提示（不把 scope 来源误算 retired）', async () => {
    h.capability = true
    h.overviewData = readyOverview()
    h.listSources.mockReturnValue(new Promise(() => {}))
    render(
      <>
        <TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} />
        <SourcesProbe />
      </>,
      { wrapper: queryWrapper },
    )
    await waitFor(() => expect(h.listSources).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('sources-probe')).toHaveTextContent('loading')
    expect(screen.queryByTestId('topic-overview-entry-changes')).toBeNull()
  })

  it('sources 查询失败 ⇒ 不显示提示', async () => {
    h.capability = true
    h.overviewData = readyOverview()
    h.listSources.mockRejectedValue(new Error('sources down'))
    render(
      <>
        <TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} />
        <SourcesProbe />
      </>,
      { wrapper: queryWrapper },
    )
    await waitFor(() =>
      expect(screen.getByTestId('sources-probe')).toHaveTextContent('error'),
    )
    expect(screen.queryByTestId('topic-overview-entry-changes')).toBeNull()
  })

  it('sources 成功但为空数组 ⇒ 不显示提示（不声称全部范围来源退役）', async () => {
    h.capability = true
    h.overviewData = readyOverview()
    h.listSources.mockResolvedValue({ items: [], next_cursor: null })
    render(
      <>
        <TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} />
        <SourcesProbe />
      </>,
      { wrapper: queryWrapper },
    )
    await waitFor(() =>
      expect(screen.getByTestId('sources-probe')).toHaveTextContent('0'),
    )
    expect(screen.queryByTestId('topic-overview-entry-changes')).toBeNull()
  })

  it('scope.refs_truncated=true ⇒ 不做比较、不显示提示（LOW-A1）', async () => {
    h.capability = true
    const base = readyOverview()
    h.overviewData = readyOverview({
      scope: { ...base.scope!, refs_truncated: true },
    })
    h.listSources.mockResolvedValue({
      items: [
        source({ source_id: 'src_1', document_id: 'doc_1', document_version: 'v2' }),
        source({ source_id: 'src_3', document_id: 'doc_3', document_version: 'v1' }),
      ],
      next_cursor: null,
    })
    render(
      <>
        <TopicOverviewEntry projectId={PROJECT_ID} onOpen={onOpen} />
        <SourcesProbe />
      </>,
      { wrapper: queryWrapper },
    )
    await waitFor(() =>
      expect(screen.getByTestId('sources-probe')).toHaveTextContent('2'),
    )
    expect(screen.queryByTestId('topic-overview-entry-changes')).toBeNull()
  })
})

describe('F-02 集成：入口卡不拦截 Chat 输入/发送（可跳过）', () => {
  it('research-chat 分支渲染入口卡，Chat 输入/发送仍可用，未打开 Dialog 时无遮罩', async () => {
    h.capability = true
    h.overviewData = readyOverview()
    render(<WorkspaceHarness />, { wrapper: workspaceWrapper })

    // 入口卡出现在项目开始位置（独立 shrink-0 卡片，非 fixed/absolute 遮罩）
    const entry = await screen.findByTestId('topic-overview-entry')
    expect(entry.className).toContain('shrink-0')
    expect(entry.className).toContain('border-b')
    expect(entry.className).not.toContain('fixed')
    expect(entry.className).not.toContain('absolute')
    // Dialog 未打开 → 不渲染遮罩/内容
    expect(screen.queryByTestId('topic-overview-dialog')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    // Chat 输入仍可用：可输入并发送（入口卡不拦截事件）
    const input = await screen.findByTestId('chat-input')
    fireEvent.change(input, { target: { value: '这批资料讲了什么？' } })
    expect(input).toHaveValue('这批资料讲了什么？')
    fireEvent.click(screen.getByRole('button', { name: 'research.chatSend' }))
    await waitFor(() => expect(h.openResearchChatStream).toHaveBeenCalledTimes(1))
  })
})
