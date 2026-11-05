import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SourceDetailPanel } from './SourceDetailPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'

// UI-02 Red：来源内容面板（REQ-SRC-04/REQ-DATA-04，契约 §6）——规范
// Markdown chunks 按阅读顺序展示，页码标记展示 page_idx+1；404/内容不可用
// 时展示降级态（Citation 原文由卡片保留）。

vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  listSources: vi.fn(),
  getSource: vi.fn(),
  // Issue #1013 F04：选段能力来自 GET /models（与 useResearchC05 同 query key）。
  listModels: vi.fn(),
  // Issue #1011 F04/F06：来源媒体读路径（页图/原文件 blob；§2.8）。
  getSourcePageImage: vi.fn(),
  getSourceFile: vi.fn(),
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
  const CHUNK_HASH = 'a'.repeat(64)
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
      {
        chunk_id: 'chunk_1',
        chunk_ordinal: 1,
        content_hash: CHUNK_HASH,
        page_idx: 1,
        markdown: '第一章内容',
      },
    ],
  }

  beforeEach(() => {
    vi.useRealTimers()
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [],
      capabilities: {},
    } as never)
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
    // Issue #1013 §2.10：锚点 content_hash 必须取逐 chunk hash（不是来源级 'h'）。
    expect(sourceAnchorMocks.setReaderAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'src_1',
        documentId: 'doc_1',
        documentVersion: 'v3',
        chunkOrdinal: 1,
        contentHash: CHUNK_HASH,
      }),
    )
    unmount()
    vi.useRealTimers()
    expect(sourceAnchorMocks.flush).toHaveBeenCalledWith('position')
  })
})


// ---------------------------------------------------------------------------
// Issue #1013（D1-E-2）F03/F04：选段浮层、能力 fail-closed、逐 chunk 锚点、
// 返回原回答入口、选段回跳高亮
// ---------------------------------------------------------------------------

const D1E_CAPABILITY = {
  'd1e_roundtrip': { contract: 'd1e-roundtrip-v1', enabled: true },
}
const PER_CHUNK_HASH = 'b'.repeat(64)
const SELECTION_SOURCE = {
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready' as const,
  content_hash: 'source-level-hash',
  synced_at: null,
  last_error: null,
  title: 'Paper A',
  markdown_chunks: [
    {
      chunk_id: 'chunk_sel',
      chunk_ordinal: 3,
      content_hash: PER_CHUNK_HASH,
      page_idx: 2,
      markdown: 'alpha beta gamma',
    },
  ],
}

function textNodeUnder(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text
  for (const child of Array.from(node.childNodes)) {
    const found = textNodeUnder(child)
    if (found !== null) return found
  }
  return null
}

function selectRange(container: HTMLElement, start: number, end: number): void {
  // chunk 内还有页码标签文本节点：选区必须落在正文 markdown 容器里。
  const markdown = container.querySelector('[data-chunk-id] [data-testid="markdown"]')
  const node = markdown === null ? null : textNodeUnder(markdown)
  if (node === null) throw new Error('no text node')
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup'))
  })
}

function selectionPanelWrapper() {
  const { wrapper } = makeWrapper()
  return { wrapper }
}

describe('SourceDetailPanel · Issue #1013 F04 能力 fail-closed', () => {
  beforeEach(() => {
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    vi.mocked(researchApi.getSource).mockResolvedValue(SELECTION_SOURCE as never)
  })

  it('capability 缺失/畸形/false → 选段 UI 不出现（且不产生 gate/锚点副作用）', async () => {
    for (const capabilities of [
      {},
      { 'd1e_roundtrip': { contract: 'c05-v1', enabled: true } },
      { 'd1e_roundtrip': { contract: 'd1e-roundtrip-v1', enabled: false } },
      { 'd1e_roundtrip': { contract: 'd1e-roundtrip-v1', enabled: 'true' } },
    ]) {
      vi.mocked(researchApi.listModels).mockResolvedValue({ models: [], capabilities } as never)
      const { wrapper } = selectionPanelWrapper()
      const onDiscuss = vi.fn()
      const view = render(
        <SourceDetailPanel sourceId="src_1" onDiscussSelection={onDiscuss} />,
        { wrapper },
      )
      await screen.findByRole('heading', { name: 'Paper A' })
      await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
      await act(async () => {
        await Promise.resolve()
      })
      selectRange(view.container, 6, 10)
      await waitFor(() => {
        expect(screen.queryByTestId('source-selection-discuss')).toBeNull()
      })
      expect(onDiscuss).not.toHaveBeenCalled()
      view.unmount()
      window.getSelection()?.removeAllRanges()
    }
  })

  it('capability=true → 选择文本出现「讨论选段」；点击回调携带逐 chunk 身份的 11 键选段', async () => {
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [],
      capabilities: D1E_CAPABILITY,
    } as never)
    const { wrapper } = selectionPanelWrapper()
    const onDiscuss = vi.fn()
    const view = render(
      <SourceDetailPanel sourceId="src_1" onDiscussSelection={onDiscuss} />,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
    // 能力查询解析后 handler 才安装：在 waitFor 内重复派发选区事件。
    await waitFor(() => {
      selectRange(view.container, 6, 10) // "beta"
      expect(screen.queryByTestId('source-selection-discuss')).not.toBeNull()
    })
    const action = screen.getByTestId('source-selection-discuss')
    fireEvent.click(action)
    expect(onDiscuss).toHaveBeenCalledTimes(1)
    expect(onDiscuss.mock.calls[0][0]).toMatchObject({
      sourceId: 'src_1',
      sourceTitle: 'Paper A',
      pageIdx: 2,
      chunkOrdinal: 3,
      selection: {
        sourceId: 'src_1',
        documentId: 'doc_1',
        documentVersion: 'v3',
        chunkId: 'chunk_sel',
        chunkOrdinal: 3,
        pageIdx: 2,
        startOffset: 6,
        endOffset: 10,
        quote: 'beta',
        contentHash: PER_CHUNK_HASH,
      },
    })
    expect(onDiscuss.mock.calls[0][0].selection.quoteHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('响应缺逐 chunk content_hash → 不产生选段（capture failed 提示，不造伪身份）', async () => {
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [],
      capabilities: D1E_CAPABILITY,
    } as never)
    vi.mocked(researchApi.getSource).mockResolvedValue({
      ...SELECTION_SOURCE,
      markdown_chunks: [
        { chunk_id: 'chunk_sel', chunk_ordinal: 3, page_idx: 2, markdown: 'alpha beta gamma' },
      ],
    } as never)
    const { wrapper } = selectionPanelWrapper()
    const onDiscuss = vi.fn()
    const view = render(
      <SourceDetailPanel sourceId="src_1" onDiscussSelection={onDiscuss} />,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
    await waitFor(() => {
      selectRange(view.container, 6, 10)
      expect(screen.queryByTestId('source-selection-capture-failed')).not.toBeNull()
    })
    expect(screen.queryByTestId('source-selection-discuss')).toBeNull()
    expect(onDiscuss).not.toHaveBeenCalled()
  })
})

describe('SourceDetailPanel · Issue #1013 返回原回答 / 选段高亮 / 撤权状态', () => {
  beforeEach(() => {
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    vi.mocked(researchApi.getSource).mockResolvedValue(SELECTION_SOURCE as never)
    vi.mocked(researchApi.listModels).mockResolvedValue({ models: [], capabilities: {} } as never)
  })

  it('returnTargetAvailable → 头部出现「返回原回答」，点击回调切换到目标 message', async () => {
    const { wrapper } = selectionPanelWrapper()
    const onReturn = vi.fn()
    render(
      <SourceDetailPanel
        sourceId="src_1"
        returnTargetAvailable
        onReturnToAnswer={onReturn}
      />,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    const button = await screen.findByTestId('source-return-to-answer')
    fireEvent.click(button)
    expect(onReturn).toHaveBeenCalledTimes(1)
  })

  it('returnUnavailable → 显示 position_unavailable 文案（不跳最新）', async () => {
    const { wrapper } = selectionPanelWrapper()
    render(<SourceDetailPanel sourceId="src_1" returnUnavailable />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(screen.getByTestId('source-return-unavailable')).toBeInTheDocument()
  })

  it('highlightSelection（visible）→ 命中 chunk 高亮（data-testid=selection-highlight）', async () => {
    const { wrapper } = selectionPanelWrapper()
    render(
      <SourceDetailPanel
        sourceId="src_1"
        highlightSelection={{
          sourceId: 'src_1',
          documentId: 'doc_1',
          documentVersion: 'v3',
          chunkId: 'chunk_sel',
          chunkOrdinal: 3,
          pageIdx: 2,
          startOffset: 6,
          endOffset: 10,
          quote: 'beta',
          quoteHash: 'c'.repeat(64),
          contentHash: PER_CHUNK_HASH,
          visibility: 'visible',
          reasonCode: null,
        }}
      />,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    await screen.findByTestId('selection-highlight')
  })

  it('highlightSelection（逐 chunk hash 不符）→ position_unavailable 文案，不伪造高亮', async () => {
    const { wrapper } = selectionPanelWrapper()
    render(
      <SourceDetailPanel
        sourceId="src_1"
        highlightSelection={{
          sourceId: 'src_1',
          documentId: 'doc_1',
          documentVersion: 'v3',
          chunkId: 'chunk_sel',
          chunkOrdinal: 3,
          pageIdx: 2,
          startOffset: 6,
          endOffset: 10,
          quote: 'beta',
          quoteHash: 'c'.repeat(64),
          contentHash: 'd'.repeat(64),
          visibility: 'visible',
          reasonCode: null,
        }}
      />,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    await screen.findByTestId('source-selection-unavailable')
    expect(screen.queryByTestId('selection-highlight')).toBeNull()
  })

  it('撤权/版本错误：410/422 稳定码分别显示可解释文案', async () => {
    vi.mocked(researchApi.getSource).mockRejectedValue({
      response: { status: 410, data: { detail: { code: 'source_access_restricted', message: 'x' } } },
    })
    const { wrapper } = selectionPanelWrapper()
    const view = render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByTestId('source-detail-error')
    expect(screen.getByTestId('source-detail-error-source_access_restricted')).toBeInTheDocument()
    view.unmount()

    vi.mocked(researchApi.getSource).mockRejectedValue({
      response: { status: 422, data: { detail: { code: 'source_ref_mismatch', message: 'x' } } },
    })
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByTestId('source-detail-error')
    expect(screen.getByTestId('source-detail-error-source_ref_mismatch')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Issue #1011（D1-E 主单）F03–F08：声明格式 badge / 打开原文件（下载）/
// 页图区（仅引用定位页）/ 图表不可读声明 / §2.10 媒体重试矩阵 /
// 能力与字段 fail-closed；以及 Source focus 与会话单篇限定分离
// （不渲染 source-ask-only、不写 scope、只读 pin 提示）。
//
// 固定 hooks（与 fork-visual harness 对齐，勿改）：
//   source-format-badge / source-open-file / source-page-image /
//   source-page-image-img / source-media-error / source-media-restricted /
//   source-media-retry / source-figure-unavailable / source-ask-only(absent)
// ---------------------------------------------------------------------------

const D1E_READY_CAPABILITY = {
  'd1e_roundtrip': { contract: 'd1e-roundtrip-v1', enabled: true },
}

const MEDIA_SOURCE = {
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready' as const,
  content_hash: 'h',
  synced_at: null,
  last_error: null,
  title: 'Paper A',
  source_type: 'pdf',
  file_available: true,
  markdown_chunks: [
    { chunk_id: 'chunk_2', chunk_ordinal: 2, content_hash: 'a'.repeat(64), page_idx: 2, markdown: 'page three content' },
  ],
}

function mediaSource(overrides: Record<string, unknown> = {}) {
  return { ...MEDIA_SOURCE, ...overrides }
}

function d1eReady() {
  vi.mocked(researchApi.listModels).mockResolvedValue({
    models: [],
    capabilities: D1E_READY_CAPABILITY,
  } as never)
  vi.mocked(researchApi.getSource).mockResolvedValue(mediaSource() as never)
}

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

function stubObjectUrls(): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> } {
  const create = vi.fn(() => 'blob:mock-object-url')
  const revoke = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke })
  return { create, revoke }
}

function restoreObjectUrls(): void {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: originalCreateObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: originalRevokeObjectURL,
  })
}

function blobResponse(): Blob {
  return new Blob(['jpeg-bytes'], { type: 'image/jpeg' })
}

function mediaFailure(status: number, code: string | null, detail: string | null) {
  return Promise.reject({ status, code, detail })
}

describe('SourceDetailPanel · Issue #1011 F03 单篇限定分离（不渲染 source-ask-only / 不写 scope）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    stubObjectUrls()
    d1eReady()
  })
  afterEach(() => {
    restoreObjectUrls()
  })

  it('不渲染 source-ask-only 操作控件；只读 pin 提示显示当前会话限定（无操作按钮）', async () => {
    const { wrapper } = makeWrapper()
    // 先经会话 Scope 编辑面同款入口设置限定（模拟 ResearchScopeEditor 的 setSingle）
    function ScopeSetter() {
      const { setSingle } = useResearchScope()
      return (
        <button type="button" data-testid="test-set-pin" onClick={() => setSingle('src_1', 'sess_1')}>
          set
        </button>
      )
    }
    render(
      <>
        <ScopeSetter />
        <SourceDetailPanel sourceId="src_1" />
      </>,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    // 未限定：无任何会话范围操作
    expect(screen.queryByTestId('source-ask-only')).toBeNull()
    expect(screen.queryByTestId('source-single-pin-hint')).toBeNull()

    fireEvent.click(screen.getByTestId('test-set-pin'))
    const hint = await screen.findByTestId('source-single-pin-hint')
    expect(hint).toHaveTextContent('research.layout.scope.singleActive')
    // 只读提示：内部没有按钮（不可在来源面板取消/设置限定）
    expect(hint.querySelector('button')).toBeNull()
    // 仍无 source-ask-only
    expect(screen.queryByTestId('source-ask-only')).toBeNull()
  })

  it('面板挂载/卸载/交互不改变 scope provider 快照（I1/I2：进出 source focus 不写 scope）', async () => {
    const { wrapper } = makeWrapper()
    let snapshotBefore: unknown = null
    let snapshotAfter: unknown = null
    function ScopeProbe({ which }: { which: 'before' | 'after' }) {
      const { getSnapshot } = useResearchScope()
      if (which === 'before') snapshotBefore = getSnapshot()
      else snapshotAfter = getSnapshot()
      return null
    }
    const view = render(
      <>
        <ScopeProbe which="before" />
        <SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />
        <ScopeProbe which="after" />
      </>,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.getSourcePageImage).toHaveBeenCalled())
    expect(snapshotAfter).toEqual(snapshotBefore)
    view.unmount()

    // 具名限定存在时卸载也不得清除（SourceDetailPanel 不调用 clearSingle）
    const second = makeWrapper()
    function ScopeSetter() {
      const { setSingle, getSnapshot } = useResearchScope()
      return (
        <button
          type="button"
          data-testid="test-set-pin"
          onClick={() => {
            setSingle('src_9', 'sess_9')
            window.sessionStorage.setItem('probe-snap', JSON.stringify(getSnapshot()))
          }}
        >
          set
        </button>
      )
    }
    const view2 = render(
      <>
        <ScopeSetter />
        <SourceDetailPanel sourceId="src_1" />
      </>,
      { wrapper: second.wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    fireEvent.click(screen.getByTestId('test-set-pin'))
    view2.unmount()
    expect(JSON.parse(window.sessionStorage.getItem('probe-snap') ?? '{}')).toMatchObject({
      singleSourceId: 'src_9',
    })
  })
})

describe('SourceDetailPanel · Issue #1011 F08 能力/字段 fail-closed（保持 pin 基线 UI）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    stubObjectUrls()
  })
  afterEach(() => {
    restoreObjectUrls()
  })

  it('D1-E 能力缺失（/models 无能力键）→ 不显示格式 badge/打开原文件/页图，chunk 保持旧标签', async () => {
    vi.mocked(researchApi.listModels).mockResolvedValue({ models: [], capabilities: {} } as never)
    vi.mocked(researchApi.getSource).mockResolvedValue(mediaSource() as never)
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
    expect(screen.queryByTestId('source-format-badge')).toBeNull()
    expect(screen.queryByTestId('source-open-file')).toBeNull()
    expect(screen.queryByTestId('source-page-image')).toBeNull()
    expect(screen.getByText(/research.sources.chunkPage:3/)).toBeInTheDocument()
    expect(researchApi.getSourcePageImage).not.toHaveBeenCalled()
  })

  it('旧 host：source_type/file_available 缺失 → 不显示任何新媒体/格式 UI（逐字节基线语义）', async () => {
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [],
      capabilities: D1E_READY_CAPABILITY,
    } as never)
    const legacy = mediaSource()
    delete (legacy as Record<string, unknown>).source_type
    delete (legacy as Record<string, unknown>).file_available
    vi.mocked(researchApi.getSource).mockResolvedValue(legacy as never)
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
    expect(screen.queryByTestId('source-format-badge')).toBeNull()
    expect(screen.queryByTestId('source-open-file')).toBeNull()
    expect(screen.queryByTestId('source-page-image')).toBeNull()
    expect(screen.getByText(/research.sources.chunkPage:3/)).toBeInTheDocument()
    expect(screen.getByTestId('markdown')).toHaveTextContent('page three content')
  })

  it('能力就绪 + source_type=pdf + file_available 缺失 → 只显示声明格式 UI，不显示打开原文件', async () => {
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [],
      capabilities: D1E_READY_CAPABILITY,
    } as never)
    const detail = mediaSource()
    delete (detail as Record<string, unknown>).file_available
    vi.mocked(researchApi.getSource).mockResolvedValue(detail as never)
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(screen.getByTestId('source-format-badge')).toHaveTextContent(
      'research.source.formatPdf',
    )
    expect(screen.queryByTestId('source-open-file')).toBeNull()
  })

  it('能力就绪但 source_type 缺失（file_available=true）→ 不显示打开原文件（F08/NORMATIVE 17 收紧）', async () => {
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [],
      capabilities: D1E_READY_CAPABILITY,
    } as never)
    const detail = mediaSource({ file_available: true })
    delete (detail as Record<string, unknown>).source_type
    vi.mocked(researchApi.getSource).mockResolvedValue(detail as never)
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
    // 格式字段缺失 → 媒体 UI 整体 fail-closed（即使 file_available=true）
    expect(screen.queryByTestId('source-open-file')).toBeNull()
    expect(screen.queryByTestId('source-format-badge')).toBeNull()
    expect(screen.queryByTestId('source-page-image')).toBeNull()
    expect(researchApi.getSourceFile).not.toHaveBeenCalled()
  })
})

describe('SourceDetailPanel · Issue #1011 F04 页图（仅引用定位页自动加载 / blob 释放）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    stubObjectUrls()
    d1eReady()
  })
  afterEach(() => {
    restoreObjectUrls()
  })

  it('citation 跳转 highlightPageIdx → 自动加载对应 0-based 页并渲染 blob 图', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockResolvedValue(blobResponse())
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await screen.findByTestId('source-page-image-img')
    expect(researchApi.getSourcePageImage).toHaveBeenCalledWith(
      'proj_1',
      'src_1',
      2,
      { documentId: 'doc_1', documentVersion: 'v3' },
    )
    expect(screen.getByTestId('source-page-image-img')).toHaveAttribute(
      'src',
      'blob:mock-object-url',
    )
    // 页图区是 region，img 只在页图区内
    expect(screen.getByTestId('source-page-image').contains(
      screen.getByTestId('source-page-image-img'),
    )).toBe(true)
  })

  it('无 citation 定位页时不自动请求；点击页图入口才请求首个 chunk 页', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockResolvedValue(blobResponse())
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(researchApi.getSourcePageImage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('source-page-image-load'))
    await screen.findByTestId('source-page-image-img')
    expect(researchApi.getSourcePageImage).toHaveBeenCalledWith(
      'proj_1',
      'src_1',
      2,
      { documentId: 'doc_1', documentVersion: 'v3' },
    )
  })

  it('对象 URL 在卸载时释放；页图加载失败不阻塞来源正文/返回入口', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockResolvedValue(blobResponse())
    const { wrapper } = makeWrapper()
    const view = render(
      <SourceDetailPanel sourceId="src_1" highlightPageIdx={2} returnTargetAvailable onReturnToAnswer={vi.fn()} />,
      { wrapper },
    )
    await screen.findByTestId('source-page-image-img')
    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it('ppt 使用 slide 页图入口文案；xlsx 不显示页图区（sheet 级 + 打开原文件）', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockResolvedValue(blobResponse())
    const { wrapper } = makeWrapper()
    vi.mocked(researchApi.getSource).mockResolvedValue(mediaSource({ source_type: 'ppt' }) as never)
    const pptView = render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(screen.getByTestId('source-page-image-load')).toHaveTextContent(
      'research.source.slideImage',
    )
    pptView.unmount()

    const { wrapper: xlsxWrapper } = makeWrapper()
    vi.mocked(researchApi.getSource).mockResolvedValue(
      mediaSource({ source_type: 'xlsx' }) as never,
    )
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper: xlsxWrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(screen.queryByTestId('source-page-image')).toBeNull()
    expect(researchApi.getSourcePageImage).not.toHaveBeenCalled()
    expect(screen.getByTestId('source-format-badge')).toHaveTextContent(
      'research.source.formatXlsx',
    )
    expect(screen.getByTestId('source-open-file')).toBeInTheDocument()
  })
})

describe('SourceDetailPanel · Issue #1011 F05 媒体错误矩阵（§2.10）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    stubObjectUrls()
    d1eReady()
  })
  afterEach(() => {
    restoreObjectUrls()
  })

  it('410 envelope source_access_restricted → 显示不可访问，且不提供重试', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      mediaFailure(410, 'source_access_restricted', null),
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await screen.findByTestId('source-media-restricted')
    expect(screen.getByTestId('source-media-error')).toHaveTextContent(
      'research.errors.sourceAccessRestricted',
    )
    expect(screen.queryByTestId('source-media-retry')).toBeNull()
    expect(screen.queryByTestId('source-page-image-img')).toBeNull()
    // 无自动循环：一次请求就停
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(1)
  })

  it('非 envelope 410 不得显示为撤权（按可重试普通失败处理）', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      mediaFailure(410, null, null),
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByTestId('source-media-retryable')
    expect(screen.queryByTestId('source-media-restricted')).toBeNull()
    expect(screen.getByTestId('source-media-retry')).toBeInTheDocument()
  })

  it('unsupported 404 → 提示该格式无页图 + 打开原文件入口（不重试）', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      mediaFailure(404, null, 'Preview not supported for xlsx; open source file directly'),
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByTestId('source-media-unsupported')
    expect(screen.getByTestId('source-media-error')).toHaveTextContent(
      'research.source.pageImageNotSupported',
    )
    expect(screen.queryByTestId('source-media-retry')).toBeNull()
    // 打开原文件入口（未限定在 header 时仍可用）
    expect(screen.getAllByTestId('source-open-file').length).toBeGreaterThanOrEqual(1)
  })

  it('非 envelope 404（位置/文件不可用）→ 手动重试一次；持续失败后停止重试', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      mediaFailure(404, null, 'Page source file is not available'),
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByTestId('source-media-unavailable')
    const retry = screen.getByTestId('source-media-retry')
    fireEvent.click(retry)
    await waitFor(() => expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('source-media-retry')).toBeNull())
    expect(screen.getByTestId('source-media-unavailable')).toHaveTextContent(
      'research.source.pageImageUnavailable',
    )
  })

  it('authority 行竞态缺失（404 纯 detail "Source not found"）→ 无 UI 重试按钮', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      mediaFailure(404, null, 'Source not found'),
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByTestId('source-media-source-unavailable')
    expect(screen.queryByTestId('source-media-retry')).toBeNull()
    expect(screen.getByTestId('source-media-source-unavailable')).toHaveTextContent(
      'research.source.pageImageSourceUnavailable',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(1)
  })

  it('503 envelope → 失败 + 重试；点击重试成功后替换为页图（无自动循环）', async () => {
    vi.mocked(researchApi.getSourcePageImage)
      .mockImplementationOnce(() => mediaFailure(503, 'session_store_unavailable', null))
      .mockResolvedValueOnce(blobResponse())
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByTestId('source-media-retryable')
    expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('source-media-retry'))
    await screen.findByTestId('source-page-image-img')
    expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(2)
  })

  it('网络错误（无 response）→ 可重试；页图失败不影响标题/返回原回答入口', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      Promise.reject(new Error('Network Error')),
    )
    const { wrapper } = makeWrapper()
    render(
      <SourceDetailPanel sourceId="src_1" highlightPageIdx={2} returnTargetAvailable onReturnToAnswer={vi.fn()} />,
      { wrapper },
    )
    await screen.findByTestId('source-media-retryable')
    expect(screen.getByTestId('source-media-retry')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Paper A' })).toBeInTheDocument()
    expect(screen.getByTestId('source-return-to-answer')).toBeInTheDocument()
  })

  it('来源详情加载失败 → 错误块提供「重试」refetch（410 撤权不提供）', async () => {
    vi.mocked(researchApi.getSource).mockRejectedValueOnce({
      response: { status: 503 },
    } as never)
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByTestId('source-detail-error')
    fireEvent.click(screen.getByTestId('source-detail-retry'))
    await screen.findByRole('heading', { name: 'Paper A' })

    vi.mocked(researchApi.getSource).mockRejectedValue({
      response: {
        status: 410,
        data: { detail: { code: 'source_access_restricted', message: 'x' } },
      },
    } as never)
    const { wrapper: revokedWrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper: revokedWrapper })
    await screen.findByTestId('source-detail-error')
    expect(screen.queryByTestId('source-detail-retry')).toBeNull()
  })
})

describe('SourceDetailPanel · Issue #1011 F06 打开原文件（blob + 下载，PDF 不 inline）', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>
  let anchorClickSpy: ReturnType<typeof vi.spyOn>
  let createElementSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetAllMocks()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    stubObjectUrls()
    d1eReady()
    windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    createElementSpy = vi.spyOn(document, 'createElement')
  })
  afterEach(() => {
    restoreObjectUrls()
    windowOpenSpy.mockRestore()
    anchorClickSpy.mockRestore()
    createElementSpy.mockRestore()
  })

  it('所有格式均 blob + <a download>：文件名来自 Content-Disposition，不 window.open/新标签页', async () => {
    vi.mocked(researchApi.getSourceFile).mockResolvedValue({
      blob: new Blob(['pdf-bytes'], { type: 'application/pdf' }),
      filename: 'B05 paper.pdf',
    })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    fireEvent.click(screen.getByTestId('source-open-file'))
    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalledTimes(1))
    expect(researchApi.getSourceFile).toHaveBeenCalledWith('proj_1', 'src_1', {
      documentId: 'doc_1',
      documentVersion: 'v3',
    })
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(windowOpenSpy).not.toHaveBeenCalled()

    // 实现 click 后即移除 anchor（避免 DOM 残留）：从 createElement 捕获实例。
    const createdAnchors = createElementSpy.mock.results
      .map((result: { value: unknown }) => result.value as HTMLElement)
      .filter((element: HTMLElement) => element.tagName === 'A')
    expect(createdAnchors.length).toBeGreaterThanOrEqual(1)
    expect(createdAnchors[0].getAttribute('download')).toBe('B05 paper.pdf')
    // PDF 也走下载（不 inline 声明/新标签页）
    expect(createdAnchors[0].getAttribute('target')).toBeNull()
  })

  it('打开原文件非 envelope 404（Source file is not available）→ 不可用 + 仅一次手动重试，再失败停止', async () => {
    vi.mocked(researchApi.getSourceFile).mockRejectedValue({
      status: 404,
      code: null,
      detail: 'Source file is not available',
    })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    fireEvent.click(screen.getByTestId('source-open-file'))
    // §2.10：非 envelope 404 = 位置/文件不可用（不是撤权）
    expect(await screen.findByTestId('source-file-unavailable')).toHaveTextContent(
      'research.source.pageImageUnavailable',
    )
    expect(screen.getByTestId('source-open-file-error')).toBeInTheDocument()
    expect(screen.queryByTestId('source-file-restricted')).toBeNull()
    expect(anchorClickSpy).not.toHaveBeenCalled()

    // 手动重试一次；再次失败 → 停止提供重试
    fireEvent.click(screen.getByTestId('source-file-retry'))
    await waitFor(() => expect(researchApi.getSourceFile).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByTestId('source-file-retry')).toBeNull())
    expect(screen.getByTestId('source-file-unavailable')).toBeInTheDocument()
    expect(anchorClickSpy).not.toHaveBeenCalled()
  })

  it('打开原文件 410 envelope 撤权 → 显示不可访问、无重试、隐藏打开原文件入口', async () => {
    vi.mocked(researchApi.getSourceFile).mockRejectedValue({
      status: 410,
      code: 'source_access_restricted',
      detail: null,
    })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    fireEvent.click(screen.getByTestId('source-open-file'))
    expect(await screen.findByTestId('source-file-restricted')).toHaveTextContent(
      'research.errors.sourceAccessRestricted',
    )
    // 撤权不提供重试，并隐藏媒体控件（open-file 按钮）
    expect(screen.queryByTestId('source-file-retry')).toBeNull()
    expect(screen.queryByTestId('source-open-file')).toBeNull()
    expect(anchorClickSpy).not.toHaveBeenCalled()
  })

  it('打开原文件 503 envelope store unavailable → 错误 + 重试；重试成功后下载（无自动循环）', async () => {
    vi.mocked(researchApi.getSourceFile)
      .mockRejectedValueOnce({ status: 503, code: 'session_store_unavailable', detail: null })
      .mockResolvedValueOnce({
        blob: new Blob(['pdf-bytes'], { type: 'application/pdf' }),
        filename: 'retry-ok.pdf',
      })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    fireEvent.click(screen.getByTestId('source-open-file'))
    expect(await screen.findByTestId('source-open-file-error')).toHaveTextContent(
      'research.source.openOriginalFailed',
    )
    expect(researchApi.getSourceFile).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('source-file-retry'))
    await waitFor(() => expect(anchorClickSpy).toHaveBeenCalledTimes(1))
    expect(researchApi.getSourceFile).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByTestId('source-open-file-error')).toBeNull())
    // 只做用户点击的单次重试：无自动循环
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(researchApi.getSourceFile).toHaveBeenCalledTimes(2)
  })

  it('打开原文件网络错误（无 response）→ 可重试（用户点击，单次）', async () => {
    vi.mocked(researchApi.getSourceFile).mockRejectedValue(new Error('Network Error'))
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    fireEvent.click(screen.getByTestId('source-open-file'))
    expect(await screen.findByTestId('source-open-file-error')).toHaveTextContent(
      'research.source.openOriginalFailed',
    )
    expect(screen.getByTestId('source-file-retry')).toBeInTheDocument()
    expect(anchorClickSpy).not.toHaveBeenCalled()
  })

  it('file_available=false → 不显示打开原文件入口', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue(
      mediaSource({ file_available: false }) as never,
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(screen.queryByTestId('source-open-file')).toBeNull()
    expect(researchApi.getSourceFile).not.toHaveBeenCalled()
  })
})

describe('SourceDetailPanel · Issue #1011 F07 图表不可读声明（诚实声明，不标已验证）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    stubObjectUrls()
    d1eReady()
  })
  afterEach(() => {
    restoreObjectUrls()
  })

  it('figure/image chunk（含 image_description 标记）→ 可见声明 + 打开原文件入口', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue(
      mediaSource({
        markdown_chunks: [
          {
            chunk_id: 'chunk_fig',
            chunk_ordinal: 0,
            content_hash: 'c'.repeat(64),
            page_idx: 4,
            markdown: 'Figure: overall survival\n<!-- image_description -->',
          },
          {
            chunk_id: 'chunk_text',
            chunk_ordinal: 1,
            content_hash: 'd'.repeat(64),
            page_idx: 5,
            markdown: 'ordinary paragraph',
          },
        ],
      }) as never,
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    const statement = await screen.findByTestId('source-figure-unavailable')
    expect(statement).toHaveTextContent('research.source.figureUnavailable')
    // 声明落在 figure chunk section 内
    const figureSection = statement.closest('[data-chunk-id]')
    expect(figureSection?.getAttribute('data-chunk-id')).toBe('chunk_fig')
    // 打开原文件入口在声明内（header 之外）
    expect(statement.querySelector('[data-testid="source-open-file"]')).not.toBeNull()
    // 普通 chunk 不显示声明
    const textSection = document.querySelector('[data-chunk-id="chunk_text"]')
    expect(textSection?.querySelector('[data-testid="source-figure-unavailable"]')).toBeNull()
    // 不得标为已验证
    expect(statement.textContent ?? '').not.toMatch(/verified|verification/i)
  })

  it('能力缺失（d1e off）→ 不显示图表声明（fail-closed 保持旧 UI）', async () => {
    vi.mocked(researchApi.listModels).mockResolvedValue({ models: [], capabilities: {} } as never)
    vi.mocked(researchApi.getSource).mockResolvedValue(
      mediaSource({
        markdown_chunks: [
          {
            chunk_id: 'chunk_fig',
            chunk_ordinal: 0,
            content_hash: 'c'.repeat(64),
            page_idx: 4,
            markdown: 'Figure\n<!-- image_description -->',
          },
        ],
      }) as never,
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
    expect(screen.queryByTestId('source-figure-unavailable')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Issue #1011 PR #115 Reviewer A round-1 MEDIUM 修复（红→绿）。
// MEDIUM-1：in-flight 页图请求在卸载后 resolve 不得再创建对象 URL / 写状态。
// MEDIUM-2：页图 410 撤权必须隐藏所有「打开原文件」入口（header/figure/unsupported
//           fallback 共用一个 flag）。
// MEDIUM-3：highlightPageIdx 数字→null 时定位页变化必须重置页图状态，避免
//           标签（新定位页）与图片（旧页）不一致。
// ---------------------------------------------------------------------------

describe('SourceDetailPanel · PR #115 MEDIUM 修复（round 1）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    sourceAnchorMocks.useRuntimeOptional.mockReturnValue(null)
    sourceAnchorMocks.useEditor.mockReturnValue(sourceAnchorMocks.editor as never)
    stubObjectUrls()
    d1eReady()
  })
  afterEach(() => {
    restoreObjectUrls()
  })

  it('MEDIUM-1：页图请求 in-flight 时卸载 → resolve 后不再创建对象 URL（不写已卸载组件）', async () => {
    let resolveBlob: ((blob: Blob) => void) | null = null
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(
      () => new Promise<Blob>((resolve) => {
        resolveBlob = resolve
      }),
    )
    const { wrapper } = makeWrapper()
    const view = render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(1))
    expect(resolveBlob).not.toBeNull()

    // 卸载发生在请求 resolve 之前：cleanup 必须 bump request id 使 inflight 早退。
    view.unmount()
    await act(async () => {
      resolveBlob?.(blobResponse())
      await Promise.resolve()
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('MEDIUM-2：页图 410 撤权 → 隐藏 header/figure 的全部打开原文件入口，仅保留 restricted 文案、无重试', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      mediaFailure(410, 'source_access_restricted', null),
    )
    vi.mocked(researchApi.getSource).mockResolvedValue(
      mediaSource({
        markdown_chunks: [
          {
            chunk_id: 'chunk_fig',
            chunk_ordinal: 0,
            content_hash: 'c'.repeat(64),
            page_idx: 2,
            markdown: 'Figure\n<!-- image_description -->',
          },
        ],
      }) as never,
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    expect(await screen.findByTestId('source-media-restricted')).toBeInTheDocument()
    // header + figure chunk + unsupported fallback 共用一个 canShowOpenFile flag
    expect(screen.queryAllByTestId('source-open-file')).toHaveLength(0)
    // 图表声明仍在（诚实声明不依赖媒体控件），但声明内无 open-file 入口
    const statement = screen.getByTestId('source-figure-unavailable')
    expect(statement.querySelector('[data-testid="source-open-file"]')).toBeNull()
    expect(screen.queryByTestId('source-file-retry')).toBeNull()
  })

  it('MEDIUM-2：无 figure chunk 时页图 410 同样隐藏 header 打开原文件入口', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockImplementation(() =>
      mediaFailure(410, 'source_access_restricted', null),
    )
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={2} />, { wrapper })
    await screen.findByRole('heading', { name: 'Paper A' })
    await screen.findByTestId('source-media-restricted')
    expect(screen.queryAllByTestId('source-open-file')).toHaveLength(0)
  })

  it('MEDIUM-3：highlightPageIdx 数字→null → 旧页图不残留，回到页图入口且标签为定位页', async () => {
    vi.mocked(researchApi.getSourcePageImage).mockResolvedValue(blobResponse())
    const { wrapper } = makeWrapper()
    const { rerender } = render(
      <SourceDetailPanel sourceId="src_1" highlightPageIdx={0} />,
      { wrapper },
    )
    await screen.findByTestId('source-page-image-img')
    expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)

    rerender(<SourceDetailPanel sourceId="src_1" highlightPageIdx={null} />)
    // 旧页图（page 0）被丢弃：不残留 img，回到 load 按钮（定位页 = 首个 chunk 页 2 → page 3）
    await waitFor(() => expect(screen.queryByTestId('source-page-image-img')).toBeNull())
    const load = await screen.findByTestId('source-page-image-load')
    expect(load).toHaveTextContent('research.source.pageImage:3')
    // 旧对象 URL 释放；不因重置而自动重新请求（数字→null 不再自动加载）
    expect(URL.revokeObjectURL).toHaveBeenCalled()
    expect(researchApi.getSourcePageImage).toHaveBeenCalledTimes(1)
  })
})
