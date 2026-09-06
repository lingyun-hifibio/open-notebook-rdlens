import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWorkbench } from './ResearchWorkbench'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'

// UI-02 Red：研究工作台容器（REQ-SCOPE-04/REQ-DATA-03/04）——Tabs 面板
// 切换；Admin 只读横幅；Citation 跳转端到端：转换结果 → 跳转到来源
// 内容并定位目标页（highlight）。

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
  createExport: vi.fn(),
  downloadExport: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.page ?? opts.reason ?? '')}` : key,
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

// #243 §6.5/§6.6：工作台内的 Insight/Transformation 面板取用顶层 confirmed
// 全局模型；本文件被测对象不是全局模型本身 → 用测试替身提供快照
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

/** 预置 provider 持久化 Scope（RWV2-12：Transformation 运行共享 Scope）。 */
function seedScope(mode: 'entire_project' | 'selected', sourceIds: string[] = []) {
  localStorage.setItem(
    scopeStorageKey('u1', 'proj_1'),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds: [] }),
  )
}

/**
 * Issue #182：Workbench 受控化（selectedSourceId/highlightPageIdx 提升到
 * /research 组合层）。测试内复刻 page.tsx 的接线，保持既有用例行为：
 * Citation 跳转 → onSelectSource(source, { highlightPageIdx }) → 详情高亮。
 */
function ControlledWorkbench() {
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [highlightPageIdx, setHighlightPageIdx] = useState<number | null>(null)
  const [highlightRequestId, setHighlightRequestId] = useState(0)
  return (
    <ResearchWorkbench
      displayMode="workbench"
      selectedSourceId={selectedSourceId}
      highlightPageIdx={highlightPageIdx}
      highlightRequestId={highlightRequestId}
      onSelectSource={(sourceId, opts) => {
        setSelectedSourceId(sourceId)
        const nextHighlightPageIdx = opts?.highlightPageIdx ?? null
        setHighlightPageIdx(nextHighlightPageIdx)
        if (nextHighlightPageIdx !== null) {
          setHighlightRequestId((requestId) => requestId + 1)
        }
      }}
      onCloseSource={() => {
        setSelectedSourceId(null)
        setHighlightPageIdx(null)
      }}
    />
  )
}

describe('ResearchWorkbench', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    toastMock.mockClear()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('渲染四个 Tabs 并在切换时展示对应面板', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listTransformations).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<ControlledWorkbench />, { wrapper })
    expect(screen.getByRole('tab', { name: 'research.workbench.tabSources' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'research.workbench.tabNotes' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'research.workbench.tabInsights' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'research.workbench.tabTransformations' })).toBeInTheDocument()

    const notesTab = screen.getByRole('tab', { name: 'research.workbench.tabNotes' })
    fireEvent.mouseDown(notesTab)
    fireEvent.click(notesTab)
    await waitFor(() => expect(researchApi.listNotes).toHaveBeenCalledWith('proj_1', {}))
  })

  it('Tabs 容器链带滚动约束（防面板内容超出半屏后叠画到下半屏）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listTransformations).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    const { container } = render(<ControlledWorkbench />, { wrapper })

    // Tabs 根必须是可收缩的 flex-1 子项（否则内容把整棵树撑出半屏容器）
    const tabs = container.querySelector('[data-slot="tabs"]')
    expect(tabs).not.toBeNull()
    expect(tabs).toHaveClass('flex-1', 'min-h-0')

    // 活动 tabpanel 必须是滚动容器：内容超高时在工作台内部滚动，
    // 而不是溢出到下半屏（编辑表单/长列表/来源全文均走此路径）
    const panel = await screen.findByRole('tabpanel')
    expect(panel).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto')

    // 四个面板一致：切换到笔记后约束仍在
    const notesTab = screen.getByRole('tab', { name: 'research.workbench.tabNotes' })
    fireEvent.mouseDown(notesTab)
    fireEvent.click(notesTab)
    const notesPanel = await screen.findByRole('tabpanel')
    expect(notesPanel).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto')
  })

  it('Admin 会话：顶部展示只读横幅（角色来自 Token claims）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper('admin_readonly')
    render(<ControlledWorkbench />, { wrapper })
    expect(screen.getByTestId('admin-readonly-banner')).toBeInTheDocument()
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()
  })

  it('RWV2-13：workbench 渲染唯一 Scope 编辑面；Sources 复选框即时写入 provider 并联动模式单选', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [{ source_id: 'src_1', document_id: 'doc_1', document_version: 'v3', status: 'ready', content_hash: 'h', synced_at: null, last_error: null }],
      next_cursor: null,
    })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listTransformations).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<ControlledWorkbench />, { wrapper })

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

  it('RWV2-13：Notes Tab 复选框同样进入 selected 模式（跨 Tab 单一编辑面）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({
      items: [{ note_id: 'note_1', project_id: 'proj_1', title: '第一篇', content: '正文', note_type: 'human', created_at: null, updated_at: null }],
      next_cursor: null,
    })
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listTransformations).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<ControlledWorkbench />, { wrapper })

    const notesTab = screen.getByRole('tab', { name: 'research.workbench.tabNotes' })
    fireEvent.mouseDown(notesTab)
    fireEvent.click(notesTab)
    fireEvent.click(await screen.findByTestId('note-scope-note_1'))
    expect(screen.getByTestId('scope-selected')).toHaveAttribute('data-state', 'checked')
  })

  it.each([1024, 1280, 1440, 1920])(
    'RWV2-13：%ipx 桌面视口下左侧编辑面与行复选框无横向溢出设计（min-w-0/flex-wrap）',
    async (width) => {
      // 记录受测视口：jsdom 不做像素布局，宽度用于标注 AC 视口集合与
      // 类契约锁定（min-w-0/flex-wrap 是防横向溢出的设计证据）
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
      vi.mocked(researchApi.listSources).mockResolvedValue({
        items: [
          { source_id: 'src_1', document_id: 'doc_1', document_version: 'v3', status: 'ready', content_hash: 'h', synced_at: null, last_error: null },
          { source_id: 'src_2', document_id: 'doc_2', document_version: 'v1', status: 'ready', content_hash: 'h', synced_at: null, last_error: null },
        ],
        next_cursor: null,
      })
      vi.mocked(researchApi.listNotes).mockResolvedValue({
        items: [{ note_id: 'note_1', project_id: 'proj_1', title: '第一篇', content: '正文', note_type: 'human', created_at: null, updated_at: null }],
        next_cursor: null,
      })
      vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
      vi.mocked(researchApi.listTransformations).mockResolvedValue({ items: [], next_cursor: null })
      // 最小左栏宽度 280px（分隔条最窄位置）仍不隐藏标题/不横向溢出
      const { wrapper } = makeWrapper()
      render(<ControlledWorkbench />, { wrapper })

      const editor = screen.getByTestId('research-scope-editor')
      expect(editor).toHaveClass('min-w-0')
      const radioGroup = editor.querySelector('[role="radiogroup"]') ?? editor.querySelector('[data-slot="radio-group"]')
      expect(radioGroup).toHaveClass('flex-wrap')

      const sourceCheckbox = await screen.findByTestId('source-scope-src_1')
      expect(sourceCheckbox).toBeInTheDocument()
      const rows = screen.getByTestId('source-list-rows')
      // 每行：复选框 shrink-0 + 标题 min-w-0（长标题截断不推挤兄弟节点）
      const rowItems = within(rows).getAllByRole('listitem')
      expect(rowItems).toHaveLength(2)
      for (const row of rowItems) {
        expect(row.querySelector('[data-slot="checkbox"]')).not.toBeNull()
      }
      expect(within(rowItems[0]).getByText('doc_1')).toBeInTheDocument()
    },
  )

  it('Source 专注模式对同页 Citation 的每次请求都重新聚焦详情标题，且不重挂载', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.getSource).mockResolvedValue({
      source_id: 'src_1', document_id: 'doc_1', document_version: 'v3', status: 'ready', content_hash: null,
      synced_at: null, last_error: null, title: 'Paper A', markdown_chunks: [],
    })
    const { wrapper } = makeWrapper()
    const { rerender } = render(
      <ResearchWorkbench
        displayMode="source-focus"
        selectedSourceId="src_1"
        highlightPageIdx={2}
        highlightRequestId={1}
        onSelectSource={vi.fn()}
        onCloseSource={vi.fn()}
      />,
      { wrapper },
    )
    // #243 §6.2：工作台标题已上移到 /research 顶层 header，此处只断言
    // 详情标题被聚焦
    const detailHeading = await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(document.activeElement).toBe(detailHeading))

    const backButton = screen.getByRole('button', { name: 'research.sources.back' })
    backButton.focus()
    expect(document.activeElement).toBe(backButton)

    rerender(
      <ResearchWorkbench
        displayMode="source-focus"
        selectedSourceId="src_1"
        highlightPageIdx={2}
        highlightRequestId={2}
        onSelectSource={vi.fn()}
        onCloseSource={vi.fn()}
      />,
    )

    // 同一节点 = 未重挂载
    expect(screen.getByRole('heading', { name: 'Paper A' })).toBe(detailHeading)
    await waitFor(() => expect(document.activeElement).toBe(detailHeading))
  })

  it('Citation 跳转端到端：转换结果 → 点击跳转 → Sources 面板定位目标页（page_idx+1 展示）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [{
        source_id: 'src_1',
        document_id: 'doc_1',
        document_version: 'v3',
        status: 'ready',
        content_hash: 'h',
        synced_at: null,
        last_error: null,
      }],
      next_cursor: null,
    })
    vi.mocked(researchApi.getSource).mockResolvedValue({
      source_id: 'src_1',
      document_id: 'doc_1',
      document_version: 'v3',
      status: 'ready',
      content_hash: 'h',
      synced_at: null,
      last_error: null,
      title: 'Paper A',
      markdown_chunks: [{ chunk_id: 'chunk_3', page_idx: 3, markdown: '第四章内容' }],
    })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [{
        transformation_id: 'trans_1',
        project_id: 'proj_1',
        name: '总结模板',
        prompt_template: '请总结：',
        model_id: 'qwen3.6',
        scope: 'project_private',
        created_at: null,
      }],
      next_cursor: null,
    })
    vi.mocked(researchApi.runTransformation).mockResolvedValue({
      request_id: 'req_1',
      transformation_id: 'trans_1',
      requires_job: false,
      degradation_reason: null,
      result_id: 'r_1',
      model_id: 'qwen3.6',
      source_refs: ['src_1'],
      usage: { input_tokens: 1, output_tokens: 1 },
      citations: [{
        citation_id: 'c_1',
        claim: '引用声明',
        chunk_id: 'chunk_3',
        doc_id: 'doc_1',
        doc_version: 'v3',
        page_idx: 3,
        section: null,
        original_text: '引用原文',
        citation_type: null,
        confidence: null,
        doc_display_name: 'Paper A',
        short_name: 'A',
        doc_type: 'pdf',
        project_id: 'proj_1',
        vlm_bboxes: null,
        minio_uri: null,
        source_path: null,
      }],
      output: '总结输出',
    })

    const { wrapper } = makeWrapper()
    seedScope('selected', ['src_1'])
    render(<ControlledWorkbench />, { wrapper })

    // 打开 Transformations 并运行（RWV2-12：scope 来自共享 provider 快照）
    const transTab = screen.getByRole('tab', { name: 'research.workbench.tabTransformations' })
    fireEvent.mouseDown(transTab)
    fireEvent.click(transTab)
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    // RWV2-12：对话框只读展示当前 Scope 摘要（无局部选择复选框）
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    // checkbox 断言限定在对话框内，避免文档级断言被背景面板破坏
    expect(
      within(screen.getByRole('dialog')).queryByRole('checkbox'),
    ).toBeNull()
    // #243 §6.6：外发确认不再是面板局部复选框（统一由顶层守卫处理）
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() => expect(screen.getByText('总结输出')).toBeInTheDocument())
    expect(screen.getByText('引用原文')).toBeInTheDocument()

    // 点击跳转：来源 ready + 版本一致 + 有页码 → 跳转按钮存在
    fireEvent.click(screen.getByRole('button', { name: 'research.citation.jump' }))

    // 工作台切到 Sources 面板并定位目标页（page_idx 3 → 展示第 4 页）
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'research.workbench.tabSources' })).toHaveAttribute(
        'data-state',
        'active',
      )
    })
    const highlighted = screen.getByTestId('chunk-highlight')
    expect(highlighted).toBeInTheDocument()
    expect(screen.getByText(/research.sources.chunkPage:4/)).toBeInTheDocument()
  })

  it('RWV2-12：运行对话框 Edit scope 仅关闭对话框，不重置全局 Scope', async () => {
    seedScope('selected', ['src_1'])
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [{
        transformation_id: 'trans_1',
        project_id: 'proj_1',
        name: '总结模板',
        prompt_template: '请总结：',
        model_id: 'qwen3.6',
        scope: 'project_private',
        created_at: null,
      }],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(<ControlledWorkbench />, { wrapper })

    const transTab = screen.getByRole('tab', { name: 'research.workbench.tabTransformations' })
    fireEvent.mouseDown(transTab)
    fireEvent.click(transTab)
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-scope-summary')).toHaveTextContent('selectedSummary'),
    )
    // Edit scope：关闭对话框；全局 Scope 保持不变
    fireEvent.click(screen.getByTestId('run-edit-scope'))
    await waitFor(() => expect(screen.queryByTestId('run-scope-summary')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-scope-summary')).toHaveTextContent('selectedSummary'),
    )
  })
})
