import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UseSourceMediaResult } from '@/lib/hooks/use-source-media'
import type { ResearchChunk, ResearchSourceDetail } from '@/lib/types/research'
import { sourceReaderRequest } from './target-reader-state'
import { TargetReaderBody } from './TargetReaderBody'

// W2 #1077：宽屏阅读器正文列（UI 规格 v1 §5.7；合并计划 §2.4/§2.5/§2.9/
// §2.10-6/7/10）。被测边界：状态优先级/页导航有界/兜底 chunk 排除/无正文块
// 提示/图表提示/选段载荷。数据拉取在 use-source-media（本文件用替身）。

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.page ?? '')}` : key,
  }),
}))

// MarkdownRenderer 依赖 window.matchMedia/SyntaxHighlighter；本文件只关心
// 文本选择与状态，用平面文本替身（与 SourceDetailPanel.test 同约定）。
vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

const HEX64 = 'a'.repeat(64)

function makeChunk(overrides: Partial<ResearchChunk> = {}): ResearchChunk {
  return {
    chunk_id: 'chunk_1',
    page_idx: 0,
    markdown: 'Alpha beta gamma.',
    chunk_ordinal: 0,
    content_hash: HEX64,
    ...overrides,
  }
}

function makeDetail(overrides: Partial<ResearchSourceDetail> = {}): ResearchSourceDetail {
  return {
    source_id: 'src_1',
    document_id: 'doc_1',
    document_version: 'v1',
    status: 'ready',
    content_hash: null,
    synced_at: null,
    last_error: null,
    title: 'Source title',
    markdown_chunks: [],
    source_type: 'pdf',
    file_available: true,
    ...overrides,
  }
}

function makeMedia(overrides: Partial<UseSourceMediaResult> = {}): UseSourceMediaResult {
  return {
    detail: makeDetail(),
    detailStatus: 'ready',
    detailFailure: null,
    retryDetail: vi.fn(),
    versionState: { kind: 'latest' },
    sourceType: 'pdf',
    pages: [0],
    pageImage: { status: 'idle', url: null, failure: null },
    retryPageImage: vi.fn(),
    file: { status: 'idle', failure: null },
    openFile: vi.fn(),
    ...overrides,
  }
}

const request = sourceReaderRequest({ sourceId: 'src_1' })

function renderBody(options: {
  media?: UseSourceMediaResult
  pageIdx?: number | null
  pages?: number[]
  request?: typeof request
} = {}) {
  const media = options.media ?? makeMedia()
  const onSelectPage = vi.fn()
  const onDiscussSelection = vi.fn()
  const onOpenFile = vi.fn()
  render(
    <TargetReaderBody
      request={options.request ?? request}
      media={media}
      pageIdx={options.pageIdx ?? null}
      pages={options.pages ?? media.pages}
      onSelectPage={onSelectPage}
      onDiscussSelection={onDiscussSelection}
      onOpenFile={onOpenFile}
    />,
  )
  return { media, onSelectPage, onDiscussSelection, onOpenFile }
}

function firstTextNode(root: Node): Text | null {
  if (root.nodeType === Node.TEXT_NODE) {
    const text = root as Text
    return (text.nodeValue ?? '').length > 0 ? text : null
  }
  for (const child of Array.from(root.childNodes)) {
    const found = firstTextNode(child)
    if (found !== null) return found
  }
  return null
}

/** 在指定正文块内产生文本选择，并触发 body 根监听的 mouseup。 */
function selectInChunk(chunkIndex: number, start: number, end: number): void {
  const sections = screen.getAllByTestId('rdlens-target-reader-chunk')
  const markdown = sections[chunkIndex].querySelector('[data-testid="markdown"]')
  const textNode = markdown === null ? null : firstTextNode(markdown)
  if (textNode === null) throw new Error('no text node in chunk')
  const range = document.createRange()
  range.setStart(textNode, start)
  range.setEnd(textNode, end)
  const selection = window.getSelection()
  if (selection === null) throw new Error('no selection')
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.mouseUp(document)
}

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  vi.clearAllMocks()
})

describe('TargetReaderBody 状态优先级（§2.9）', () => {
  it('detail 加载中显示加载文案（不显示正文）', () => {
    renderBody({
      media: makeMedia({ detail: null, detailStatus: 'loading', sourceType: null, pages: [] }),
    })
    expect(screen.getByTestId('rdlens-target-reader-loading')).toHaveTextContent(
      'research.target.reader.loadingDetail',
    )
    expect(screen.queryAllByTestId('rdlens-target-reader-chunk')).toHaveLength(0)
  })

  it('版本不一致显示版本失效说明，且不显示任何正文（不回退最新版）', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk()] }),
        versionState: { kind: 'mismatch' },
      }),
      pageIdx: 0,
    })
    expect(screen.getByTestId('rdlens-target-reader-version-mismatch')).toHaveTextContent(
      'research.target.reader.versionMismatch',
    )
    expect(screen.queryAllByTestId('rdlens-target-reader-chunk')).toHaveLength(0)
    expect(screen.queryByTestId('rdlens-target-reader-page-image-section')).toBeNull()
  })

  it('撤权 410：只显示受限说明 + 下载入口，无自动重试、无正文', () => {
    const { onOpenFile } = renderBody({
      media: makeMedia({
        detail: null,
        detailStatus: 'error',
        detailFailure: 'forbidden',
        sourceType: null,
        pages: [],
      }),
    })
    expect(screen.getByTestId('rdlens-target-reader-restricted')).toHaveTextContent(
      'research.target.reader.restricted',
    )
    expect(screen.queryAllByTestId('rdlens-target-reader-chunk')).toHaveLength(0)
    expect(screen.queryByTestId('rdlens-target-reader-retry')).toBeNull()
    // §2.4/#2.9：撤权时来源详情不可得 → `file_available` 无法确认，下载入口
    // 明确禁用（不伪造可用入口），也不触发请求。
    const download = screen.getByTestId('rdlens-target-reader-restricted-download')
    expect(download).toBeDisabled()
    fireEvent.click(download)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('401 会话失效：清空正文/页图，只显示会话失效（§2.9：结束重试、无 Retry）', () => {
    renderBody({
      media: makeMedia({
        detail: null,
        detailStatus: 'error',
        detailFailure: 'session_expired',
        sourceType: null,
        pages: [],
      }),
    })
    expect(screen.getByTestId('rdlens-target-reader-session-expired')).toHaveTextContent(
      'research.target.reader.sessionExpired',
    )
    expect(screen.queryAllByTestId('rdlens-target-reader-chunk')).toHaveLength(0)
    expect(screen.queryByTestId('rdlens-target-reader-retry')).toBeNull()
    expect(screen.queryByTestId('rdlens-target-reader-page-image-section')).toBeNull()
  })

  it('detail 可重试失败：显示失败文案 + 手动 Retry（点击调用 retryDetail）', () => {
    const media = makeMedia({
      detail: null,
      detailStatus: 'error',
      detailFailure: 'retryable',
      sourceType: null,
      pages: [],
    })
    renderBody({ media })
    expect(screen.getByTestId('rdlens-target-reader-detail-failed')).toHaveTextContent(
      'research.target.reader.detailFailed',
    )
    fireEvent.click(screen.getByTestId('rdlens-target-reader-retry'))
    expect(media.retryDetail).toHaveBeenCalledTimes(1)
  })

  it('不可重试失败（422/authority 竞态 404）：不显示 Retry', () => {
    renderBody({
      media: makeMedia({
        detail: null,
        detailStatus: 'error',
        detailFailure: 'source_unavailable',
        sourceType: null,
        pages: [],
      }),
    })
    expect(screen.getByTestId('rdlens-target-reader-detail-failed')).toBeInTheDocument()
    expect(screen.queryByTestId('rdlens-target-reader-retry')).toBeNull()
  })

  it('旧 host 缺 source_type：能力不可用（fail-closed，不伪造正文）', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({ source_type: null }),
        sourceType: null,
        versionState: { kind: 'latest' },
      }),
    })
    expect(screen.getByTestId('rdlens-target-reader-capability-unavailable')).toHaveTextContent(
      'research.target.reader.capabilityUnavailable',
    )
    expect(screen.queryAllByTestId('rdlens-target-reader-chunk')).toHaveLength(0)
  })

  it('citation 版本不可核对：正文按当前版本读取并标注「当前可用版本，非被引版本」', () => {
    renderBody({
      request: {
        ...request,
        origin: 'citation',
        citation: {
          citation_id: 1,
          claim: 'Claim',
          doc_id: 'doc_1',
          page_idx: 0,
          chunk_id: 'chunk_1',
        },
        documentRef: null,
      },
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk()] }),
        versionState: { kind: 'unverifiable' },
      }),
      pageIdx: 0,
    })
    expect(
      screen.getByTestId('rdlens-target-reader-current-version-note'),
    ).toHaveTextContent('research.target.reader.currentVersionNote')
    expect(screen.getAllByTestId('rdlens-target-reader-chunk').length).toBeGreaterThan(0)
  })
})

describe('TargetReaderBody PDF/PPT 页模式（§2.4/§2.10-6/7）', () => {
  it('页导航只在可定位页集合内移动（首页 prev 禁用，next → 下一页）', () => {
    const { onSelectPage } = renderBody({
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk()] }),
        pages: [0, 2],
      }),
      pageIdx: 0,
      pages: [0, 2],
    })
    expect(screen.getByTestId('rdlens-target-reader-prev-page')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-reader-next-page')).not.toBeDisabled()
    expect(screen.getByTestId('rdlens-target-reader-page-label')).toHaveTextContent(
      'research.target.reader.locatorPage:1',
    )
    fireEvent.click(screen.getByTestId('rdlens-target-reader-next-page'))
    expect(onSelectPage).toHaveBeenCalledWith(2)
  })

  it('末页 next 禁用，prev → 上一页（不探测未知页）', () => {
    const { onSelectPage } = renderBody({
      media: makeMedia({ detail: makeDetail(), pages: [0, 2] }),
      pageIdx: 2,
      pages: [0, 2],
    })
    expect(screen.getByTestId('rdlens-target-reader-next-page')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-reader-prev-page')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('rdlens-target-reader-prev-page'))
    expect(onSelectPage).toHaveBeenCalledWith(0)
  })

  it('页集合为空：不显示页导航，显示页不可用', () => {
    renderBody({
      media: makeMedia({ detail: makeDetail({ markdown_chunks: [] }), pages: [] }),
      pageIdx: null,
      pages: [],
    })
    expect(screen.queryByTestId('rdlens-target-reader-page-nav')).toBeNull()
    expect(screen.getByTestId('rdlens-target-reader-page-unavailable')).toHaveTextContent(
      'research.target.reader.pageUnavailable',
    )
  })

  it('页图就绪：渲染 blob URL img（object-contain），页图不可选中文本', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk()] }),
        pageImage: { status: 'ready', url: 'blob:mock-page-1', failure: null },
      }),
      pageIdx: 0,
    })
    const image = screen.getByTestId('rdlens-target-reader-page-image')
    expect(image).toHaveAttribute('src', 'blob:mock-page-1')
    expect(image.className).toContain('object-contain')
    expect(screen.queryByTestId('rdlens-target-reader-no-selectable-text')).toBeNull()
  })

  it('页图失败（可重试）：显示失败文案 + 手动重试调用 retryPageImage', () => {
    const media = makeMedia({
      detail: makeDetail({ markdown_chunks: [makeChunk()] }),
      pageImage: { status: 'error', url: null, failure: 'retryable' },
    })
    renderBody({ media, pageIdx: 0 })
    expect(
      screen.getByTestId('rdlens-target-reader-page-image-error-message'),
    ).toHaveTextContent('research.target.reader.pageImageFailed')
    fireEvent.click(screen.getByTestId('rdlens-target-reader-retry'))
    expect(media.retryPageImage).toHaveBeenCalledTimes(1)
  })

  it('页图撤权（forbidden）：显示受限文案、无重试、无页图下载入口', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk()] }),
        pageImage: { status: 'error', url: null, failure: 'forbidden' },
      }),
      pageIdx: 0,
    })
    expect(
      screen.getByTestId('rdlens-target-reader-page-image-error-message'),
    ).toHaveTextContent('research.target.reader.restricted')
    expect(screen.queryByTestId('rdlens-target-reader-retry')).toBeNull()
    expect(screen.queryByTestId('rdlens-target-reader-page-image-download')).toBeNull()
  })

  it('#1031 兜底 chunk 不渲染为页正文；同页无其它块 → 该页无可选文本', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({
          markdown_chunks: [
            makeChunk({ chunk_id: 'deck_toc', page_idx: 0, markdown: 'toc fallback' }),
          ],
        }),
      }),
      pageIdx: 0,
    })
    expect(screen.queryAllByTestId('rdlens-target-reader-chunk')).toHaveLength(0)
    expect(screen.getByTestId('rdlens-target-reader-no-selectable-text')).toHaveTextContent(
      'research.target.reader.noSelectableText',
    )
  })

  it('兜底 chunk 与真实正文混排时只渲染真实正文块', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({
          markdown_chunks: [
            makeChunk({ chunk_id: 'deck_toc', page_idx: 0, markdown: 'toc fallback' }),
            makeChunk({ chunk_id: 'chunk_body', page_idx: 0, markdown: 'Real page text.' }),
            makeChunk({ chunk_id: 'chunk_next', page_idx: 1, chunk_ordinal: 2 }),
          ],
        }),
      }),
      pageIdx: 0,
    })
    const chunks = screen.getAllByTestId('rdlens-target-reader-chunk')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveAttribute('data-chunk-id', 'chunk_body')
  })

  it('图表 chunk：显示不可读/需人工核对提示 + 下载入口（不推断内容）', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({
          markdown_chunks: [
            makeChunk({
              chunk_id: 'chunk_fig',
              page_idx: 0,
              markdown: 'Figure <!-- image_description -->',
            }),
          ],
        }),
      }),
      pageIdx: 0,
    })
    expect(screen.getByTestId('rdlens-target-reader-figure-note')).toHaveTextContent(
      'research.target.reader.figureUnavailable',
    )
    expect(screen.getByTestId('rdlens-target-reader-figure-download')).toBeInTheDocument()
  })
})

describe('TargetReaderBody 规范化正文模式（§2.4 XLSX/DOCX/CSV）', () => {
  it('XLSX：常显「非原版式」标注 + sheet 排序说明 + 每条 Sheet N 定位 + 兜底 chunk 标注', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({
          source_type: 'xlsx',
          markdown_chunks: [
            makeChunk({ chunk_id: 'sheet_a', page_idx: 0, markdown: 'Sheet A text' }),
            makeChunk({ chunk_id: 'book_toc', page_idx: 0, markdown: 'fallback toc' }),
          ],
        }),
        sourceType: 'xlsx',
        pages: [0],
      }),
      pageIdx: 0,
    })
    expect(screen.getByTestId('rdlens-target-reader-normalized-notice')).toHaveTextContent(
      'research.target.reader.normalizedNotice',
    )
    expect(screen.getByTestId('rdlens-target-reader-sheet-order-note')).toHaveTextContent(
      'research.target.reader.sheetOrderNote',
    )
    expect(screen.getAllByTestId('rdlens-target-reader-chunk-locator')).toHaveLength(2)
    expect(screen.getAllByTestId('rdlens-target-reader-chunk-locator')[0]).toHaveTextContent(
      'research.target.reader.locatorSheet:1',
    )
    // XLSX 全局正文按序渲染兜底 chunk，但标注 #1031 位置未知。
    const chunks = screen.getAllByTestId('rdlens-target-reader-chunk')
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toHaveAttribute('data-chunk-id', 'book_toc')
    expect(screen.getByTestId('rdlens-target-reader-fallback-note')).toHaveTextContent(
      'research.target.reader.fallbackPositionNote',
    )
  })

  it('DOCX：常显非原版式标注，无页/Sheet 定位标签', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({
          source_type: 'docx',
          markdown_chunks: [makeChunk({ markdown: 'Docx text' })],
        }),
        sourceType: 'docx',
      }),
      pageIdx: 0,
    })
    expect(screen.getByTestId('rdlens-target-reader-normalized-notice')).toBeInTheDocument()
    expect(screen.queryAllByTestId('rdlens-target-reader-chunk-locator')).toHaveLength(0)
    expect(screen.queryByTestId('rdlens-target-reader-sheet-order-note')).toBeNull()
    expect(screen.getAllByTestId('rdlens-target-reader-chunk')).toHaveLength(1)
  })

  it('chunk 块带 data-chunk-id/-ordinal/-page（选段定位依据）', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk({ chunk_ordinal: 7 })] }),
      }),
      pageIdx: 0,
    })
    const chunk = screen.getByTestId('rdlens-target-reader-chunk')
    expect(chunk).toHaveAttribute('data-chunk-id', 'chunk_1')
    expect(chunk).toHaveAttribute('data-chunk-ordinal', '7')
    expect(chunk).toHaveAttribute('data-chunk-page', '0')
  })
})

describe('TargetReaderBody 选段（§2.5-4/§2.10-10）', () => {
  it('单 chunk 内选段 → 浮层「讨论选段」→ 11 键载荷 + target=global 的 pending', () => {
    const { onDiscussSelection } = renderBody({
      media: makeMedia({
        detail: makeDetail({ title: 'Source title', markdown_chunks: [makeChunk()] }),
      }),
      pageIdx: 0,
    })
    selectInChunk(0, 0, 10)
    const discuss = screen.getByTestId('rdlens-target-reader-discuss-selection')
    expect(discuss).toHaveTextContent('research.selection.discuss')
    fireEvent.click(discuss)
    expect(onDiscussSelection).toHaveBeenCalledTimes(1)
    const pending = onDiscussSelection.mock.calls[0][0]
    expect(pending).toMatchObject({
      sourceId: 'src_1',
      sourceTitle: 'Source title',
      pageIdx: 0,
      chunkOrdinal: 0,
      target: 'global',
    })
    expect(pending.selection).toMatchObject({
      sourceId: 'src_1',
      documentId: 'doc_1',
      documentVersion: 'v1',
      chunkId: 'chunk_1',
      chunkOrdinal: 0,
      pageIdx: 0,
      startOffset: 0,
      endOffset: 10,
      quote: 'Alpha beta',
      contentHash: HEX64,
    })
    expect(pending.selection.quoteHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('chunk 缺逐 chunk content_hash：不产生选段，显示可读失败原因', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({
          markdown_chunks: [makeChunk({ content_hash: null })],
        }),
      }),
      pageIdx: 0,
    })
    selectInChunk(0, 0, 10)
    expect(screen.queryByTestId('rdlens-target-reader-discuss-selection')).toBeNull()
    expect(screen.getByTestId('rdlens-target-reader-selection-failed')).toHaveTextContent(
      'research.selection.captureFailed',
    )
  })

  it('跨 chunk 选择：拒绝并显示失败原因（不猜载荷）', () => {
    renderBody({
      media: makeMedia({
        detail: makeDetail({
          markdown_chunks: [
            makeChunk({ chunk_id: 'chunk_1', chunk_ordinal: 0, markdown: 'First block text.' }),
            makeChunk({ chunk_id: 'chunk_2', chunk_ordinal: 1, markdown: 'Second block text.' }),
          ],
        }),
      }),
      pageIdx: 0,
    })
    const sections = screen.getAllByTestId('rdlens-target-reader-chunk')
    const first = firstTextNode(sections[0].querySelector('[data-testid="markdown"]')!)
    const second = firstTextNode(sections[1].querySelector('[data-testid="markdown"]')!)
    if (first === null || second === null) throw new Error('missing text nodes')
    const range = document.createRange()
    range.setStart(first, 0)
    range.setEnd(second, 5)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(document)
    expect(screen.queryByTestId('rdlens-target-reader-discuss-selection')).toBeNull()
    expect(screen.getByTestId('rdlens-target-reader-selection-failed')).toBeInTheDocument()
  })
})
