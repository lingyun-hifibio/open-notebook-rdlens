import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UseSourceMediaResult } from '@/lib/hooks/use-source-media'
import type { ResearchChunk, ResearchSourceDetail } from '@/lib/types/research'
import { sourceReaderRequest } from './target-reader-state'
import { TargetReaderFocus, type TargetReaderFocusProps } from './TargetReaderFocus'

// W2 #1077：宽屏阅读器覆盖层（UI 规格 v1 §5.7；合并计划 §2.3/§2.10-4/5/11）。
// 被测边界：对话框语义/65px 返回条/标题与定位/打开聚焦/ Esc/Tab 环绕/
// 1024 aside 折叠与 1440 恒显示/正文让宽不横向滚动/返回条动作。

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
    markdown_chunks: [makeChunk()],
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
    pages: [0, 1],
    pageImage: { status: 'ready', url: 'blob:mock-page-1', failure: null },
    retryPageImage: vi.fn(),
    file: { status: 'idle', failure: null },
    openFile: vi.fn(),
    ...overrides,
  }
}

const request = sourceReaderRequest({ sourceId: 'src_1' })

function renderFocus(overrides: Partial<TargetReaderFocusProps> = {}) {
  const handlers = {
    onAskThisSource: vi.fn(),
    onReturnToAnswer: vi.fn(),
    onOpenFile: vi.fn(),
    onDiscussSelection: vi.fn(),
    onClose: vi.fn(),
    onSelectPage: vi.fn(),
  }
  const props: TargetReaderFocusProps = {
    request,
    media: makeMedia(),
    answerContext: 'Answer fragment',
    returnAvailable: false,
    returnUnavailableNotice: false,
    canPinSingleSource: true,
    viewportWidth: 1440,
    pageIdx: 0,
    ...handlers,
    ...overrides,
  }
  const result = render(<TargetReaderFocus {...props} />)
  return { ...handlers, ...overrides, unmount: result.unmount }
}

afterEach(() => {
  cleanup()
})

describe('TargetReaderFocus 形态与可访问性（§5.7）', () => {
  it('role=dialog + aria-modal + aria-labelledby 指向标题；返回条 65px', () => {
    renderFocus()
    const dialog = screen.getByTestId('rdlens-target-reader')
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const titleId = dialog.getAttribute('aria-labelledby')
    expect(titleId).toBe('rdlens-target-reader-title')
    const title = screen.getByTestId('rdlens-target-reader-title')
    expect(title).toHaveTextContent('Source title')
    expect(title).toHaveAttribute('id', titleId)
    expect(document.getElementById(titleId ?? '')).toBe(title)
  })

  it('标题缺失回退 document_id；docs 类格式显示「无可用定位」', () => {
    renderFocus({
      media: makeMedia({
        detail: makeDetail({ title: null, source_type: 'docx' }),
        sourceType: 'docx',
        pages: [0],
      }),
    })
    expect(screen.getByTestId('rdlens-target-reader-title')).toHaveTextContent('doc_1')
    expect(screen.getByTestId('rdlens-target-reader-locator')).toHaveTextContent(
      'research.target.reader.locatorUnavailable',
    )
  })

  it('PDF 定位按 pageIdx+1 显示 Page N；返回条高 65px', () => {
    renderFocus({ pageIdx: 2 })
    expect(screen.getByTestId('rdlens-target-reader-locator')).toHaveTextContent(
      'research.target.reader.locatorPage:3',
    )
    const header = screen.getByTestId('rdlens-target-reader').querySelector('header')
    expect(header?.style.height).toBe('65px')
  })
})

describe('TargetReaderFocus 焦点与键盘（§5.7/§2.10-4）', () => {
  it('打开即聚焦返回按钮；点击返回关闭', () => {
    const { onClose } = renderFocus()
    const back = screen.getByTestId('rdlens-target-reader-back')
    expect(back).toHaveFocus()
    expect(back).toHaveAttribute(
      'aria-label',
      'research.target.reader.backAria',
    )
    fireEvent.click(back)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc 关闭（document keydown）', () => {
    const { onClose } = renderFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('上层已处理（defaultPrevented）的 Esc 不重复关闭（不抢 Radix 弹层）', () => {
    const { onClose } = renderFocus()
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    event.preventDefault()
    document.dispatchEvent(event)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Tab 在 dialog 内环绕：末位 → 首个，Shift+Tab 首个 → 末位', () => {
    renderFocus({ returnAvailable: true })
    const back = screen.getByTestId('rdlens-target-reader-back')
    const last = screen.getByTestId('rdlens-target-reader-aside-return')
    last.focus()
    expect(last).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(back).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })
})

describe('TargetReaderFocus 布局（§5.7/1024/1440）', () => {
  it('1440：aside 恒显示 340px、正文列 830、无折叠开关', () => {
    renderFocus({ viewportWidth: 1440 })
    expect(screen.queryByTestId('rdlens-target-reader-toggle-aside')).toBeNull()
    const aside = screen.getByTestId('rdlens-target-reader-aside-panel')
    expect(aside.style.width).toBe('340px')
    expect(screen.getByTestId('rdlens-target-reader-aside')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-reader-body-column').style.maxWidth).toBe(
      '830px',
    )
  })

  it('1024：aside 默认折叠；展开后 aside 340、正文让宽 684（不横向滚动）', () => {
    renderFocus({ viewportWidth: 1024 })
    expect(screen.queryByTestId('rdlens-target-reader-aside-panel')).toBeNull()
    const toggle = screen.getByTestId('rdlens-target-reader-toggle-aside')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('rdlens-target-reader-body-column').style.maxWidth).toBe(
      '830px',
    )
    fireEvent.click(toggle)
    expect(screen.getByTestId('rdlens-target-reader-toggle-aside')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByTestId('rdlens-target-reader-aside-panel').style.width).toBe('340px')
    // 1024 − 340 = 684：正文让宽，列宽之和不超过视口（无整页横向滚动）。
    const bodyColumn = screen.getByTestId('rdlens-target-reader-body-column')
    expect(bodyColumn.style.maxWidth).toBe('684px')
    expect(684 + 340).toBeLessThanOrEqual(1024)
  })
})

describe('TargetReaderFocus 返回条动作（§5.7/§2.10-9/11）', () => {
  it('只问此来源：不可用禁用并给原因；可用时点击触发', () => {
    const { onAskThisSource } = renderFocus({ canPinSingleSource: true })
    const ask = screen.getByTestId('rdlens-target-reader-ask-source')
    expect(ask).not.toBeDisabled()
    fireEvent.click(ask)
    expect(onAskThisSource).toHaveBeenCalledTimes(1)
    cleanup()
    renderFocus({ canPinSingleSource: false })
    const disabledAsk = screen.getByTestId('rdlens-target-reader-ask-source')
    expect(disabledAsk).toBeDisabled()
    expect(disabledAsk).toHaveAttribute(
      'title',
      'research.target.conversation.noActiveSession',
    )
  })

  it('下载：点击调用 onOpenFile；file 加载中禁用', () => {
    const { onOpenFile } = renderFocus()
    fireEvent.click(screen.getByTestId('rdlens-target-reader-download'))
    expect(onOpenFile).toHaveBeenCalledTimes(1)
    cleanup()
    renderFocus({ media: makeMedia({ file: { status: 'loading', failure: null } }) })
    expect(screen.getByTestId('rdlens-target-reader-download')).toBeDisabled()
  })

  it('返回原回答：仅 returnAvailable 显示；不可用提示可见', () => {
    renderFocus({ returnAvailable: false, returnUnavailableNotice: true })
    expect(screen.queryByTestId('rdlens-target-reader-return')).toBeNull()
    expect(
      screen.getByTestId('rdlens-target-reader-return-unavailable'),
    ).toHaveTextContent('research.source.returnUnavailable')
    cleanup()
    const { onReturnToAnswer } = renderFocus({ returnAvailable: true })
    fireEvent.click(screen.getByTestId('rdlens-target-reader-return'))
    expect(onReturnToAnswer).toHaveBeenCalledTimes(1)
  })

  it('下载失败显示可解释提示', () => {
    renderFocus({
      media: makeMedia({ file: { status: 'error', failure: 'retryable' } }),
    })
    expect(screen.getByTestId('rdlens-target-reader-download-failed')).toHaveTextContent(
      'research.target.reader.downloadFailed',
    )
  })
})

describe('TargetReaderFocus 组合正文列/切页（§2.4）', () => {
  it('页导航由 shell 受控：点击 next 调 onSelectPage(1)，页图按 blob URL 渲染', () => {
    const { onSelectPage } = renderFocus({
      media: makeMedia({ pages: [0, 1] }),
      pageIdx: 0,
    })
    expect(screen.getByTestId('rdlens-target-reader-page-image')).toHaveAttribute(
      'src',
      'blob:mock-page-1',
    )
    fireEvent.click(screen.getByTestId('rdlens-target-reader-next-page'))
    expect(onSelectPage).toHaveBeenCalledWith(1)
  })

  it('新请求复位 aside 展开态（1024）', () => {
    const { rerender } = render(
      <TargetReaderFocus
        request={request}
        media={makeMedia()}
        answerContext={null}
        returnAvailable={false}
        returnUnavailableNotice={false}
        canPinSingleSource={true}
        onAskThisSource={vi.fn()}
        onReturnToAnswer={vi.fn()}
        onOpenFile={vi.fn()}
        onDiscussSelection={vi.fn()}
        onClose={vi.fn()}
        viewportWidth={1024}
        pageIdx={0}
        onSelectPage={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('rdlens-target-reader-toggle-aside'))
    expect(screen.getByTestId('rdlens-target-reader-aside-panel')).toBeInTheDocument()
    rerender(
      <TargetReaderFocus
        request={sourceReaderRequest({ sourceId: 'src_2' })}
        media={makeMedia({ detail: makeDetail({ source_id: 'src_2' }) })}
        answerContext={null}
        returnAvailable={false}
        returnUnavailableNotice={false}
        canPinSingleSource={true}
        onAskThisSource={vi.fn()}
        onReturnToAnswer={vi.fn()}
        onOpenFile={vi.fn()}
        onDiscussSelection={vi.fn()}
        onClose={vi.fn()}
        viewportWidth={1024}
        pageIdx={0}
        onSelectPage={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('rdlens-target-reader-aside-panel')).toBeNull()
  })
})

describe('TargetReaderFocus 下载入口门禁（§2.4 file_available）', () => {
  it('file_available !== true：下载禁用、给可读原因、不触发请求', () => {
    const { onOpenFile } = renderFocus({
      media: makeMedia({ detail: makeDetail({ file_available: false }) }),
    })
    const button = screen.getByTestId('rdlens-target-reader-download')
    expect(button).toBeDisabled()
    expect(button.getAttribute('title')).toContain('research.target.reader.downloadUnavailable')
    fireEvent.click(button)
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('detail 未就绪（loading）：下载禁用（不伪造入口）', () => {
    const { onOpenFile } = renderFocus({
      media: makeMedia({ detail: null, detailStatus: 'loading', pages: [] }),
    })
    const button = screen.getByTestId('rdlens-target-reader-download')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onOpenFile).not.toHaveBeenCalled()
  })
})
