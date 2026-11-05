/**
 * 来源声明格式纯函数（Issue #1011 D1-E 主单，计划 §2.6 格式表）。
 *
 * 唯一职责：把 host 来源详情加性字段 `source_type` 映射为**展示与能力**
 * 描述——定位标签（Page/Slide/Sheet）、页图能力（仅 pdf/ppt）、打开原文件
 * MIME/扩展名、以及媒体错误 → UI 行为分类（计划 §2.10）。
 *
 * 边界（计划 §2.2/§2.6、NORMATIVE 11）：
 * - `page_idx` 仍是唯一 0-based 持久化位置，1-based 只在展示层 `displayPage`
 *   换算；本模块不引入 page_number/slide/cell 字段；
 * - XLSX 只声明 **sheet 级**（序号 = 按 sheet 名排序的序号，不是工作簿顺序），
 *   应用内单元格级预览不在本单（NOT RUN → D4-B）；
 * - CSV/DOCX/其他为**声明外格式**：不新增格式标签、不声明页/slide/单元格
 *   定位，只提供通用「打开原文件（下载）」；
 * - 未知/缺失（旧 host 无加性字段）一律回退：不显示格式 UI、chunk 标签保持
 *   旧 `research.sources.chunkPage`、不提供页图（fail-closed，NORMATIVE 17）。
 *
 * 纯函数、无 React/网络/全局状态依赖，供 SourceDetailPanel/CitationCard 与
 * 单测共享。
 */

/** 声明格式（§2.6）。`other` = 未知技术格式（有值但不在声明表内）。 */
export type SourceMediaFormat = 'pdf' | 'ppt' | 'xlsx' | 'docx' | 'csv' | 'other'

/** 定位标签类型：Page（pdf）/ Slide（ppt）/ Sheet（xlsx）。 */
export type SourceLocatorKind = 'page' | 'slide' | 'sheet'

/** chunk/页图定位文案 key（未知格式回退到旧 key）。 */
export const LEGACY_CHUNK_LOCATOR_KEY = 'research.sources.chunkPage'

export interface SourceMediaProfile {
  /** 归一后的声明格式；`null` = 缺失（旧 host 无字段） */
  format: SourceMediaFormat | null
  /** 头部格式 badge 文案 key；`null` = 不显示格式 badge（声明外/未知） */
  formatLabelKey: string | null
  /** 定位语义；`null` = 保持旧行为（不新增 Page/Slide/Sheet 声明） */
  locatorKind: SourceLocatorKind | null
  /** chunk 定位文案 key（pdf → chunkPage，ppt → chunkSlide，xlsx → chunkSheet） */
  chunkLocatorKey: string
  /** 页图能力：仅 pdf/ppt（xlsx/csv/docx/其他无渲染器，设计如此） */
  pageImage: boolean
  /** 页图入口文案 key（pageImage 为 true 时非 null） */
  pageImageLabelKey: string | null
  /** XLSX：需要可见声明「序号按 sheet 名排序，不等于工作簿顺序」 */
  sheetOrderNote: boolean
  /** 打开原文件 MIME（§2.6 MIME 白名单；未知一律 octet-stream） */
  mimeType: string
  /** 下载文件名回退扩展名（真实文件名由服务端 Content-Disposition 给出） */
  fileExtension: string | null
}

const MIME_BY_FORMAT: Record<SourceMediaFormat, string> = {
  pdf: 'application/pdf',
  ppt: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
  other: 'application/octet-stream',
}

const EXTENSION_BY_FORMAT: Record<SourceMediaFormat, string | null> = {
  pdf: 'pdf',
  ppt: 'pptx',
  xlsx: 'xlsx',
  docx: 'docx',
  csv: 'csv',
  other: null,
}

const FORMAT_LABEL_KEY: Record<SourceMediaFormat, string | null> = {
  pdf: 'research.source.formatPdf',
  ppt: 'research.source.formatPpt',
  xlsx: 'research.source.formatXlsx',
  // §2.6：csv/docx/其他「不新增格式标签」，只提供通用打开原文件
  docx: null,
  csv: null,
  other: null,
}

const LOCATOR_KIND_BY_FORMAT: Record<SourceMediaFormat, SourceLocatorKind | null> = {
  pdf: 'page',
  ppt: 'slide',
  xlsx: 'sheet',
  docx: null,
  csv: null,
  other: null,
}

const CHUNK_LOCATOR_KEY: Record<SourceMediaFormat, string> = {
  pdf: 'research.sources.chunkPage',
  ppt: 'research.sources.chunkSlide',
  xlsx: 'research.sources.chunkSheet',
  docx: LEGACY_CHUNK_LOCATOR_KEY,
  csv: LEGACY_CHUNK_LOCATOR_KEY,
  other: LEGACY_CHUNK_LOCATOR_KEY,
}

const PAGE_IMAGE_LABEL_KEY: Record<SourceMediaFormat, string | null> = {
  pdf: 'research.source.pageImage',
  ppt: 'research.source.slideImage',
  xlsx: null,
  docx: null,
  csv: null,
  other: null,
}

/** 规范技术格式：大小写/空白容错；未知非空值 → `other`；缺失/空串 → `null`。 */
export function normalizeSourceType(
  sourceType: string | null | undefined,
): SourceMediaFormat | null {
  if (typeof sourceType !== 'string') return null
  const normalized = sourceType.trim().toLowerCase()
  if (normalized.length === 0) return null
  if (
    normalized === 'pdf'
    || normalized === 'ppt'
    || normalized === 'xlsx'
    || normalized === 'docx'
    || normalized === 'csv'
    || normalized === 'other'
  ) {
    return normalized
  }
  return 'other'
}

const UNKNOWN_PROFILE: SourceMediaProfile = Object.freeze({
  format: null,
  formatLabelKey: null,
  locatorKind: null,
  chunkLocatorKey: LEGACY_CHUNK_LOCATOR_KEY,
  pageImage: false,
  pageImageLabelKey: null,
  sheetOrderNote: false,
  mimeType: 'application/octet-stream',
  fileExtension: null,
})

/** `source_type` → 展示/能力描述（未知/缺失回退到旧 UI 基线）。 */
export function sourceMediaProfile(
  sourceType: string | null | undefined,
): SourceMediaProfile {
  const format = normalizeSourceType(sourceType)
  if (format === null) return UNKNOWN_PROFILE
  return {
    format,
    formatLabelKey: FORMAT_LABEL_KEY[format],
    locatorKind: LOCATOR_KIND_BY_FORMAT[format],
    chunkLocatorKey: CHUNK_LOCATOR_KEY[format],
    pageImage: format === 'pdf' || format === 'ppt',
    pageImageLabelKey: PAGE_IMAGE_LABEL_KEY[format],
    sheetOrderNote: format === 'xlsx',
    mimeType: MIME_BY_FORMAT[format],
    fileExtension: EXTENSION_BY_FORMAT[format],
  }
}

/** 页图只支持 pdf/ppt（§2.6；xlsx/csv/docx/其他 = 404 纯 detail 设计如此）。 */
export function pageImageCapable(sourceType: string | null | undefined): boolean {
  return sourceMediaProfile(sourceType).pageImage
}

/** 头部格式 badge 文案 key（仅 pdf/ppt/xlsx；声明外/未知 → null）。 */
export function sourceFormatLabelKey(
  sourceType: string | null | undefined,
): string | null {
  return sourceMediaProfile(sourceType).formatLabelKey
}

/** chunk 定位文案 key（未知格式回退旧 `research.sources.chunkPage`）。 */
export function sourceChunkLocatorKey(
  sourceType: string | null | undefined,
): string {
  return sourceMediaProfile(sourceType).chunkLocatorKey
}

/** 打开原文件 MIME（§2.6；未知 → application/octet-stream）。 */
export function sourceFileMimeType(
  sourceType: string | null | undefined,
): string {
  return sourceMediaProfile(sourceType).mimeType
}

/** 下载文件名回退扩展名（未知 → null，由 Content-Disposition 提供文件名）。 */
export function sourceFileExtension(
  sourceType: string | null | undefined,
): string | null {
  return sourceMediaProfile(sourceType).fileExtension
}

// ---------------------------------------------------------------------------
// 媒体错误 → UI 行为分类（计划 §2.10 唯一来源；NORMATIVE 18/30/32）
// ---------------------------------------------------------------------------

/**
 * 媒体失败分类：
 * - `forbidden`：410 **envelope** `source_access_restricted`（撤权；不重试）；
 * - `unsupported`：404 纯 detail「Preview not supported ...」→ 打开原文件；
 * - `source_unavailable`：404 纯 detail「Source not found」（解析后 authority
 *   行竞态缺失）或 422 `source_ref_mismatch` → 无 UI 重试，由用户重新打开
 *   来源触发新请求；
 * - `unavailable`：非 envelope 404（页图位置/原文件不可用）→ 可手动重试一次；
 * - `retryable`：500/503/网络错误（无自动循环，只允许用户点击重试）。
 *
 * 只有 envelope 码判定撤权——非 envelope 410/404 不得显示为「已撤权」
 * （计划 §2.12 失败判据）。
 */
export type SourceMediaFailureKind =
  | 'forbidden'
  | 'unsupported'
  | 'source_unavailable'
  | 'unavailable'
  | 'retryable'

export interface SourceMediaFailureInput {
  /** HTTP status；网络错误/无响应为 null */
  status: number | null
  /** error envelope 的 `detail.code`；纯 detail 响应为 null */
  code: string | null
  /** 纯 detail 文案；envelope/网络错误为 null */
  detail: string | null
}

const CODE_SOURCE_ACCESS_RESTRICTED = 'source_access_restricted'
const CODE_SOURCE_REF_MISMATCH = 'source_ref_mismatch'

/** 媒体错误 → §2.10 UI 行为分类（纯函数，便于单测与复用）。 */
export function classifySourceMediaFailure(
  failure: SourceMediaFailureInput,
): SourceMediaFailureKind {
  const { status, code, detail } = failure

  // 撤权：**唯一**判据是 410 + envelope code（NORMATIVE 30）
  if (status === 410 && code === CODE_SOURCE_ACCESS_RESTRICTED) return 'forbidden'

  if (status === 422 && code === CODE_SOURCE_REF_MISMATCH) return 'source_unavailable'

  if (status === 404) {
    const text = detail ?? ''
    if (/not supported/i.test(text)) return 'unsupported'
    // 解析后 authority 行竞态缺失 → 404 纯 detail "Source not found"（§2.3）
    if (/^source not found$/i.test(text.trim())) return 'source_unavailable'
    return 'unavailable'
  }

  // 500 / 503 envelope / 网络错误 / 其他非撤权失败 → 用户点击重试
  return 'retryable'
}
