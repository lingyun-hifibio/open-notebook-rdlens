import { describe, expect, it } from 'vitest'
import {
  buildSelectionContext,
  domRangeForSelection,
  locateQuoteInMarkdown,
  matchSelectionToSource,
  normalizeSelectionText,
  rangeWithinChunk,
  selectionDisplayRange,
  type SelectionChunkSource,
  type SelectionSourceIdentity,
} from './selection-range'
import { sha256Hex } from './session-idempotency'
import type { WireSelectionContext } from './session-contract'

/**
 * Issue #1013（D1-E-2）§2.4/§2.10：选段纯逻辑测试（F01/F02）。
 *
 * 判定口径：偏移是 **UTF-16 code unit**（JS string 长度）；quote 必须是 chunk
 * markdown 原串的精确切片；跨 chunk / 无法唯一定位 / 缺逐 chunk hash 一律
 * 稳定失败（不猜位置）。
 */

const SOURCE: SelectionSourceIdentity = {
  sourceId: 'src_1',
  documentId: 'doc_1',
  documentVersion: 'v3',
}

function chunk(overrides: Partial<SelectionChunkSource> = {}): SelectionChunkSource {
  return {
    chunkId: 'chunk_1',
    chunkOrdinal: 2,
    contentHash: 'a'.repeat(64),
    pageIdx: 0,
    markdown: 'hello world',
    ...overrides,
  }
}

/** 构造一个只含纯文本的 chunk DOM（与测试环境 MarkdownRenderer mock 同构）。 */
function chunkDom(text: string): HTMLDivElement {
  const root = document.createElement('div')
  root.textContent = text
  document.body.appendChild(root)
  return root
}

function rangeFor(
  root: HTMLElement,
  text: string,
  from = 0,
): Range {
  const node = root.firstChild as Text
  const start = text.indexOf(node.nodeValue ?? '', 0) // noop to keep lint quiet
  void start
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, from + text.length)
  return range
}

function selectionFor(overrides: Partial<WireSelectionContext> = {}): WireSelectionContext {
  return {
    sourceId: 'src_1',
    documentId: 'doc_1',
    documentVersion: 'v3',
    chunkId: 'chunk_1',
    chunkOrdinal: 2,
    pageIdx: 0,
    startOffset: 6,
    endOffset: 11,
    quote: 'world',
    quoteHash: sha256Hex('world'),
    contentHash: 'a'.repeat(64),
    ...overrides,
  }
}

describe('normalizeSelectionText（空白折叠 + 回原串映射）', () => {
  it('折叠连续空白/去首尾并保留逐字符映射', () => {
    const { normalized, offsets } = normalizeSelectionText('  alpha\n\t beta   gamma ')
    expect(normalized).toBe('alpha beta gamma')
    // 规范化后每个字符都能映射回原串（末尾哨兵 = 原串长度）
    expect(offsets).toHaveLength(normalized.length + 1)
    expect(offsets[offsets.length - 1]).toBe('  alpha\n\t beta   gamma '.length)
    // 首字符（a）在原串中的下标为 2；末尾哨兵为原串长度
    expect(offsets[0]).toBe(2)
    expect(normalized[0]).toBe('a')
  })

  it('UTF-16：emoji 按 code unit 计长（不按码点数）', () => {
    const text = 'a😀b'
    expect(text.length).toBe(4)
    expect(normalizeSelectionText(text).normalized).toBe(text)
  })
})

describe('locateQuoteInMarkdown（F01 定位）', () => {
  it('直接唯一子串 → 原串精确切片', () => {
    const found = locateQuoteInMarkdown('hello world', 'world')
    expect(found).toEqual({ ok: true, start: 6, end: 11, quote: 'world' })
  })

  it('选区空白与原文换行不同 → 规范化唯一命中并映射回原串', () => {
    // 渲染后的 DOM 文本是 "line one line two"；markdown 原文含换行。
    const found = locateQuoteInMarkdown('line one\nline two', 'line two')
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.quote).toBe('line two')
    expect('line one\nline two'.slice(found.start, found.end)).toBe('line two')
  })

  it('重复出现且无上下文 → ambiguous_quote（不猜第一条）', () => {
    expect(locateQuoteInMarkdown('foo bar foo bar', 'foo')).toEqual({
      ok: false,
      reason: 'ambiguous_quote',
    })
  })

  it('重复出现 + 上下文唯一 → 消歧', () => {
    const found = locateQuoteInMarkdown('foo bar foo bar', 'foo', { before: 'bar' })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.start).toBe(8)
  })

  it('未命中 / 空选区 / 超长', () => {
    expect(locateQuoteInMarkdown('hello', 'nope')).toEqual({
      ok: false,
      reason: 'quote_not_found',
    })
    expect(locateQuoteInMarkdown('hello', '   ')).toEqual({
      ok: false,
      reason: 'empty_selection',
    })
    expect(locateQuoteInMarkdown('x'.repeat(2001), 'x'.repeat(2001))).toEqual({
      ok: false,
      reason: 'quote_too_long',
    })
  })
})

describe('buildSelectionContext（F01 DOM Range → 11 键选段）', () => {
  it('生成 offsets/quote/quote_hash（sha256 UTF-8）与逐 chunk 身份', () => {
    const root = chunkDom('hello world')
    const result = buildSelectionContext({
      range: rangeFor(root, 'world', 6),
      chunkRoot: root,
      chunk: chunk(),
      source: SOURCE,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selection).toEqual({
      sourceId: 'src_1',
      documentId: 'doc_1',
      documentVersion: 'v3',
      chunkId: 'chunk_1',
      chunkOrdinal: 2,
      pageIdx: 0,
      startOffset: 6,
      endOffset: 11,
      quote: 'world',
      // 固定向量：sha256('world')
      quoteHash: '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7',
      contentHash: 'a'.repeat(64),
    })
  })

  it('UTF-16 偏移：包含 emoji 的 quote 用 code unit 长度（end-start=quote.length）', () => {
    const markdown = 'ab😀cd'
    const root = chunkDom(markdown)
    // 选中 "😀c"（code units: 😀=2, c=1 → quote.length=3；start=2,end=5）
    const result = buildSelectionContext({
      range: rangeFor(root, '😀c', 2),
      chunkRoot: root,
      chunk: chunk({ markdown }),
      source: SOURCE,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selection.startOffset).toBe(2)
    expect(result.selection.endOffset).toBe(5)
    expect(result.selection.endOffset - result.selection.startOffset).toBe(
      result.selection.quote.length,
    )
    expect(result.selection.quote).toBe('😀c')
    expect(result.selection.quoteHash).toBe(sha256Hex('😀c'))
  })

  it('跨 chunk 选择 → cross_chunk（v1 单 chunk 约束）', () => {
    const rootA = chunkDom('first chunk')
    const rootB = chunkDom('second chunk')
    const range = document.createRange()
    range.setStart(rootA.firstChild as Text, 6)
    range.setEnd(rootB.firstChild as Text, 6)
    expect(rangeWithinChunk(range, rootA)).toBe(false)
    expect(
      buildSelectionContext({
        range,
        chunkRoot: rootA,
        chunk: chunk({ markdown: 'first chunk' }),
        source: SOURCE,
      }),
    ).toEqual({ ok: false, reason: 'cross_chunk' })
  })

  it('响应缺逐 chunk content_hash → chunk_unavailable（不得用来源级 hash）', () => {
    const root = chunkDom('hello world')
    expect(
      buildSelectionContext({
        range: rangeFor(root, 'world', 6),
        chunkRoot: root,
        chunk: chunk({ contentHash: null }),
        source: SOURCE,
      }),
    ).toEqual({ ok: false, reason: 'chunk_unavailable' })
  })

  it('chunk_ordinal 非整数/负数 → chunk_unavailable', () => {
    const root = chunkDom('hello world')
    expect(
      buildSelectionContext({
        range: rangeFor(root, 'world', 6),
        chunkRoot: root,
        chunk: chunk({ chunkOrdinal: -1 }),
        source: SOURCE,
      }),
    ).toEqual({ ok: false, reason: 'chunk_unavailable' })
  })
})

describe('matchSelectionToSource（F02 恢复校验）', () => {
  const chunks: SelectionChunkSource[] = [chunk()]

  it('版本/chunk/hash/offset/quote_hash 全一致 → 可定位', () => {
    expect(
      matchSelectionToSource(selectionFor(), {
        ...SOURCE,
        chunks,
      }),
    ).toMatchObject({ ok: true })
  })

  it('版本不一致 → version_unavailable（不自动升级到最新版）', () => {
    expect(
      matchSelectionToSource(selectionFor(), {
        ...SOURCE,
        documentVersion: 'v4',
        chunks,
      }),
    ).toEqual({ ok: false, reason: 'version_unavailable' })
  })

  it('chunk 缺失或逐 chunk hash 不符 → chunk_unavailable', () => {
    expect(
      matchSelectionToSource(selectionFor({ chunkId: 'missing' }), {
        ...SOURCE,
        chunks: [chunk({ chunkId: 'other', chunkOrdinal: 7 })],
      }),
    ).toEqual({ ok: false, reason: 'chunk_unavailable' })
    expect(
      matchSelectionToSource(selectionFor({ contentHash: 'b'.repeat(64) }), {
        ...SOURCE,
        chunks,
      }),
    ).toEqual({ ok: false, reason: 'chunk_unavailable' })
  })

  it('offset 切片 != quote 或 quote_hash 失配 → position_unavailable（保留摘录）', () => {
    expect(
      matchSelectionToSource(
        selectionFor({
          startOffset: 0,
          endOffset: 5,
          quote: 'hello',
          quoteHash: sha256Hex('hello'),
        }),
        { ...SOURCE, chunks },
      ),
    ).toMatchObject({ ok: true })
    expect(
      matchSelectionToSource(selectionFor({ quote: 'world', startOffset: 0, endOffset: 5 }), {
        ...SOURCE,
        chunks,
      }),
    ).toEqual({ ok: false, reason: 'position_unavailable' })
    expect(
      matchSelectionToSource(selectionFor({ quoteHash: 'b'.repeat(64) }), {
        ...SOURCE,
        chunks,
      }),
    ).toEqual({ ok: false, reason: 'position_unavailable' })
  })

  it('restricted 读投影不得高亮', () => {
    expect(
      matchSelectionToSource(
        { ...selectionFor(), visibility: 'restricted', quote: null, quoteHash: null, reasonCode: 'content_restricted' },
        { ...SOURCE, chunks },
      ),
    ).toEqual({ ok: false, reason: 'restricted' })
  })

  it('1-based 展示区间（只用于文案，不持久化）', () => {
    expect(selectionDisplayRange({ startOffset: 6, endOffset: 11 })).toEqual({
      start: 7,
      end: 11,
    })
  })
})

describe('domRangeForSelection（F02 offsets → DOM Range 高亮）', () => {
  it('唯一 quote → 返回可读 Range', () => {
    const root = chunkDom('hello world')
    const range = domRangeForSelection({
      chunkRoot: root,
      selection: { quote: 'world' },
    })
    expect(range).not.toBeNull()
    expect(range?.toString()).toBe('world')
  })

  it('跨内联节点（多个 text node）仍能定位', () => {
    const root = document.createElement('div')
    root.innerHTML = 'hello <strong>brave</strong> world'
    document.body.appendChild(root)
    const range = domRangeForSelection({
      chunkRoot: root,
      selection: { quote: 'brave' },
    })
    expect(range?.toString()).toBe('brave')
  })

  it('找不到 / 多次出现 → null（不伪造高亮）', () => {
    const root = chunkDom('foo bar foo bar')
    expect(domRangeForSelection({ chunkRoot: root, selection: { quote: 'foo' } })).toBeNull()
    expect(domRangeForSelection({ chunkRoot: root, selection: { quote: 'zzz' } })).toBeNull()
    expect(domRangeForSelection({ chunkRoot: root, selection: { quote: null } })).toBeNull()
  })
})
