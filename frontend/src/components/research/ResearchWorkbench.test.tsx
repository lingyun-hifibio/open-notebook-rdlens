import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWorkbench } from './ResearchWorkbench'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import type { ResearchNote, ResearchSource, ResearchSourceDetail } from '@/lib/types/research'

// RWV2-40 分组 IA（#44）Red：左栏 Workbench 不再使用 Radix Tabs 平铺四
// 键——AdminReadOnlyBanner + ResearchScopeEditor（唯一编辑面）+ 分组导航
// （Materials: Sources/Notes；Results: Insights/Transformation runs；
// Tools: Research templates 跨区命令）+ 单一子视图内容区；Source 专注视图
// 由 focusedSourceId 驱动（Back/onExitSourceFocus + SourceDetailPanel）。

vi.mock('@/lib/research/api', () => ({
  listSources: vi.fn(),
  getSource: vi.fn(),
  listNotes: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  listInsights: vi.fn(),
  createInsight: vi.fn(),
  listTransformations: vi.fn(),
  createTransformation: vi.fn(),
  runTransformation: vi.fn(),
  listTransformationResults: vi.fn(),
  getTransformationResult: vi.fn(),
  createExport: vi.fn(),
  downloadExport: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

// Insights 面板取用顶层全局模型（automock 提供默认 stub）；本文件被测对象
// 不是全局模型本身
vi.mock('@/lib/hooks/use-research-global-model')

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId="proj_1" role={role}>
        <ResearchScopeProvider userId="u1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

/** 预置 provider 持久化 Scope（RWV2-12/13：Sources/Notes 复选框共享）。 */
function seedScope(mode: 'entire_project' | 'selected', sourceIds: string[] = [], noteIds: string[] = []) {
  localStorage.setItem(
    scopeStorageKey('u1', 'proj_1'),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds }),
  )
}

function renderWorkbench(
  overrides: Partial<Parameters<typeof ResearchWorkbench>[0]> = {},
  role: 'owner' | 'admin_readonly' = 'owner',
) {
  const { wrapper } = makeWrapper(role)
  const props = {
    focusedSourceId: null,
    highlightPageIdx: null,
    highlightRequestId: 0,
    researchTemplatesActive: false,
    onOpenSource: vi.fn(),
    onExitSourceFocus: vi.fn(),
    onOpenResearchTemplates: vi.fn(),
    ...overrides,
  }
  const utils = render(<ResearchWorkbench {...props} />, { wrapper })
  return { ...utils, props }
}

const source = (overrides: Partial<ResearchSource> = {}): ResearchSource => ({
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: 'h',
  synced_at: null,
  last_error: null,
  ...overrides,
})

const sourceDetail = (overrides: Partial<ResearchSourceDetail> = {}): ResearchSourceDetail => ({
  ...source(overrides),
  title: 'Paper A',
  markdown_chunks: [],
})

const note = (overrides: Partial<ResearchNote> = {}): ResearchNote => ({
  note_id: 'note_1',
  project_id: 'proj_1',
  title: '第一篇',
  content: '正文',
  note_type: 'human',
  created_at: null,
  updated_at: null,
  ...overrides,
})

describe('ResearchWorkbench', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    toastMock.mockClear()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('分组导航：三个 group heading 可见；默认 Sources 子视图渲染 SourceListPanel（复选框可达）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    const { props } = renderWorkbench()

    // 三个 group heading（语义化文案 key）
    expect(screen.getByText('research.workbench.groupMaterials')).toBeInTheDocument()
    expect(screen.getByText('research.workbench.groupResults')).toBeInTheDocument()
    expect(screen.getByText('research.workbench.groupTools')).toBeInTheDocument()

    // 默认子视图 = Sources：SourceListPanel 行复选框可达
    const checkbox = await screen.findByTestId('source-scope-src_1')
    expect(checkbox).toBeInTheDocument()

    // 分组子项按钮存在（Sources/Notes/Insights/Transformation runs）
    expect(
      screen.getByRole('button', { name: 'research.workbench.tabNotes' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'research.workbench.tabInsights' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'research.workbench.tabRuns' }),
    ).toBeInTheDocument()

    // 未触发 open/退出
    expect(props.onOpenSource).not.toHaveBeenCalled()
    expect(props.onExitSourceFocus).not.toHaveBeenCalled()
  })

  it('分组导航：Sources 行内 open 触发 onOpenSource（组合根进入 Source focus）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    const { props } = renderWorkbench()
    const row = (await screen.findByTestId('source-scope-src_1')).closest('li')
    expect(row).not.toBeNull()
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'research.sources.open' }))
    expect(props.onOpenSource).toHaveBeenCalledWith('src_1')
  })

  it('RWV2-13：唯一 Scope 编辑面渲染；Sources 复选框写入 provider 并联动模式单选；切回 entire 清空', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    renderWorkbench()

    // 唯一编辑面：左栏顶部 Scope 编辑块 + 模式单选（首次显式 Entire project）
    const editor = screen.getByTestId('research-scope-editor')
    expect(editor).toBeInTheDocument()
    expect(screen.getByTestId('scope-entire-project')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('scope-selected')).toBeDisabled()

    // 行首复选框选择来源 → provider 进入 selected，编辑面单选联动
    fireEvent.click(await screen.findByTestId('source-scope-src_1'))
    expect(screen.getByTestId('scope-selected')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('source-scope-src_1')).toHaveAttribute('data-state', 'checked')

    // 切回 Entire project → 选择清空（provider 单一真源，观察者全部同步）
    fireEvent.click(screen.getByTestId('scope-entire-project'))
    expect(screen.getByTestId('scope-entire-project')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('source-scope-src_1')).not.toHaveAttribute('data-state', 'checked')
  })

  it('RWV2-13：Materials 内 Notes 子视图复选框同样进入 selected（同组切换，单一编辑面）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    renderWorkbench()

    // Materials 组内切换到 Notes 子视图
    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.tabNotes' }))
    fireEvent.click(await screen.findByTestId('note-scope-note_1'))
    expect(screen.getByTestId('scope-selected')).toHaveAttribute('data-state', 'checked')
  })

  it('RWV2-13：Edit scope 请求聚焦左栏编辑面（scopeEditRequest 递增 → 模式单选获得焦点）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    const baseProps = {
      focusedSourceId: null,
      highlightPageIdx: null,
      highlightRequestId: 0,
      researchTemplatesActive: false,
      onOpenSource: vi.fn(),
      onExitSourceFocus: vi.fn(),
      onOpenResearchTemplates: vi.fn(),
    }
    const { rerender } = render(<ResearchWorkbench {...baseProps} />, { wrapper })
    expect(screen.getByTestId('scope-entire-project')).not.toHaveFocus()
    // 传 0（初始挂载序号）不得抢焦点（复审 N1）
    rerender(<ResearchWorkbench {...baseProps} scopeEditRequest={0} />)
    expect(screen.getByTestId('scope-entire-project')).not.toHaveFocus()
    // 明确的编辑请求（≥1）才聚焦
    rerender(<ResearchWorkbench {...baseProps} scopeEditRequest={1} />)
    expect(screen.getByTestId('scope-entire-project')).toHaveFocus()
  })

  it('RWV2-13：跨来源/笔记合计的最后一项不可取消（provider + UI 禁用一致）', async () => {
    seedScope('selected', ['src_1'])
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    renderWorkbench()

    // 合计 1 项（src_1）：该来源复选框禁用；note 复选框可加入（合计 >1）
    const sourceCheckbox = await screen.findByTestId('source-scope-src_1')
    expect(sourceCheckbox).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.tabNotes' }))
    const noteCheckbox = await screen.findByTestId('note-scope-note_1')
    expect(noteCheckbox).not.toBeDisabled()
    fireEvent.click(noteCheckbox)

    // 加入 note 后合计 2：回到 Sources，来源复选框重新可用
    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.tabSources' }))
    await waitFor(() =>
      expect(screen.getByTestId('source-scope-src_1')).not.toBeDisabled(),
    )
  })

  it('Admin 会话：顶部只读横幅；Admin 仍可勾选 Scope（本地过滤语义，非写操作）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    renderWorkbench({}, 'admin_readonly')
    expect(screen.getByTestId('admin-readonly-banner')).toBeInTheDocument()
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()

    // Admin 勾选（scope 为本地选择状态）→ selected 模式联动
    fireEvent.click(await screen.findByTestId('source-scope-src_1'))
    expect(screen.getByTestId('scope-selected')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('source-scope-src_1')).toHaveAttribute('data-state', 'checked')
  })

  it('Tools：Research templates 为跨区命令按钮；点击触发 onOpenResearchTemplates；active 态呈现 aria-current', () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    const { rerender, props } = renderWorkbench()
    const templateButton = screen.getByRole('button', { name: 'research.workbench.tabTemplates' })
    expect(templateButton).not.toHaveAttribute('aria-current')
    fireEvent.click(templateButton)
    expect(props.onOpenResearchTemplates).toHaveBeenCalledTimes(1)

    // researchTemplatesActive=true（主区 Run Template 激活）→ 可见 active 态
    rerender(
      <ResearchWorkbench
        focusedSourceId={null}
        highlightPageIdx={null}
        highlightRequestId={0}
        researchTemplatesActive
        onOpenSource={props.onOpenSource}
        onExitSourceFocus={props.onExitSourceFocus}
        onOpenResearchTemplates={props.onOpenResearchTemplates}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'research.workbench.tabTemplates' }),
    ).toHaveAttribute('aria-current', 'true')
  })

  it('Results：Insights 子视图渲染 InsightsPanel（切换后查询其列表）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    renderWorkbench()
    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.tabInsights' }))
    await waitFor(() => expect(researchApi.listInsights).toHaveBeenCalled())
    // 面板空态文案（hook 数据到达后）
    expect(await screen.findByText('research.insights.empty')).toBeInTheDocument()
  })

  it('Results：Transformation runs 插槽——传入 transformationRuns 时渲染插槽内容', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    renderWorkbench({
      transformationRuns: <div data-testid="runs-slot">runs history content</div>,
    })
    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.tabRuns' }))
    expect(await screen.findByTestId('runs-slot')).toBeInTheDocument()
    // 插槽覆盖时不挂载默认 RunsPanel
    expect(researchApi.listTransformationResults).not.toHaveBeenCalled()
  })

  it('Results：Transformation runs 未传插槽时默认挂载 #48 TransformationRunsPanel', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listTransformationResults).mockResolvedValue({ items: [], next_cursor: null })
    renderWorkbench()
    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.tabRuns' }))
    // #48 durable runs 面板挂载（列表查询发出；无结果 → empty 文案，不伪装历史）
    await waitFor(() =>
      expect(researchApi.listTransformationResults).toHaveBeenCalled(),
    )
  })

  it('Source 专注：focusedSourceId 非 null 只渲染专注视图（Back + SourceDetailPanel），不含分组 IA', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue(sourceDetail())
    renderWorkbench({
      focusedSourceId: 'src_1',
      highlightPageIdx: 2,
      highlightRequestId: 1,
    })

    // 其它 IA 内容不渲染
    expect(screen.queryByTestId('research-scope-editor')).toBeNull()
    expect(screen.queryByTestId('admin-readonly-banner')).toBeNull()
    expect(screen.queryByText('research.workbench.groupMaterials')).toBeNull()

    // #243 §6.2：详情标题被聚焦
    const detailHeading = await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(document.activeElement).toBe(detailHeading))

    const backButton = screen.getByRole('button', { name: 'research.sources.back' })
    backButton.focus()
    expect(document.activeElement).toBe(backButton)
    expect(screen.getByRole('button', { name: 'research.sources.back' })).toBeTruthy()
  })

  it('Source 专注：highlightRequestId 递增 → 同一 heading 节点再次获焦、不重挂载', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue(sourceDetail())
    const { wrapper } = makeWrapper()
    const base = {
      focusedSourceId: 'src_1' as const,
      highlightPageIdx: 2 as number | null,
      researchTemplatesActive: false,
      onOpenSource: vi.fn(),
      onExitSourceFocus: vi.fn(),
      onOpenResearchTemplates: vi.fn(),
    }
    const { rerender } = render(<ResearchWorkbench {...base} highlightRequestId={1} />, {
      wrapper,
    })
    const detailHeading = await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(document.activeElement).toBe(detailHeading))

    rerender(<ResearchWorkbench {...base} highlightRequestId={2} />)

    // 同一节点 = 未重挂载；新序号重新聚焦
    expect(screen.getByRole('heading', { name: 'Paper A' })).toBe(detailHeading)
    await waitFor(() => expect(document.activeElement).toBe(detailHeading))
  })

  it('窄栏类契约（简化）：唯一编辑面 min-w-0 + 单选 flex-wrap；不随视图切换丢失编辑面', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    renderWorkbench()

    const editor = screen.getByTestId('research-scope-editor')
    expect(editor).toHaveClass('min-w-0')
    const radioGroup =
      editor.querySelector('[role="radiogroup"]') ?? editor.querySelector('[data-slot="radio-group"]')
    expect(radioGroup).toHaveClass('flex-wrap')

    // 切到 Notes 子视图后编辑面仍在（唯一编辑面不随子视图消失）
    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.tabNotes' }))
    await screen.findByTestId('note-scope-note_1')
    expect(screen.getByTestId('research-scope-editor')).toBeInTheDocument()
    expect(screen.getByTestId('scope-entire-project')).toBeInTheDocument()
  })
})
