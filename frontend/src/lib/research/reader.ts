/**
 * 目标壳宽屏阅读器纯函数（Issue #1077 W2；合并计划 §2.4/§2.5/§2.10）。
 *
 * 唯一职责：把来源声明格式 + `markdown_chunks` 映射为**正文模式/定位标签/
 * 可读正文块/被引摘录/下载回退文件名**。组件不自行解释格式或猜测页码。
 *
 * 边界（计划 §2.4/§2.10）：
 * - `page_idx` 仍是唯一 0-based 持久化位置，展示时 +1；本模块不引入
 *   page_number/slide/cell 字段，也不伪造总页数（无服务端 `page_count`）；
 * - PDF/PPT 页模式正文块 = 同页 `markdown_chunks`，**排除 #1031 已知无位置
 *   兜底 chunk**（PPT toc：`chunk_id` 以 `_toc` 结尾 + `page_idx=0`）；
 * - XLSX/DOCX/CSV/其他按 `markdown_chunks` 顺序渲染全局正文，兜底 chunk 保留
 *   但标注「位置未知（#1031）」；
 * - 被引摘录：版本护栏由调用方（`target-reader-state`/`use-source-media`）
 *   先判定为 `match`；本模块只做 chunk_id 优先 / page_idx 首块的确定性匹配，
 *   兜底 chunk 不作为同页原文依据（无法与真实第 1 页区分时回退 claim）；
 * - 嵌入跨域下 `Content-Disposition` 不在 CORS `expose_headers`（#1080 OPEN），
 *   下载文件名按前端回退（title/document_id + 声明格式扩展名）。
 *
 * 纯函数、无 React/网络/全局状态依赖。
 */

import type { ResearchChunk } from '@/lib/types/research'
import {
  normalizeSourceType,
  type SourceLocatorKind,
  type SourceMediaFormat,
} from './source-media'

/** 正文实现：页图（pdf/ppt）或规范化正文（xlsx/docx/csv/其他/未知）。 */
export type ReaderBodyMode = 'page-image' | 'normalized-text'

/** §2.4：只有 pdf/ppt 有页图渲染能力。 */
export function readerSupportsPageImage(
  sourceType: string | null | undefined,
): boolean {
  const format = normalizeSourceType(sourceType)
  return format === 'pdf' || format === 'ppt'
}

/** §2.4：正文模式（未知/缺失一律规范化正文，不伪造页图，fail-closed）。 */
export function readerBodyMode(sourceType: string | null | undefined): ReaderBodyMode {
  return readerSupportsPageImage(sourceType) ? 'page-image' : 'normalized-text'
}

/** §2.4 定位语义（page/slide/sheet）；docx/csv/其他/未知 → null（无可用定位）。 */
export function readerLocatorKind(
  sourceType: string | null | undefined,
): SourceLocatorKind | null {
  const format = normalizeSourceType(sourceType)
  if (format === 'pdf') return 'page'
  if (format === 'ppt') return 'slide'
  if (format === 'xlsx') return 'sheet'
  return null
}

const LOCATOR_KEY: Record<SourceLocatorKind, string> = {
  page: 'research.target.reader.locatorPage',
  slide: 'research.target.reader.locatorSlide',
  sheet: 'research.target.reader.locatorSheet',
}

/** 定位标签 i18n key（null = 无可用定位，不显示页码控件）。 */
export function readerLocatorKey(
  sourceType: string | null | undefined,
): string | null {
  const kind = readerLocatorKind(sourceType)
  return kind === null ? null : LOCATOR_KEY[kind]
}

/** §2.4/#1031：已知无位置回退 chunk（PPT toc 的 `page_idx=0` 兜底）。 */
export function isFallbackPositionChunk(
  chunk: Pick<ResearchChunk, 'chunk_id' | 'page_idx'>,
): boolean {
  return chunk.page_idx === 0 && /_toc$/i.test(chunk.chunk_id)
}

/**
 * §2.4/§2.10-6：PDF/PPT 页模式正文块。
 *
 * 只返回同页 chunk，并排除 #1031 兜底 chunk（它不代表真实第 1 页正文）。
 */
export function readerPageChunks(
  chunks: readonly ResearchChunk[],
  pageIdx: number,
): ResearchChunk[] {
  return chunks.filter(
    (chunk) => chunk.page_idx === pageIdx && !isFallbackPositionChunk(chunk),
  )
}

/** XLSX/DOCX/CSV 全局正文：按输入顺序保留全部 chunk，并标记兜底 chunk。 */
export function readerNormalizedChunks(
  chunks: readonly ResearchChunk[],
): Array<{ chunk: ResearchChunk; fallback: boolean }> {
  return chunks.map((chunk) => ({ chunk, fallback: isFallbackPositionChunk(chunk) }))
}

export interface CitedExcerptMatch {
  /** 命中的原文块；null = 无可用原文（调用方回退 claim 并标注）。 */
  chunk: ResearchChunk | null
  /** 是否命中/遇到 #1031 兜底 chunk（只显示限制说明，不冒称原文）。 */
  fallback: boolean
}

/**
 * §2.5-1/§2.10-9：被引原文摘录匹配（仅版本一致时由调用方使用）。
 *
 * - `chunk_id` 命中优先；命中兜底 chunk 时返回 `chunk:null, fallback:true`；
 * - `chunk_id` 缺失/不存在 → 该 `page_idx` 首个非兜底 chunk；
 * - `page_idx` 命中兜底 chunk（无法与真实第 1 页区分）→ `chunk:null,
 *   fallback:true`，由 aside 显示 claim +「位置未知（#1031）」；
 * - 都不命中 → `chunk:null, fallback:false`（调用方显示 claim 并标注为 claim）。
 */
export function matchCitedExcerpt(input: {
  chunks: readonly ResearchChunk[]
  chunkId: string | null | undefined
  pageIdx: number | null | undefined
}): CitedExcerptMatch {
  const { chunks, chunkId, pageIdx } = input
  const direct =
    typeof chunkId === 'string' && chunkId.length > 0
      ? chunks.find((chunk) => chunk.chunk_id === chunkId) ?? null
      : null
  if (direct !== null) {
    return isFallbackPositionChunk(direct)
      ? { chunk: null, fallback: true }
      : { chunk: direct, fallback: false }
  }
  if (typeof pageIdx !== 'number' || !Number.isInteger(pageIdx) || pageIdx < 0) {
    return { chunk: null, fallback: false }
  }
  const samePage = chunks.filter((chunk) => chunk.page_idx === pageIdx)
  if (samePage.length === 0) return { chunk: null, fallback: false }
  const firstReadable = samePage.find((chunk) => !isFallbackPositionChunk(chunk))
  if (firstReadable !== undefined) return { chunk: firstReadable, fallback: false }
  // 该页只有兜底 chunk：不得当作同页原文（#1031）。
  return { chunk: null, fallback: true }
}

/** §2.4 图表块诚实标记（沿用 legacy `FIGURE_CHUNK_MARKER`，不改 wire）。 */
export const FIGURE_CHUNK_MARKER = '<!-- image_description -->'

/** chunk 是否包含图表标记（reader 只显示「图表不可读/需人工核对」提示）。 */
export function chunkHasFigureMarker(markdown: string): boolean {
  return markdown.includes(FIGURE_CHUNK_MARKER)
}

/** 声明格式 → 下载文件名扩展名（`null` = 未知格式，不加扩展名）。 */
function downloadExtension(sourceType: string | null | undefined): string | null {
  const format: SourceMediaFormat | null = normalizeSourceType(sourceType)
  switch (format) {
    case 'pdf':
      return 'pdf'
    case 'ppt':
      return 'pptx'
    case 'xlsx':
      return 'xlsx'
    case 'docx':
      return 'docx'
    case 'csv':
      return 'csv'
    default:
      return null
  }
}

/**
 * §2.4/#1080：下载文件名的前端回退（跨域下读不到 Content-Disposition）。
 *
 * 基名优先 `title`，缺失/空白回退 `document_id`；已带同名扩展名时不重复追加。
 */
export function readerDownloadFileName(
  title: string | null | undefined,
  documentId: string,
  sourceType: string | null | undefined,
): string {
  const rawBase = typeof title === 'string' && title.trim().length > 0 ? title.trim() : documentId
  // 文件名里的路径分隔符会改变浏览器落盘目录语义：保守替换。
  const base = rawBase.replace(/[\\/]+/g, '_')
  const extension = downloadExtension(sourceType)
  if (extension === null) return base
  if (base.toLowerCase().endsWith(`.${extension}`)) return base
  return `${base}.${extension}`
}
