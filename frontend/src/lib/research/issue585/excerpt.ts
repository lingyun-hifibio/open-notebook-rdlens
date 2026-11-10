/**
 * Issue #1047 PR5（D2-B3）：摘入片段与引用显示的**纯逻辑层**。
 *
 * 权威依据（只收窄、不放宽）：
 * - issue #1047「片段入文档与引用往返」PR5 行与「必须验证」清单；
 * - 方案 v4 §5（统一来源描述 / UTF-16 半开区间 / 原始 Markdown 确认层 /
 *   稳定 binding_id）、§5.1（已有/新目标）、§5.2（引用核查往返）、§10；
 * - 冻结契约 `deploy/research/issue585_d2_contract_v1.yaml` §3/§4 与 host
 *   B0 模块 `mutation_contract.normalize_source_selection` /
 *   `normalize_target_selection`。
 *
 * 跨仓约定（host B3 与 fork B3 逐字节一致，frontend-dev ⇄ backend-dev）：
 * - marker 语法 `[[cite:<binding_id>]]`；binding_id 满足 `[A-Za-z0-9_-]{1,128}`；
 *   marker 是**显示语法**，零权限/来源语义；未知或畸形 marker 按纯文本展示；
 * - 四类来源快照文本：`source` = `markdown_chunks` 按 `chunk_ordinal` 升序以
 *   `"\n\n"` join；`chat_message`/`legacy_insight`/`note` = 记录 `content` 原串；
 * - `expected_content_hash = sha256(UTF-8(快照文本))` 的小写十六进制；
 * - `selection.range` 的 start/end 是快照文本的 **UTF-16 半开区间**，不得切开
 *   代理对；渲染 DOM 偏移不得直接当 Markdown 偏移（调用方必须经原始 Markdown
 *   确认层），本模块只做纯文本/偏移计算。
 *
 * 本模块不 import React/网络/存储，可在 vitest 中直接单测。
 */

import { sha256Hex, utf8Bytes } from '@/lib/research/session-idempotency'
import type {
  NoteCitationBinding,
  NoteCitationSourceKind,
  NoteFragmentSelection,
  NoteFragmentSourceDescriptor,
  NoteFragmentTargetDescriptor,
  NoteLocator,
} from './types'

/** marker 前缀/完整正则（与 host B3 冻结语法逐字一致）。 */
export const CITE_MARKER_PREFIX = '[[cite:'
export const CITE_MARKER_SUFFIX = ']]'
export const CITE_MARKER_PATTERN_SOURCE = '\\[\\[cite:([A-Za-z0-9_-]{1,128})\\]\\]'

/** 稳定 id 形状（binding_id / note_id / message_id 共用；host `STABLE_ID_PATTERN`）。 */
const STABLE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Note 来源版本形状 `<revision>:<snapshot_hash>`（host `NOTE_SOURCE_VERSION_PATTERN`）。 */
const NOTE_SOURCE_VERSION_RE = /^([1-9][0-9]{0,9}):([0-9a-f]{64})$/

/** 单次摘入片段 UTF-8 上限（host B3 安全上限 1 MiB，超限 422）。 */
export const EXCERPT_MAX_UTF8_BYTES = 1024 * 1024

/** 摘入选区校验失败原因（稳定、可测试；UI 映射文案后要求用户重选）。 */
export type ExcerptSelectionFailure =
  | 'out_of_bounds'
  | 'invalid_range'
  | 'empty_selection'
  | 'surrogate_split'
  | 'too_large'
  | 'invalid_source_version'

/** 来源描述构造结果。 */
export type ExcerptSourceBuildResult =
  | { readonly ok: true; readonly source: NoteFragmentSourceDescriptor; readonly text: string }
  | { readonly ok: false; readonly reason: ExcerptSelectionFailure }

export function isStableId(value: unknown): value is string {
  return typeof value === 'string' && STABLE_ID_RE.test(value)
}

export function isCitationSourceKind(value: unknown): value is NoteCitationSourceKind {
  return (
    value === 'source' ||
    value === 'chat_message' ||
    value === 'note' ||
    value === 'legacy_insight'
  )
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** offset 是否切在一个代理对中间（UTF-16 半开区间不允许）。 */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  return isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset))
}

/** UTF-8 字节数（未配对 surrogate 计为 3 字节，仅用于上限预检；提交由服务端拒绝）。 */
export function excerptUtf8Bytes(text: string): number {
  return utf8Bytes(text).byteLength
}

/** 快照文本摘要（`expected_content_hash`；小写 hex64）。 */
export function excerptContentHash(text: string): string {
  return sha256Hex(text)
}

// ---------------------------------------------------------------------------
// marker 解析 / 编号 / 预览装饰
// ---------------------------------------------------------------------------

export type CitationMarkerSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'citation'; readonly bindingId: string; readonly raw: string }

/**
 * 把正文切成「文本 / marker」片段。
 *
 * 畸形或未闭合的 `[[cite:…` 原样留在文本片段里（fail-safe：不猜测、不丢字符、
 * 不会抛异常）；同一 binding 的多个 marker 全部保留（编号取首次出现）。
 */
export function splitCitationMarkers(content: string): CitationMarkerSegment[] {
  const segments: CitationMarkerSegment[] = []
  if (typeof content !== 'string' || content.length === 0) return segments
  const pattern = new RegExp(CITE_MARKER_PATTERN_SOURCE, 'g')
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const start = match.index
    if (start > cursor) {
      segments.push({ kind: 'text', text: content.slice(cursor, start) })
    }
    segments.push({
      kind: 'citation',
      bindingId: match[1],
      raw: match[0],
    })
    cursor = start + match[0].length
  }
  if (cursor < content.length) {
    segments.push({ kind: 'text', text: content.slice(cursor) })
  }
  return segments
}

/** 文档内引用编号：正文首次出现顺序；未出现在正文的 binding 追加在末尾。 */
export interface CitationNumbering {
  /** binding_id → 1-based 显示编号（只含已知 binding）。 */
  readonly numbers: ReadonlyMap<string, number>
  /** 按显示编号排序的 binding 列表（已知 binding；未知 marker 不计入）。 */
  readonly bindings: readonly NoteCitationBinding[]
  /** 正文里出现但不在投影中的 binding_id（未知；调用方 fail-safe 成纯文本）。 */
  readonly unknownBindingIds: readonly string[]
}

export function buildCitationNumbering(
  content: string,
  bindings: readonly NoteCitationBinding[],
): CitationNumbering {
  const byId = new Map<string, NoteCitationBinding>()
  for (const binding of bindings) {
    if (!byId.has(binding.binding_id)) byId.set(binding.binding_id, binding)
  }
  const numbers = new Map<string, number>()
  const ordered: NoteCitationBinding[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const segment of splitCitationMarkers(content)) {
    if (segment.kind !== 'citation') continue
    if (seen.has(segment.bindingId)) continue
    seen.add(segment.bindingId)
    const binding = byId.get(segment.bindingId)
    if (binding === undefined) {
      unknown.push(segment.bindingId)
      continue
    }
    numbers.set(binding.binding_id, ordered.length + 1)
    ordered.push(binding)
  }
  for (const binding of bindings) {
    if (seen.has(binding.binding_id)) continue
    if (!byId.has(binding.binding_id)) continue
    numbers.set(binding.binding_id, ordered.length + 1)
    ordered.push(binding)
  }
  return { numbers, bindings: ordered, unknownBindingIds: unknown }
}

/** 正文 marker → 预览用锚点 `[n](#cite-<binding_id>)`；未知 binding 原样保留。 */
export function decorateCitationMarkersForPreview(
  content: string,
  numbering: CitationNumbering,
): string {
  if (content.length === 0) return content
  let output = ''
  for (const segment of splitCitationMarkers(content)) {
    if (segment.kind === 'text') {
      output += segment.text
      continue
    }
    const number = numbering.numbers.get(segment.bindingId)
    if (number === undefined) {
      output += segment.raw
      continue
    }
    output += `[${number}](#cite-${segment.bindingId})`
  }
  return output
}

/** 预览锚点 `#cite-<binding_id>` → binding_id；非法返回 null（fail-safe）。 */
export function parseCitationAnchorHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null
  if (!href.startsWith('#cite-')) return null
  const bindingId = href.slice('#cite-'.length)
  return isStableId(bindingId) ? bindingId : null
}

// ---------------------------------------------------------------------------
// UTF-16 选区（快照文本）
// ---------------------------------------------------------------------------

export interface ExcerptTextSelection {
  /** 快照文本（源原串；不 strip/不归一化）。 */
  readonly text: string
  readonly selection: NoteFragmentSelection
}

/** 校验并返回摘录文本；范围是 UTF-16 半开区间，拒绝代理对切分/越界/空摘录。 */
export function resolveExcerptSelection(
  text: string,
  selection: NoteFragmentSelection,
): { readonly ok: true; readonly excerpt: string; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly reason: ExcerptSelectionFailure } {
  if (selection.kind === 'full') {
    if (text.length === 0) return { ok: false, reason: 'empty_selection' }
    if (excerptUtf8Bytes(text) > EXCERPT_MAX_UTF8_BYTES) {
      return { ok: false, reason: 'too_large' }
    }
    return { ok: true, excerpt: text, start: 0, end: text.length }
  }
  const { start_utf16: start, end_utf16: end } = selection
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < 0
  ) {
    return { ok: false, reason: 'invalid_range' }
  }
  if (start > text.length || end > text.length) {
    return { ok: false, reason: 'out_of_bounds' }
  }
  if (start >= end) return { ok: false, reason: 'empty_selection' }
  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) {
    return { ok: false, reason: 'surrogate_split' }
  }
  const excerpt = text.slice(start, end)
  if (excerpt.length === 0) return { ok: false, reason: 'empty_selection' }
  if (excerptUtf8Bytes(excerpt) > EXCERPT_MAX_UTF8_BYTES) {
    return { ok: false, reason: 'too_large' }
  }
  return { ok: true, excerpt, start, end }
}

/** 来源版本形状校验（按 source_kind；host `normalize_source_selection` 同口径）。 */
export function isSourceVersionValid(
  sourceKind: NoteCitationSourceKind,
  sourceVersion: string | null,
): boolean {
  if (sourceKind === 'source') {
    return typeof sourceVersion === 'string' && sourceVersion.length > 0 && sourceVersion.length <= 128
  }
  if (sourceKind === 'note') {
    return typeof sourceVersion === 'string' && NOTE_SOURCE_VERSION_RE.test(sourceVersion)
  }
  return sourceVersion === null
}

/**
 * 构造片段来源描述（wire 形状；由服务端解析可信快照，不提交来源全文）。
 *
 * 前端**不提交**摘录正文：只提交来源身份/版本/预期摘要/UTF-16 选区，正文由
 * 服务端从同一已验证快照解析。
 */
export function buildFragmentSource(input: {
  readonly sourceKind: NoteCitationSourceKind
  readonly sourceId: string
  readonly sourceVersion: string | null
  readonly text: string
  readonly selection: NoteFragmentSelection
}): ExcerptSourceBuildResult {
  if (!isCitationSourceKind(input.sourceKind)) {
    return { ok: false, reason: 'invalid_source_version' }
  }
  if (!isStableId(input.sourceId) && input.sourceKind !== 'source') {
    return { ok: false, reason: 'invalid_source_version' }
  }
  if (input.sourceKind === 'source' && !/^[A-Za-z0-9_:-]{1,256}$/.test(input.sourceId)) {
    return { ok: false, reason: 'invalid_source_version' }
  }
  if (!isSourceVersionValid(input.sourceKind, input.sourceVersion)) {
    return { ok: false, reason: 'invalid_source_version' }
  }
  const resolved = resolveExcerptSelection(input.text, input.selection)
  if (!resolved.ok) return resolved
  return {
    ok: true,
    text: resolved.excerpt,
    source: {
      source_kind: input.sourceKind,
      source_id: input.sourceId,
      source_version: input.sourceVersion,
      expected_content_hash: excerptContentHash(input.text),
      selection: input.selection,
    },
  }
}

// ---------------------------------------------------------------------------
// raw Markdown 确认层：quote → 快照文本偏移
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 插入目标 / 插入后光标（不依赖 DOM）
// ---------------------------------------------------------------------------

/** 编辑器当前 UTF-16 光标/选区（textarea `selectionStart/End`）。 */
export interface EditorTextSelection {
  readonly start: number
  readonly end: number
}

/**
 * 编辑器选区 → 片段目标：折叠 = 光标插入；非折叠 = 选区替换。
 * 越界（含代理对切分）返回 null，调用方必须提示用户重选而不是盲目提交。
 */
export function buildFragmentTarget(
  content: string,
  selection: EditorTextSelection | null,
  fallback: 'append' | 'start' = 'append',
): NoteFragmentTargetDescriptor | null {
  if (selection === null) {
    return fallback === 'start'
      ? { kind: 'cursor', position_utf16: 0 }
      : { kind: 'cursor', position_utf16: content.length }
  }
  const start = Math.max(0, Math.min(selection.start, content.length))
  const end = Math.max(0, Math.min(selection.end, content.length))
  if (splitsSurrogatePair(content, start) || splitsSurrogatePair(content, end)) return null
  if (start === end) return { kind: 'cursor', position_utf16: start }
  return { kind: 'range', start_utf16: Math.min(start, end), end_utf16: Math.max(start, end) }
}

/**
 * 插入前/后正文 → 新正文里的插入区间 `{start, end}`（光标恢复到 end）。
 *
 * 服务端 `insert_text = excerpt + markers` 追加在目标位置（cursor）或替换目标
 * 区间（range），因此新正文 = 旧正文在目标位置插入一段文本。用公共前缀/后缀
 * 求插入区间：不假设插入文本长度、不依赖回执加性键。
 */
export function computeInsertedRange(
  before: string,
  after: string,
): { readonly start: number; readonly end: number } | null {
  if (before === after) return null
  const maxPrefix = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1
  // 前缀落在代理对中间时退到安全边界（不切分 emoji）。
  if (splitsSurrogatePair(after, prefix)) prefix -= 1
  let suffix = 0
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix)
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  if (splitsSurrogatePair(after, after.length - suffix)) suffix -= 1
  const start = prefix
  const end = after.length - suffix
  if (end < start) return { start: prefix, end: prefix }
  return { start, end }
}

// ---------------------------------------------------------------------------
// locator（binding 的定位标量袋；语义按 B3 约定）
// ---------------------------------------------------------------------------

export interface SourceCitationLocator {
  readonly document_version: string | null
  readonly content_hash: string | null
  readonly chunk_id: string | null
  readonly chunk_ordinal: number | null
  readonly page_idx: number | null
  readonly start_utf16: number | null
  readonly end_utf16: number | null
}

export interface ChatMessageCitationLocator {
  readonly surface: 'global' | 'source' | null
  readonly source_id: string | null
  readonly session_id: string | null
  readonly message_id: string | null
  readonly start_utf16: number | null
  readonly end_utf16: number | null
  readonly content_hash: string | null
}

export interface LegacyInsightCitationLocator {
  readonly insight_id: string | null
  readonly start_utf16: number | null
  readonly end_utf16: number | null
  readonly content_hash: string | null
}

export interface NoteCitationLocator {
  readonly start_utf16: number | null
  readonly end_utf16: number | null
  readonly content_hash: string | null
}

function readLocatorString(locator: NoteLocator | null, key: string): string | null {
  if (locator === null) return null
  const value = locator[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readLocatorInt(locator: NoteLocator | null, key: string): number | null {
  if (locator === null) return null
  const value = locator[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < -9007199254740991 || value > 9007199254740991) return null
  return value
}

function readLocatorNonNegativeInt(locator: NoteLocator | null, key: string): number | null {
  const value = readLocatorInt(locator, key)
  return value !== null && value >= 0 ? value : null
}

export function readSourceCitationLocator(
  binding: Pick<NoteCitationBinding, 'locator'>,
): SourceCitationLocator | null {
  const locator = binding.locator
  if (locator === null) return null
  const documentVersion = readLocatorString(locator, 'document_version')
  const rawContentHash = readLocatorString(locator, 'content_hash')
  const contentHash =
    rawContentHash !== null && /^[0-9a-f]{64}$/.test(rawContentHash) ? rawContentHash : null
  const chunkId = readLocatorString(locator, 'chunk_id')
  const chunkOrdinal = readLocatorNonNegativeInt(locator, 'chunk_ordinal')
  const pageIdx = readLocatorNonNegativeInt(locator, 'page_idx')
  const start = readLocatorNonNegativeInt(locator, 'start_utf16')
  const end = readLocatorNonNegativeInt(locator, 'end_utf16')
  if (
    documentVersion === null &&
    contentHash === null &&
    chunkId === null &&
    chunkOrdinal === null &&
    pageIdx === null &&
    start === null &&
    end === null
  ) {
    return null
  }
  return {
    document_version: documentVersion,
    content_hash: contentHash,
    chunk_id: chunkId,
    chunk_ordinal: chunkOrdinal,
    page_idx: pageIdx,
    start_utf16: start === null || end === null || start >= end ? null : start,
    end_utf16: start === null || end === null || start >= end ? null : end,
  }
}

export function readChatMessageCitationLocator(
  binding: Pick<NoteCitationBinding, 'locator'>,
): ChatMessageCitationLocator | null {
  const locator = binding.locator
  if (locator === null) return null
  const rawSurface = readLocatorString(locator, 'surface')
  const surface = rawSurface === 'global' || rawSurface === 'source' ? rawSurface : null
  const sourceId = readLocatorString(locator, 'source_id')
  const sessionId = readLocatorString(locator, 'session_id')
  const messageId = readLocatorString(locator, 'message_id')
  const start = readLocatorNonNegativeInt(locator, 'start_utf16')
  const end = readLocatorNonNegativeInt(locator, 'end_utf16')
  const rawContentHash = readLocatorString(locator, 'content_hash')
  const contentHash =
    rawContentHash !== null && /^[0-9a-f]{64}$/.test(rawContentHash) ? rawContentHash : null
  if (
    surface === null &&
    sourceId === null &&
    sessionId === null &&
    messageId === null &&
    start === null &&
    end === null &&
    contentHash === null
  ) {
    return null
  }
  return {
    surface,
    source_id: sourceId,
    session_id: sessionId,
    message_id: messageId,
    start_utf16: start === null || end === null || start >= end ? null : start,
    end_utf16: start === null || end === null || start >= end ? null : end,
    content_hash: contentHash,
  }
}

export function readLegacyInsightCitationLocator(
  binding: Pick<NoteCitationBinding, 'locator'>,
): LegacyInsightCitationLocator | null {
  const locator = binding.locator
  if (locator === null) return null
  const insightId = readLocatorString(locator, 'insight_id')
  const start = readLocatorNonNegativeInt(locator, 'start_utf16')
  const end = readLocatorNonNegativeInt(locator, 'end_utf16')
  const rawContentHash = readLocatorString(locator, 'content_hash')
  const contentHash =
    rawContentHash !== null && /^[0-9a-f]{64}$/.test(rawContentHash) ? rawContentHash : null
  if (insightId === null && start === null && end === null && contentHash === null) return null
  return {
    insight_id: insightId,
    start_utf16: start === null || end === null || start >= end ? null : start,
    end_utf16: start === null || end === null || start >= end ? null : end,
    content_hash: contentHash,
  }
}

export function readNoteCitationLocator(
  binding: Pick<NoteCitationBinding, 'locator'>,
): NoteCitationLocator | null {
  const locator = binding.locator
  if (locator === null) return null
  const start = readLocatorNonNegativeInt(locator, 'start_utf16')
  const end = readLocatorNonNegativeInt(locator, 'end_utf16')
  const rawContentHash = readLocatorString(locator, 'content_hash')
  const contentHash =
    rawContentHash !== null && /^[0-9a-f]{64}$/.test(rawContentHash) ? rawContentHash : null
  if (start === null && end === null && contentHash === null) return null
  return {
    start_utf16: start === null || end === null || start >= end ? null : start,
    end_utf16: start === null || end === null || start >= end ? null : end,
    content_hash: contentHash,
  }
}

/** `source_version`（note 来源）`<revision>:<snapshot_hash>` → `{revision, hash}`。 */
export function parseNoteSourceVersion(
  value: string | null,
): { readonly revision: number; readonly snapshotHash: string } | null {
  if (typeof value !== 'string') return null
  const match = NOTE_SOURCE_VERSION_RE.exec(value)
  if (match === null) return null
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision) || revision < 1) return null
  return { revision, snapshotHash: match[2] }
}

/** 绑定对应的 note 版本标识（用于与当前读投影比对“旧版”）。 */

// ---------------------------------------------------------------------------
// source 快照 join / 引用阅读定位（host B3 locator：joined 文本 UTF-16 偏移）
// ---------------------------------------------------------------------------

/** `markdown_chunks` 的最小形状（来源详情响应；ordinal 缺失时按数组顺序）。 */
export interface SourceSnapshotChunk {
  readonly chunk_id: string
  readonly chunk_ordinal?: number | null
  readonly page_idx?: number | null
  readonly markdown: string
  readonly content_hash?: string | null
}

/** 来源快照文本：按 `chunk_ordinal` 升序、以 `"\n\n"` join（host 唯一口径）。 */
export function joinSourceSnapshotText(chunks: readonly SourceSnapshotChunk[]): string {
  return [...chunks]
    .map((chunk, index) => ({ chunk, index }))
    .sort((left, right) => {
      const leftOrdinal = left.chunk.chunk_ordinal ?? left.index
      const rightOrdinal = right.chunk.chunk_ordinal ?? right.index
      return leftOrdinal - rightOrdinal || left.index - right.index
    })
    .map((entry) => entry.chunk.markdown)
    .join('\n\n')
}

/** 引用阅读定位输入（来源 binding locator 的规范化投影）。 */
export interface SourceCitationReadingLocator {
  readonly document_version: string | null
  readonly content_hash: string | null
  readonly start_utf16: number
  readonly end_utf16: number
}

/** 来源引用阅读状态（明确状态，不伪造定位）。 */
export type SourceCitationReadingState =
  | 'ok'
  | 'old_version'
  | 'content_mismatch'
  | 'position_unavailable'

export interface SourceCitationReading {
  readonly state: SourceCitationReadingState
  /** 命中的 chunk_id（按文档顺序）；state=ok 时至少一个。 */
  readonly chunkIds: readonly string[]
  readonly pageIdxs: readonly number[]
  /** 与 locator 同口径的 UTF-16 区间（state=ok 时有效）。 */
  readonly start: number
  readonly end: number
}

/**
 * 把来源 binding 的 joined-text 偏移映射回 chunk/page：
 * - 版本不同 → `old_version`（不把旧 offset 套到新正文）；
 * - joined 文本摘要不符 → `content_mismatch`；
 * - 偏移越界/切代理对 → `position_unavailable`；
 * - 否则返回覆盖该区间的 chunk 与 page（供滚动/ring 高亮）。
 */
export function resolveSourceCitationReading(
  chunks: readonly SourceSnapshotChunk[],
  locator: SourceCitationReadingLocator | null,
  currentDocumentVersion: string | null,
): SourceCitationReading {
  const empty: SourceCitationReading = {
    state: 'position_unavailable',
    chunkIds: [],
    pageIdxs: [],
    start: 0,
    end: 0,
  }
  if (locator === null) return empty
  if (
    locator.document_version !== null &&
    currentDocumentVersion !== null &&
    locator.document_version !== currentDocumentVersion
  ) {
    return { ...empty, state: 'old_version' }
  }
  const ordered = [...chunks]
    .map((chunk, index) => ({ chunk, index }))
    .sort((left, right) => {
      const leftOrdinal = left.chunk.chunk_ordinal ?? left.index
      const rightOrdinal = right.chunk.chunk_ordinal ?? right.index
      return leftOrdinal - rightOrdinal || left.index - right.index
    })
    .map((entry) => entry.chunk)
  const text = joinSourceSnapshotText(ordered)
  if (locator.content_hash !== null && excerptContentHash(text) !== locator.content_hash) {
    return { ...empty, state: 'content_mismatch' }
  }
  const { start_utf16: start, end_utf16: end } = locator
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= end ||
    end > text.length
  ) {
    return empty
  }
  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) {
    return empty
  }
  const chunkIds: string[] = []
  const pageIdxs: number[] = []
  let offset = 0
  for (const chunk of ordered) {
    const chunkStart = offset
    const chunkEnd = offset + chunk.markdown.length
    // 与 [start,end) 有交集（空 chunk 不参与）。
    if (chunk.markdown.length > 0 && chunkStart < end && chunkEnd > start) {
      if (!chunkIds.includes(chunk.chunk_id)) chunkIds.push(chunk.chunk_id)
      if (
        typeof chunk.page_idx === 'number' &&
        Number.isInteger(chunk.page_idx) &&
        chunk.page_idx >= 0 &&
        !pageIdxs.includes(chunk.page_idx)
      ) {
        pageIdxs.push(chunk.page_idx)
      }
    }
    offset = chunkEnd + 2 // "\n\n"
  }
  if (chunkIds.length === 0) return empty
  return { state: 'ok', chunkIds, pageIdxs, start, end }
}

/** 正文切片高亮：返回 [before, quote, after]（越界/切代理对返回 null）。 */
export function splitTextForHighlight(
  text: string,
  start: number,
  end: number,
): { readonly before: string; readonly quote: string; readonly after: string } | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= end ||
    end > text.length
  ) {
    return null
  }
  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) return null
  return { before: text.slice(0, start), quote: text.slice(start, end), after: text.slice(end) }
}

/** 摘要校验（引用阅读：locator.content_hash 与快照文本一致）。 */
export function citationContentHashMatches(text: string, expected: string | null): boolean {
  if (expected === null) return true
  if (!/^[0-9a-f]{64}$/.test(expected)) return false
  return excerptContentHash(text) === expected
}
