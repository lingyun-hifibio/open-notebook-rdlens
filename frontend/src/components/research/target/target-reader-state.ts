/**
 * 目标壳宽屏阅读器状态/页边界纯逻辑（Issue #1077 W2；合并计划 §2.3/§2.4/
 * §2.6/§2.9/§2.10-5/7/9）。
 *
 * 职责边界：
 * - 入口请求归一化（UI-13 引用预览 / UI-17 资料预览 / 引用跳转的初始页）；
 * - citation ↔ source detail 的**版本护栏**（match / mismatch / unverifiable /
 *   latest）；mismatch 不回退最新版，unverifiable 不按 citation 页/ chunk 定位；
 * - 可定位页集合与初始页（`markdown_chunks[].page_idx ∪ 引用页`，引用页只在
 *   版本可核对时并入）；页导航只在该集合内移动，**不伪造总页数、不探测未知页**；
 * - 组件不做数据拉取：本模块不依赖 React/网络/全局状态。
 *
 * 锚点：UI 规格 v1 §5.7/§5.6 UI-13；路线图 §12.3；Round-4 B4-L3。
 */

import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ResearchChunk } from '@/lib/types/research'

/** 被引版本（source detail 成对 query 参数；§2.3/§2.4）。 */
export interface TargetReaderDocumentRef {
  documentId: string
  documentVersion: string
}

/** 入口来源：UI-13 引用预览（携带 citation 身份与版本）或 UI-17 资料预览。 */
export type TargetReaderOrigin = 'citation' | 'source'

/**
 * 阅读器打开请求（由 `TargetRightPane` 的「打开原文」构造，`TargetShell` 持有）。
 *
 * `documentRef` 同时作为 source detail 与页图的成对版本参数；`null` 表示按
 * 最新版读取（source 入口）或版本不可核对（citation 缺 doc_id/doc_version）。
 */
export interface TargetReaderOpenRequest {
  origin: TargetReaderOrigin
  sourceId: string
  /** citation 入口携带被引 citation；source 入口为 null。 */
  citation: ResearchCitationDisplayItem | null
  /** citation 点击时的 durable message id（返回原回答用）；否则 null。 */
  messageId: string | null
  /** citation 的成对版本；缺一/非法 → null。 */
  documentRef: TargetReaderDocumentRef | null
  /** 0-based 初始页提示（citation page_idx / source initial_page_idx）。 */
  initialPageIdx: number | null
}

function normalizePageIdx(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** UI-13 引用预览入口：携带 citation 身份、durable message id 与成对版本。 */
export function citationReaderRequest(input: {
  citation: ResearchCitationDisplayItem
  sourceId: string
  messageId: string | null
}): TargetReaderOpenRequest {
  const { citation, sourceId, messageId } = input
  const documentVersion =
    typeof citation.doc_version === 'string' && citation.doc_version.length > 0
      ? citation.doc_version
      : null
  const documentId =
    typeof citation.doc_id === 'string' && citation.doc_id.length > 0 ? citation.doc_id : null
  const documentRef =
    documentId !== null && documentVersion !== null
      ? { documentId, documentVersion }
      : null
  return {
    origin: 'citation',
    sourceId,
    citation,
    messageId: typeof messageId === 'string' && messageId.length > 0 ? messageId : null,
    documentRef,
    initialPageIdx: normalizePageIdx(citation.page_idx),
  }
}

/** UI-17 资料预览入口（also 引用跳转进资料预览后的再入）：按最新版读取。 */
export function sourceReaderRequest(input: {
  sourceId: string
  initialPageIdx?: number | null
}): TargetReaderOpenRequest {
  return {
    origin: 'source',
    sourceId: input.sourceId,
    citation: null,
    messageId: null,
    documentRef: null,
    initialPageIdx: normalizePageIdx(input.initialPageIdx ?? null),
  }
}

/**
 * §2.4 版本护栏状态。
 *
 * - `latest`：source 入口，按最新版读取；
 * - `unverifiable`：citation 缺成对版本（或 detail 未到，不能提前宣称一致）；
 * - `mismatch`：citation 版本与 source detail 不一致（422/版本漂移）；
 * - `match`：版本一致，允许用 citation 的 chunk/page 做摘录与定位。
 */
export type TargetReaderVersionState =
  | { kind: 'latest' }
  | { kind: 'unverifiable' }
  | { kind: 'mismatch' }
  | { kind: 'match' }

export function resolveReaderVersionState(
  request: TargetReaderOpenRequest,
  detail: { document_id: string; document_version: string } | null,
): TargetReaderVersionState {
  if (request.origin === 'source') return { kind: 'latest' }
  if (request.documentRef === null) return { kind: 'unverifiable' }
  if (detail === null) return { kind: 'unverifiable' }
  if (
    detail.document_id === request.documentRef.documentId &&
    detail.document_version === request.documentRef.documentVersion
  ) {
    return { kind: 'match' }
  }
  return { kind: 'mismatch' }
}

/**
 * §2.4：可定位页集合 = `markdown_chunks[].page_idx(≥0)`（升序去重）
 * ∪ `{citation.page_idx}`（**仅** `match` 时并入；B4-L3：不可核对/不一致/最新版
 * 入口不得把 citation 页并入集合或初始页）。
 */
export function locateReaderPages(input: {
  chunks: readonly Pick<ResearchChunk, 'page_idx'>[]
  citationPageIdx: number | null | undefined
  versionState: TargetReaderVersionState
}): number[] {
  const pages = new Set<number>()
  for (const chunk of input.chunks) {
    const pageIdx = normalizePageIdx(chunk.page_idx)
    if (pageIdx !== null) pages.add(pageIdx)
  }
  if (input.versionState.kind === 'match') {
    const citationPage = normalizePageIdx(input.citationPageIdx)
    if (citationPage !== null) pages.add(citationPage)
  }
  return [...pages].sort((a, b) => a - b)
}

/**
 * §2.3/§2.10-5：初始页 = 请求页（合法且属于集合）否则可定位页集合首页；
 * 集合空 → null（不显示页导航/不伪造页）。
 *
 * 版本不可核对/不一致时不采用 citation 页（B4-L3）；source 入口的
 * `initial_page_idx` 是用户/引用跳转的提示页，合法时优先。
 */
export function resolveReaderInitialPage(
  pages: readonly number[],
  requestedPageIdx: number | null | undefined,
  versionState: TargetReaderVersionState,
): number | null {
  if (pages.length === 0) return null
  const requested = normalizePageIdx(requestedPageIdx)
  if (
    requested !== null &&
    versionState.kind !== 'unverifiable' &&
    versionState.kind !== 'mismatch' &&
    pages.includes(requested)
  ) {
    return requested
  }
  return pages[0]
}

/**
 * §2.4/§2.10-7：页导航只在可定位页集合内移动。
 *
 * 当前页不在集合（异常/陈旧状态）时取方向上最近的集合页；无则 null。
 */
export function readerPageNeighbor(
  pages: readonly number[],
  currentPageIdx: number,
  direction: -1 | 1,
): number | null {
  if (pages.length === 0) return null
  if (pages.includes(currentPageIdx)) {
    const index = pages.indexOf(currentPageIdx)
    const target = index + direction
    return target >= 0 && target < pages.length ? pages[target] : null
  }
  if (direction === -1) {
    let candidate: number | null = null
    for (const page of pages) {
      if (page < currentPageIdx) candidate = page
    }
    return candidate
  }
  for (const page of pages) {
    if (page > currentPageIdx) return page
  }
  return null
}
