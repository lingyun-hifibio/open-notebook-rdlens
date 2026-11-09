import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UseSourceMediaResult } from '@/lib/hooks/use-source-media'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ResearchChunk, ResearchSourceDetail } from '@/lib/types/research'
import {
  citationReaderRequest,
  sourceReaderRequest,
  type TargetReaderOpenRequest,
  type TargetReaderVersionState,
} from './target-reader-state'
import { CITED_EXCERPT_MAX_CHARS, TargetReaderAside } from './TargetReaderAside'

// W2 #1077：阅读器 aside 对照面板（UI 规格 v1 §5.6 UI-13/§5.7；合并计划
// §2.5/§2.10-9）。被测边界：版本护栏（match 才摘录）/claim 标注/依次回退
// claim/兜底 #1031 标注/当前回答上下文/动作禁用与不可用原因。

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const HEX64 = 'a'.repeat(64)

function makeChunk(overrides: Partial<ResearchChunk> = {}): ResearchChunk {
  return {
    chunk_id: 'chunk_1',
    page_idx: 0,
    markdown: 'Verbatim source passage for the citation.',
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

function makeMedia(
  overrides: Partial<UseSourceMediaResult> = {},
): UseSourceMediaResult {
  return {
    detail: makeDetail(),
    detailStatus: 'ready',
    detailFailure: null,
    retryDetail: vi.fn(),
    versionState: { kind: 'match' },
    sourceType: 'pdf',
    pages: [0],
    pageImage: { status: 'idle', url: null, failure: null },
    retryPageImage: vi.fn(),
    file: { status: 'idle', failure: null },
    openFile: vi.fn(),
    ...overrides,
  }
}

const citation: ResearchCitationDisplayItem = {
  citation_id: 1,
  claim: 'The source claims this.',
  doc_id: 'doc_1',
  page_idx: 0,
  chunk_id: 'chunk_1',
  doc_version: 'v1',
}

const citationRequest: TargetReaderOpenRequest = citationReaderRequest({
  citation,
  sourceId: 'src_1',
  messageId: 'msg_1',
})

function renderAside(overrides: {
  request?: TargetReaderOpenRequest
  media?: UseSourceMediaResult
  answerContext?: string | null
  canPinSingleSource?: boolean
  returnAvailable?: boolean
  returnUnavailableNotice?: boolean
} = {}) {
  const handlers = { onAskThisSource: vi.fn(), onReturnToAnswer: vi.fn() }
  render(
    <TargetReaderAside
      request={overrides.request ?? citationRequest}
      media={overrides.media ?? makeMedia()}
      answerContext={overrides.answerContext ?? null}
      canPinSingleSource={overrides.canPinSingleSource ?? true}
      returnAvailable={overrides.returnAvailable ?? false}
      returnUnavailableNotice={overrides.returnUnavailableNotice ?? false}
      {...handlers}
    />,
  )
  return handlers
}

function withVersionState(versionState: TargetReaderVersionState): UseSourceMediaResult {
  return makeMedia({ versionState })
}

afterEach(() => {
  cleanup()
})

describe('TargetReaderAside 被引原文/claim（§2.5-1/§2.10-9）', () => {
  it('版本一致 + chunk_id 命中：显示被引原文摘录（不显示 claim）', () => {
    renderAside({ media: withVersionState({ kind: 'match' }) })
    expect(screen.getByTestId('rdlens-target-reader-cited-excerpt')).toHaveTextContent(
      'Verbatim source passage for the citation.',
    )
    expect(screen.queryByTestId('rdlens-target-reader-claim')).toBeNull()
  })

  it('摘录截断 280 字符（完整正文在正文列）', () => {
    const longMarkdown = 'x'.repeat(CITED_EXCERPT_MAX_CHARS + 120)
    renderAside({
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk({ markdown: longMarkdown })] }),
        versionState: { kind: 'match' },
      }),
    })
    const excerpt = screen.getByTestId('rdlens-target-reader-cited-excerpt')
    expect(excerpt.textContent).toHaveLength(CITED_EXCERPT_MAX_CHARS + 1)
    expect(excerpt.textContent?.endsWith('…')).toBe(true)
  })

  it('chunk_id 缺失时按 page_idx 取该页首个 chunk', () => {
    renderAside({
      request: citationReaderRequest({
        citation: { ...citation, chunk_id: null, page_idx: 1 },
        sourceId: 'src_1',
        messageId: null,
      }),
      media: makeMedia({
        detail: makeDetail({
          markdown_chunks: [
            makeChunk({ chunk_id: 'chunk_p0', page_idx: 0, markdown: 'Page zero.' }),
            makeChunk({ chunk_id: 'chunk_p1', page_idx: 1, markdown: 'Page one.' }),
          ],
        }),
        versionState: { kind: 'match' },
      }),
    })
    expect(screen.getByTestId('rdlens-target-reader-cited-excerpt')).toHaveTextContent(
      'Page one.',
    )
  })

  it('匹配不到原文：显示 claim 并明确标注为 claim', () => {
    renderAside({
      media: makeMedia({
        detail: makeDetail({ markdown_chunks: [makeChunk({ chunk_id: 'other', page_idx: 3 })] }),
        versionState: { kind: 'match' },
      }),
    })
    expect(screen.getByTestId('rdlens-target-reader-claim')).toHaveTextContent(
      'The source claims this.',
    )
    expect(screen.queryByTestId('rdlens-target-reader-cited-excerpt')).toBeNull()
    expect(screen.getByTestId('rdlens-target-reader-cited-claim')).toHaveTextContent(
      'research.target.reader.asideClaim',
    )
  })

  it('#1031 兜底 chunk 不作为同页原文：claim + 位置未知标注', () => {
    renderAside({
      media: makeMedia({
        detail: makeDetail({
          markdown_chunks: [makeChunk({ chunk_id: 'deck_toc', page_idx: 0 })],
        }),
        versionState: { kind: 'match' },
      }),
    })
    expect(screen.queryByTestId('rdlens-target-reader-cited-excerpt')).toBeNull()
    expect(screen.getByTestId('rdlens-target-reader-claim')).toHaveTextContent(
      'The source claims this.',
    )
    expect(screen.getByTestId('rdlens-target-reader-claim-fallback-note')).toHaveTextContent(
      'research.target.reader.asideFallbackNote',
    )
  })

  it('版本不可核对：只 claim + 「引用版本不可核对」标注', () => {
    renderAside({ media: withVersionState({ kind: 'unverifiable' }) })
    expect(screen.queryByTestId('rdlens-target-reader-cited-excerpt')).toBeNull()
    expect(screen.getByTestId('rdlens-target-reader-claim')).toHaveTextContent(
      'The source claims this.',
    )
    expect(
      screen.getByTestId('rdlens-target-reader-version-unverifiable'),
    ).toHaveTextContent('research.target.reader.versionUnverifiable')
    expect(
      screen.getByTestId('rdlens-target-reader-claim-version-note'),
    ).toHaveTextContent('research.target.reader.asideClaimVersionNote')
  })

  it('版本不一致：版本失效 + claim，不做摘录匹配', () => {
    renderAside({ media: withVersionState({ kind: 'mismatch' }) })
    expect(screen.queryByTestId('rdlens-target-reader-cited-excerpt')).toBeNull()
    expect(screen.getByTestId('rdlens-target-reader-version-mismatch')).toHaveTextContent(
      'research.target.reader.versionMismatch',
    )
    expect(screen.getByTestId('rdlens-target-reader-claim')).toHaveTextContent(
      'The source claims this.',
    )
  })

  it('资料预览入口（latest）：不显示被引摘录区块', () => {
    renderAside({
      request: sourceReaderRequest({ sourceId: 'src_1' }),
      media: withVersionState({ kind: 'latest' }),
    })
    expect(screen.queryByTestId('rdlens-target-reader-cited-claim')).toBeNull()
    expect(screen.queryByTestId('rdlens-target-reader-cited-excerpt')).toBeNull()
  })
})

describe('TargetReaderAside 当前回答上下文（§2.5-2）', () => {
  it('answerContext 非空：只读展示当前回答片段', () => {
    renderAside({ answerContext: 'The answer fragment.' })
    expect(screen.getByTestId('rdlens-target-reader-answer-context')).toHaveTextContent(
      'The answer fragment.',
    )
    expect(screen.queryByTestId('rdlens-target-reader-answer-context-unavailable')).toBeNull()
  })

  it('answerContext 为空/null：显示不可用文案', () => {
    renderAside({ answerContext: null })
    expect(
      screen.getByTestId('rdlens-target-reader-answer-context-unavailable'),
    ).toHaveTextContent('research.target.reader.asideAnswerUnavailable')
    cleanup()
    renderAside({ answerContext: '   ' })
    expect(
      screen.getByTestId('rdlens-target-reader-answer-context-unavailable'),
    ).toBeInTheDocument()
  })
})

describe('TargetReaderAside 动作（§2.5-3/§2.10-11）', () => {
  it('只问此来源：可用时点击触发；不可用禁用并给原因', () => {
    const { onAskThisSource } = renderAside({ canPinSingleSource: true })
    fireEvent.click(screen.getByTestId('rdlens-target-reader-aside-ask-source'))
    expect(onAskThisSource).toHaveBeenCalledTimes(1)
    cleanup()
    renderAside({ canPinSingleSource: false })
    const ask = screen.getByTestId('rdlens-target-reader-aside-ask-source')
    expect(ask).toBeDisabled()
    expect(
      screen.getByTestId('rdlens-target-reader-aside-ask-source-unavailable'),
    ).toHaveTextContent('research.target.rightPane.askThisSourceUnavailable')
  })

  it('返回原回答：仅 returnAvailable 显示；不可用提示可见', () => {
    const { onReturnToAnswer } = renderAside({ returnAvailable: true })
    fireEvent.click(screen.getByTestId('rdlens-target-reader-aside-return'))
    expect(onReturnToAnswer).toHaveBeenCalledTimes(1)
    cleanup()
    renderAside({ returnUnavailableNotice: true })
    expect(screen.queryByTestId('rdlens-target-reader-aside-return')).toBeNull()
    expect(
      screen.getByTestId('rdlens-target-reader-aside-return-unavailable'),
    ).toHaveTextContent('research.source.returnUnavailable')
  })
})
