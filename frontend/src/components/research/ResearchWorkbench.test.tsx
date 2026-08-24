import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWorkbench } from './ResearchWorkbench'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
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

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role={role}>
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

/**
 * Issue #182：Workbench 受控化（selectedSourceId/highlightPageIdx 提升到
 * /research 组合层）。测试内复刻 page.tsx 的接线，保持既有用例行为：
 * Citation 跳转 → onSelectSource(source, { highlightPageIdx }) → 详情高亮。
 */
function ControlledWorkbench() {
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [highlightPageIdx, setHighlightPageIdx] = useState<number | null>(null)
  return (
    <ResearchWorkbench
      displayMode="workbench"
      selectedSourceId={selectedSourceId}
      highlightPageIdx={highlightPageIdx}
      onSelectSource={(sourceId, opts) => {
        setSelectedSourceId(sourceId)
        setHighlightPageIdx(opts?.highlightPageIdx ?? null)
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
    render(<ControlledWorkbench />, { wrapper })

    // 打开 Transformations 并运行
    const transTab = screen.getByRole('tab', { name: 'research.workbench.tabTransformations' })
    fireEvent.mouseDown(transTab)
    fireEvent.click(transTab)
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /egress/ }))
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
})
