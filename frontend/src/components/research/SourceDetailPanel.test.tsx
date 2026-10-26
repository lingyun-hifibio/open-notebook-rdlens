import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SourceDetailPanel } from './SourceDetailPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'

// UI-02 Red：来源内容面板（REQ-SRC-04/REQ-DATA-04，契约 §6）——规范
// Markdown chunks 按阅读顺序展示，页码标记展示 page_idx+1；404/内容不可用
// 时展示降级态（Citation 原文由卡片保留）。

vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  listSources: vi.fn(),
  getSource: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.page ?? '')}` : key,
  }),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))


// PR-4 修复轮（N3）：来源正文锚点接线——用可控 mock 的 runtime/editor 证明
// 「只读身份匹配才写」与「切来源/卸载前 flush('position')」。
const sourceAnchorMocks = vi.hoisted(() => {
  const editor = {
    snapshot: { readerAnchor: null, positionUnavailable: false },
    controller: null,
    transportWired: false,
    setDraftText: vi.fn(),
    setScope: vi.fn(),
    setChatAnchor: vi.fn(),
    setReaderAnchor: vi.fn(),
    flush: vi.fn(),
    hold: vi.fn(),
    release: vi.fn(),
    retrySave: vi.fn(),
    adoptServerVersion: vi.fn(),
    saveLocalOverServer: vi.fn(),
    clearAfterSubmission: vi.fn(),
    markTokenConsumed: vi.fn(),
    canSubmit: () => ({ allowed: false, reason: 'not_loaded' as const }),
    restoreDraft: vi.fn(),
    refreshDraftCandidates: vi.fn(),
    releaseDocument: vi.fn(),
  }
  return {
    editor,
    setReaderAnchor: editor.setReaderAnchor,
    flush: editor.flush,
    useRuntimeOptional: vi.fn(() => null as unknown),
    useEditor: vi.fn(() => editor),
  }
})

vi.mock('@/lib/hooks/research-session-runtime', () => ({
  useResearchSessionRuntimeOptional: sourceAnchorMocks.useRuntimeOptional,
}))

vi.mock('@/lib/hooks/use-research-editor', () => ({
  useResearchEditor: sourceAnchorMocks.useEditor,
}))

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner">
        <ResearchScopeProvider userId="u1" projectId="proj_1">
        {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('SourceDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染标题、状态与按阅读顺序排列的 markdown chunks（页码标记 page_idx+1）', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue({
      source_id: 'src_1',
      document_id: 'doc_1',
      document_version: 'v3',
      status: 'ready',
      content_hash: 'h',
      synced_at: null,
      last_error: null,
      title: 'Paper A',
      markdown_chunks: [
        { chunk_id: 'chunk_0', page_idx: 0, markdown: '第一章内容' },
        { chunk_id: 'chunk_3', page_idx: 3, markdown: '第四章内容' },
      ],
    })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('Paper A')).toBeInTheDocument()
      const marks = screen.getAllByTestId('markdown').map((node) => node.textContent)
      expect(marks.join('|')).toContain('第一章内容')
      expect(marks.join('|')).toContain('第四章内容')
      // 页码标记：page_idx 0 → 第 1 页；page_idx 3 → 第 4 页
      expect(screen.getByText(/research.sources.chunkPage:1/)).toBeInTheDocument()
      expect(screen.getByText(/research.sources.chunkPage:4/)).toBeInTheDocument()
    })
  })

  it('highlightPageIdx 命中 chunk 时标记高亮（Citation 跳转定位）', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue({
      source_id: 'src_1',
      document_id: 'doc_1',
      document_version: 'v3',
      status: 'ready',
      content_hash: 'h',
      synced_at: null,
      last_error: null,
      title: 'Paper A',
      markdown_chunks: [
        { chunk_id: 'chunk_3', page_idx: 3, markdown: '第四章内容' },
      ],
    })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={3} />, { wrapper })
    await waitFor(() => {
      expect(screen.getByTestId('markdown')).toHaveTextContent('第四章内容')
    })
    const highlighted = screen.getByTestId('chunk-highlight')
    expect(highlighted).toBeInTheDocument()
  })

  it('数据渲染后聚焦真实详情标题，并为同页的每次请求重新聚焦且不重挂载', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue({
      source_id: 'src_1',
      document_id: 'doc_1',
      document_version: 'v3',
      status: 'ready',
      content_hash: 'h',
      synced_at: null,
      last_error: null,
      title: 'Paper A',
      markdown_chunks: [
        { chunk_id: 'chunk_3', page_idx: 3, markdown: '第四章内容' },
      ],
    })
    const { wrapper } = makeWrapper()
    const { rerender } = render(
      <SourceDetailPanel sourceId="src_1" highlightPageIdx={3} focusRequestId={1} />,
      { wrapper },
    )

    const detailHeading = await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(document.activeElement).toBe(detailHeading))

    detailHeading.blur()
    expect(document.activeElement).not.toBe(detailHeading)
    rerender(
      <SourceDetailPanel sourceId="src_1" highlightPageIdx={3} focusRequestId={2} />,
    )

    expect(screen.getByRole('heading', { name: 'Paper A' })).toBe(detailHeading)
    await waitFor(() => expect(document.activeElement).toBe(detailHeading))
  })

  it('内容不可用（404）→ 展示降级态，不崩溃', async () => {
    vi.mocked(researchApi.getSource).mockRejectedValue({ response: { status: 404 } })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_gone" />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('research.workbench.loadFailed')).toBeInTheDocument()
    })
  })
})

describe('SourceDetailPanel · PR-4 来源锚点接线（N3/F3）', () => {
  const sourcePayload = {
    source_id: 'src_1',
    document_id: 'doc_1',
    document_version: 'v3',
    status: 'ready',
    content_hash: 'h',
    synced_at: null,
    last_error: null,
    title: 'Paper A',
    markdown_chunks: [
      { chunk_id: 'chunk_1', page_idx: 1, markdown: '第一章内容' },
    ],
  }

  beforeEach(() => {
    vi.useRealTimers()
    sourceAnchorMocks.setReaderAnchor.mockClear()
    sourceAnchorMocks.flush.mockClear()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockClear()
    vi.mocked(researchApi.getSource).mockResolvedValue(sourcePayload as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('active source 身份不匹配时不写 reader_anchor', async () => {
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue({
      active: (surface: string) =>
        surface === 'source' ? { sessionId: 'sess-s', sourceId: 'src_other' } : null,
    })
    const { wrapper } = makeWrapper()
    const { container, unmount } = render(
      <div className="overflow-y-auto">
        <SourceDetailPanel sourceId="src_1" />
      </div>,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    vi.useFakeTimers()
    const scrollParent = container.querySelector('.overflow-y-auto') as HTMLElement
    fireEvent.scroll(scrollParent)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(sourceAnchorMocks.setReaderAnchor).not.toHaveBeenCalled()
    vi.useRealTimers()
    unmount()
    expect(sourceAnchorMocks.flush).not.toHaveBeenCalled()
    expect(sourceAnchorMocks.useEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    )
  })

  it('F3 切来源 <1000ms：离开前同步测量新位置，先写锚点再 flush(position)', async () => {
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue({
      active: (surface: string) =>
        surface === 'source' ? { sessionId: 'sess-s', sourceId: 'src_1' } : null,
    })
    const { wrapper } = makeWrapper()
    const { container, rerender } = render(
      <div className="overflow-y-auto">
        <SourceDetailPanel sourceId="src_1" />
      </div>,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    // 让恢复流程的 restoringRef 归零（restore 用 setTimeout(0) 解除抑制）。
    await new Promise(resolve => setTimeout(resolve, 10))
    vi.useFakeTimers()
    const scrollParent = container.querySelector('.overflow-y-auto') as HTMLElement
    const rect = (top: number, height = 0) => ({
      top, bottom: top + height, left: 0, right: 0, width: 0, height,
      x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect
    Object.defineProperty(scrollParent, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scrollParent, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(scrollParent, 'scrollTop', { configurable: true, writable: true, value: 0 })
    scrollParent.getBoundingClientRect = () => rect(0)
    const chunkNode = container.querySelector('[data-chunk-id]') as HTMLElement
    chunkNode.getBoundingClientRect = () => rect(80, 40)
    fireEvent.scroll(scrollParent)
    // 下一帧（16ms 节流）先测量；用户随后（<1000ms）切来源也不会丢位置。
    act(() => {
      vi.advanceTimersByTime(16)
    })
    // 不足 1000ms 即切来源：位置已在 editor 内，cleanup 负责 flush 不丢。
    rerender(
      <div className="overflow-y-auto">
        <SourceDetailPanel sourceId="src_2" />
      </div>,
    )
    expect(sourceAnchorMocks.setReaderAnchor).toHaveBeenCalledTimes(1)
    expect(sourceAnchorMocks.flush).toHaveBeenCalledWith('position')
    expect(sourceAnchorMocks.setReaderAnchor.mock.invocationCallOrder[0]).toBeLessThan(
      sourceAnchorMocks.flush.mock.invocationCallOrder[0],
    )
    vi.useRealTimers()
  })

  it('active source 身份匹配：滚动空闲后写锚点，卸载前 flush(position)', async () => {
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue({
      active: (surface: string) =>
        surface === 'source' ? { sessionId: 'sess-s', sourceId: 'src_1' } : null,
    })
    const { wrapper } = makeWrapper()
    const { container, unmount } = render(
      <div className="overflow-y-auto">
        <SourceDetailPanel sourceId="src_1" />
      </div>,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(sourceAnchorMocks.useEditor).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, sourceId: 'src_1' }),
    )
    vi.useFakeTimers()
    const scrollParent = container.querySelector('.overflow-y-auto') as HTMLElement
    const rect = (top: number, height = 0) => ({
      top, bottom: top + height, left: 0, right: 0, width: 0, height,
      x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect
    Object.defineProperty(scrollParent, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scrollParent, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(scrollParent, 'scrollTop', { configurable: true, writable: true, value: 0 })
    scrollParent.getBoundingClientRect = () => rect(0)
    const chunkNode = container.querySelector('[data-chunk-id]') as HTMLElement
    chunkNode.getBoundingClientRect = () => rect(120, 40)
    fireEvent.scroll(scrollParent)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(sourceAnchorMocks.setReaderAnchor).toHaveBeenCalledTimes(1)
    expect(sourceAnchorMocks.setReaderAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'src_1',
        documentId: 'doc_1',
        documentVersion: 'v3',
        contentHash: 'h',
      }),
    )
    unmount()
    vi.useRealTimers()
    expect(sourceAnchorMocks.flush).toHaveBeenCalledWith('position')
  })
})
