/**
 * Issue #1013（D1-E-2）§2.4/§2.10：来源正文选段的**纯逻辑层**。
 *
 * 职责（不触碰 React/网络，只在显式传入的 DOM 节点上做几何/文本计算）：
 * - `locateQuoteInMarkdown`：把用户选中的文本映射回 chunk `markdown` **原串**
 *   的 UTF-16 code unit 偏移（服务端唯一口径：`end - start === quote.length`，
 *   JS 字符串长度即 UTF-16 长度）；跨空白折叠/块级分隔用规范化匹配，但**绝不**
 *   猜测：无法唯一确定位置时返回稳定原因，由 UI 提示重选。
 * - `buildSelectionContext`：DOM Range（限制在单个 chunk 元素内）+ 来源/chunk
 *   身份 → 11 键 `selection_context`（quote_hash = sha256(quote UTF-8)；
 *   content_hash 必须取响应里的逐 chunk hash，不接受来源级 hash）。
 * - `matchSelectionToSource`：恢复/高亮前按精确版本 + chunk + hash + offset +
 *   quote_hash 重放校验（失配 → `position_unavailable`，不伪造高亮）。
 * - `domRangeForSelection`：offset/quote → 渲染后的 DOM Range（高亮用；
 *   找不到 → null）。
 *
 * 边界（计划 §5.4）：v1 只支持**单个** reader chunk 内的选段；跨 chunk 选择
 * 一律 `cross_chunk`（多 chunk 载荷形状另立 issue）。
 */

import { sha256Hex } from './session-idempotency'
import {
  SELECTION_QUOTE_MAX_UTF16_UNITS,
  SELECTION_QUOTE_MAX_UTF8_BYTES,
  type WireSelectionContext,
  type WireSelectionProjection,
} from './session-contract'

/** 选段采集失败原因（稳定、可测试；UI 据此给「重选」文案，不伪造选段）。 */
export type SelectionCaptureFailure =
  | 'cross_chunk'
  | 'empty_selection'
  | 'quote_not_found'
  | 'ambiguous_quote'
  | 'quote_too_long'
  | 'chunk_unavailable'
  | 'invalid_offsets'

/** 单个 reader chunk 的最小身份/内容（来自来源详情响应，§2.3）。 */
export interface SelectionChunkSource {
  readonly chunkId: string
  /** 服务端 `markdown_chunks[].chunk_ordinal`（不得用前端数组下标）。 */
  readonly chunkOrdinal: number
  /** 服务端 `markdown_chunks[].content_hash`（逐 chunk reader hash）。 */
  readonly contentHash: string | null
  readonly pageIdx: number | null
  /** chunk `markdown` 原串（偏移相对它计数）。 */
  readonly markdown: string
}

/** 选段来源身份（精确版本；不做「最新版」重解析）。 */
export interface SelectionSourceIdentity {
  readonly sourceId: string
  readonly documentId: string
  readonly documentVersion: string
}

/** 由 DOM Range 采集的选段上下文。 */
export type SelectionCaptureResult =
  | { readonly ok: true; readonly selection: WireSelectionContext }
  | { readonly ok: false; readonly reason: SelectionCaptureFailure }

/** 恢复/高亮校验失败原因（对应 `position_unavailable` 语义）。 */
export type SelectionMatchFailure =
  | 'restricted'
  | 'version_unavailable'
  | 'chunk_unavailable'
  | 'position_unavailable'

export type SelectionMatchResult =
  | { readonly ok: true; readonly chunk: SelectionChunkSource }
  | { readonly ok: false; readonly reason: SelectionMatchFailure }

/** 规范化文本 + 回原串的偏移映射（map[normalized.length] = 原串长度）。 */
export interface NormalizedSelectionText {
  readonly normalized: string
  /** normalized 第 i 个字符来自原串的起始下标；末尾哨兵 = 原串长度。 */
  readonly offsets: readonly number[]
}

const WHITESPACE = /\s/

/** 把连续空白折叠为单个空格并去首尾空白，同时保留回原串的映射。 */
export function normalizeSelectionText(text: string): NormalizedSelectionText {
  let normalized = ''
  const offsets: number[] = []
  let index = 0
  // 去首部空白（Well-formed 文本；孤立代理项不是空白，按普通字符保留）。
  while (index < text.length && WHITESPACE.test(text[index])) index += 1
  while (index < text.length) {
    const char = text[index]
    if (WHITESPACE.test(char)) {
      const runStart = index
      while (index < text.length && WHITESPACE.test(text[index])) index += 1
      if (index < text.length) {
        normalized += ' '
        offsets.push(runStart)
      }
      continue
    }
    normalized += char
    offsets.push(index)
    index += 1
  }
  offsets.push(text.length)
  return { normalized, offsets }
}

function trimSelectionWhitespace(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && WHITESPACE.test(value[start])) start += 1
  while (end > start && WHITESPACE.test(value[end - 1])) end -= 1
  return value.slice(start, end)
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

function allIndexesOf(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []
  const indexes: number[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, from)
    if (found < 0) break
    indexes.push(found)
    from = found + 1
  }
  return indexes
}

/**
 * 选中文本 → chunk markdown 原串的 UTF-16 偏移。
 *
 * 匹配顺序（**只在唯一确定时返回**，否则稳定失败）：
 * 1. 直接子串匹配：唯一 → 直接定位（引号即原文切片）；
 * 2. 空白规范化匹配：唯一 → 映射回原串（跨换行/缩进的段落仍可定位）；
 * 3. 带上下文（选区前/后的渲染文本）消歧：规范化后唯一 → 定位。
 * 多条命中且无法消歧 → `ambiguous_quote`（不猜第一条）。
 */
export function locateQuoteInMarkdown(
  markdown: string,
  rawQuote: string,
  context?: { readonly before?: string; readonly after?: string },
): { readonly ok: true; readonly start: number; readonly end: number; readonly quote: string }
  | { readonly ok: false; readonly reason: SelectionCaptureFailure } {
  const quote = trimSelectionWhitespace(rawQuote)
  if (quote.length === 0) return { ok: false, reason: 'empty_selection' }
  if (quote.length > SELECTION_QUOTE_MAX_UTF16_UNITS) {
    return { ok: false, reason: 'quote_too_long' }
  }

  const direct = allIndexesOf(markdown, quote)
  if (direct.length === 1) {
    const start = direct[0]
    return { ok: true, start, end: start + quote.length, quote }
  }

  const normalizedMarkdown = normalizeSelectionText(markdown)
  const normalizedQuote = normalizeSelectionText(quote)
  if (normalizedQuote.normalized.length === 0) {
    return { ok: false, reason: 'empty_selection' }
  }
  const candidates = allIndexesOf(normalizedMarkdown.normalized, normalizedQuote.normalized)
  if (candidates.length === 0) return { ok: false, reason: 'quote_not_found' }

  const resolve = (normalizedStart: number): { start: number; end: number; quote: string } => {
    const start = normalizedMarkdown.offsets[normalizedStart]
    const normalizedEnd = normalizedStart + normalizedQuote.normalized.length
    const end = normalizedMarkdown.offsets[normalizedEnd]
    return { start, end, quote: markdown.slice(start, end) }
  }

  if (candidates.length === 1) {
    return { ok: true, ...resolve(candidates[0]) }
  }

  // 多条规范化命中：用选区上下文消歧（仍要求唯一）。
  const normalizedBefore = normalizeSelectionText(trimSelectionWhitespace(context?.before ?? '')).normalized
  const normalizedAfter = normalizeSelectionText(trimSelectionWhitespace(context?.after ?? '')).normalized
  if (normalizedBefore.length === 0 && normalizedAfter.length === 0) {
    return { ok: false, reason: 'ambiguous_quote' }
  }
  const filtered = candidates.filter((candidate) => {
    if (normalizedBefore.length > 0) {
      // 选区前文在规范化后可能与候选位置之间有空白差异（DOM 折叠/块级分隔），
      // 只比较「去尾空白后的后缀」，仍要求唯一。
      const beforeSide = normalizedMarkdown.normalized.slice(0, candidate)
      if (!beforeSide.trimEnd().endsWith(normalizedBefore)) return false
    }
    if (normalizedAfter.length > 0) {
      const afterSide = normalizedMarkdown.normalized.slice(
        candidate + normalizedQuote.normalized.length,
      )
      if (!afterSide.trimStart().startsWith(normalizedAfter)) return false
    }
    return true
  })
  if (filtered.length !== 1) return { ok: false, reason: 'ambiguous_quote' }
  return { ok: true, ...resolve(filtered[0]) }
}

/** 选区在渲染文本中的前后文（用于多命中消歧；最多各 48 字符）。 */
function selectionSurroundingText(
  range: Range,
  chunkRoot: HTMLElement,
): { before: string; after: string } {
  const beforeRange = document.createRange()
  const afterRange = document.createRange()
  try {
    beforeRange.setStart(chunkRoot, 0)
    beforeRange.setEnd(range.startContainer, range.startOffset)
  } catch {
    return { before: '', after: '' }
  }
  try {
    afterRange.setStart(range.endContainer, range.endOffset)
    const tail = document.createRange()
    tail.setStart(chunkRoot, 0)
    tail.setEnd(chunkRoot, chunkRoot.childNodes.length)
    afterRange.setEnd(tail.endContainer, tail.endOffset)
  } catch {
    return { before: beforeRange.toString(), after: '' }
  }
  const before = beforeRange.toString()
  const after = afterRange.toString()
  return { before: before.slice(-48), after: after.slice(0, 48) }
}

function hasValidPerChunkHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** 校验 Range 是否完全落在单个 chunk 根节点内（跨 chunk → 拒绝）。 */
export function rangeWithinChunk(range: Range, chunkRoot: HTMLElement): boolean {
  return (
    chunkRoot.contains(range.startContainer) && chunkRoot.contains(range.endContainer)
  )
}

/**
 * DOM Range → 11 键 `selection_context`（同步：`sha256Hex` 是仓库内纯 TS 实现）。
 *
 * 失败原因（稳定）：`cross_chunk` / `empty_selection` / `quote_not_found` /
 * `ambiguous_quote` / `quote_too_long` / `chunk_unavailable` / `invalid_offsets`。
 * `chunk_unavailable` 明确覆盖「响应没有逐 chunk content_hash」——此时**不得**
 * 产生选段（旧口径的来源级 hash 不可用于服务端校验，§2.3）。
 */
export function buildSelectionContext(input: {
  readonly range: Range
  readonly chunkRoot: HTMLElement
  readonly chunk: SelectionChunkSource
  readonly source: SelectionSourceIdentity
}): SelectionCaptureResult {
  const { range, chunkRoot, chunk, source } = input
  if (!hasValidPerChunkHash(chunk.contentHash)) {
    return { ok: false, reason: 'chunk_unavailable' }
  }
  if (
    !Number.isInteger(chunk.chunkOrdinal) ||
    chunk.chunkOrdinal < 0 ||
    chunk.chunkOrdinal > 2_147_483_647
  ) {
    return { ok: false, reason: 'chunk_unavailable' }
  }
  if (!rangeWithinChunk(range, chunkRoot)) {
    return { ok: false, reason: 'cross_chunk' }
  }
  const rawQuote = range.toString()
  const context = selectionSurroundingText(range, chunkRoot)
  const located = locateQuoteInMarkdown(chunk.markdown, rawQuote, context)
  if (!located.ok) return located
  const { start, end } = located
  if (start < 0 || end <= start || end > chunk.markdown.length) {
    return { ok: false, reason: 'invalid_offsets' }
  }
  const quote = located.quote
  if (quote.length > SELECTION_QUOTE_MAX_UTF16_UNITS) {
    return { ok: false, reason: 'quote_too_long' }
  }
  if (utf8ByteLength(quote) > SELECTION_QUOTE_MAX_UTF8_BYTES) {
    return { ok: false, reason: 'quote_too_long' }
  }
  if (end - start !== quote.length) {
    return { ok: false, reason: 'invalid_offsets' }
  }
  return {
    ok: true,
    selection: {
      sourceId: source.sourceId,
      documentId: source.documentId,
      documentVersion: source.documentVersion,
      chunkId: chunk.chunkId,
      chunkOrdinal: chunk.chunkOrdinal,
      pageIdx: chunk.pageIdx,
      startOffset: start,
      endOffset: end,
      quote,
      quoteHash: sha256Hex(quote),
      contentHash: chunk.contentHash,
    },
  }
}

/**
 * 按精确版本/chunk/hash/offset/quote_hash 校验选段（恢复与高亮前的唯一判据）。
 *
 * - `restricted`：读投影已撤权（摘录不可展示，不允许高亮）；
 * - `version_unavailable`：当前来源 doc/version 与选段不一致；
 * - `chunk_unavailable`：chunk 不存在 / ordinal 不符 / 逐 chunk hash 不符；
 * - `position_unavailable`：offset 切片不等于 quote 或 quote_hash 失配
 *   （权限仍允许读，但位置已失效 → 客户端提示重选，不隐藏摘录）。
 */
export function matchSelectionToSource(
  selection: WireSelectionContext | WireSelectionProjection,
  source: {
    readonly sourceId: string
    readonly documentId: string
    readonly documentVersion: string
    readonly chunks: readonly SelectionChunkSource[]
  },
): SelectionMatchResult {
  const visibility = 'visibility' in selection ? selection.visibility : 'visible'
  if (visibility === 'restricted') return { ok: false, reason: 'restricted' }
  if (
    selection.sourceId !== source.sourceId ||
    selection.documentId !== source.documentId ||
    selection.documentVersion !== source.documentVersion
  ) {
    return { ok: false, reason: 'version_unavailable' }
  }
  const chunk =
    source.chunks.find((candidate) => candidate.chunkId === selection.chunkId)
    ?? source.chunks.find((candidate) => candidate.chunkOrdinal === selection.chunkOrdinal)
  if (!chunk) return { ok: false, reason: 'chunk_unavailable' }
  if (chunk.chunkOrdinal !== selection.chunkOrdinal) {
    return { ok: false, reason: 'chunk_unavailable' }
  }
  if (
    !hasValidPerChunkHash(chunk.contentHash) ||
    chunk.contentHash !== selection.contentHash
  ) {
    return { ok: false, reason: 'chunk_unavailable' }
  }
  if (selection.quote === null) return { ok: false, reason: 'position_unavailable' }
  const sliced = chunk.markdown.slice(selection.startOffset, selection.endOffset)
  if (sliced !== selection.quote) return { ok: false, reason: 'position_unavailable' }
  if (sha256Hex(selection.quote) !== selection.quoteHash) {
    return { ok: false, reason: 'position_unavailable' }
  }
  return { ok: true, chunk }
}

/** 1-based 位置展示（服务端 0-based；只用于 UI 文案，不持久化）。 */
export function selectionDisplayRange(
  selection: Pick<WireSelectionContext, 'startOffset' | 'endOffset'>,
): { readonly start: number; readonly end: number } {
  return { start: selection.startOffset + 1, end: selection.endOffset }
}

// ---------------------------------------------------------------------------
// 反向：选段 → DOM Range（高亮 / 滚动）
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DIV', 'DL', 'DD', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

interface RenderedTextIndex {
  readonly text: string
  readonly nodeStarts: readonly number[]
  readonly nodes: readonly Text[]
}

/**
 * 渲染后的 chunk 文本（块级元素之间插入 `\n` 作为分隔，使 markdown 段落边界
 * 在规范化后仍可对齐）。返回文本节点及其在整串中的起点，供反向定位。
 */
function buildRenderedTextIndex(root: HTMLElement): RenderedTextIndex {
  let text = ''
  const nodeStarts: number[] = []
  const nodes: Text[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? ''
      if (value.length === 0) return
      nodes.push(node as Text)
      nodeStarts.push(text.length)
      text += value
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const isBlock = BLOCK_TAGS.has(element.tagName)
    if (isBlock && text.length > 0 && !text.endsWith('\n')) text += '\n'
    for (const child of Array.from(element.childNodes)) visit(child)
    if (isBlock && text.length > 0 && !text.endsWith('\n')) text += '\n'
  }
  for (const child of Array.from(root.childNodes)) visit(child)
  return { text, nodeStarts, nodes }
}

function domPointAt(
  index: RenderedTextIndex,
  offset: number,
  bias: 'start' | 'end',
): { node: Text; offset: number } | null {
  if (index.nodes.length === 0) return null
  for (let nodeIndex = 0; nodeIndex < index.nodes.length; nodeIndex += 1) {
    const start = index.nodeStarts[nodeIndex]
    const end = start + (index.nodes[nodeIndex].nodeValue?.length ?? 0)
    if (offset < start || offset > end) continue
    if (offset === end && bias === 'start' && nodeIndex + 1 < index.nodes.length) {
      const nextStart = index.nodeStarts[nodeIndex + 1]
      if (nextStart === offset) continue
    }
    return { node: index.nodes[nodeIndex], offset: offset - start }
  }
  const lastNode = index.nodes[index.nodes.length - 1]
  return { node: lastNode, offset: lastNode.nodeValue?.length ?? 0 }
}

/**
 * 选段（quote/offsets）→ 渲染 DOM Range（高亮用）。
 *
 * 只在能**唯一**定位 quote 时返回 Range；否则 null（调用方显示
 * `position_unavailable`，不伪造高亮、不滚动到错误位置）。
 */
export function domRangeForSelection(input: {
  readonly chunkRoot: HTMLElement
  readonly selection: { readonly quote: string | null }
}): Range | null {
  const quote = input.selection.quote
  if (quote === null || quote.length === 0) return null
  const rendered = buildRenderedTextIndex(input.chunkRoot)
  if (rendered.text.length === 0) return null
  const normalizedRendered = normalizeSelectionText(rendered.text)
  const normalizedQuote = normalizeSelectionText(quote)
  if (normalizedQuote.normalized.length === 0) return null
  const startInNormalized = normalizedRendered.normalized.indexOf(normalizedQuote.normalized)
  if (startInNormalized < 0) return null
  if (
    normalizedRendered.normalized.indexOf(
      normalizedQuote.normalized,
      startInNormalized + 1,
    ) >= 0
  ) {
    return null
  }
  const renderedStart = normalizedRendered.offsets[startInNormalized]
  const renderedEnd =
    normalizedRendered.offsets[startInNormalized + normalizedQuote.normalized.length]
  if (renderedEnd <= renderedStart) return null
  const startPoint = domPointAt(rendered, renderedStart, 'start')
  const endPoint = domPointAt(rendered, renderedEnd, 'end')
  if (startPoint === null || endPoint === null) return null
  try {
    const range = document.createRange()
    range.setStart(startPoint.node, startPoint.offset)
    range.setEnd(endPoint.node, endPoint.offset)
    return range
  } catch {
    return null
  }
}
