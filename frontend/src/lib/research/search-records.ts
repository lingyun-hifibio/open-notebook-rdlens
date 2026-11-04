/**
 * 搜索记录回访 wire 的**容错解析与展示纯函数**（Issue #1014 / D1-F 主单）。
 *
 * 计划 §2.4/§2.6/§2.8 要求 fork 侧按 `schema_version` 与可选键分支，并容错
 * 未知枚举、缺失加性键、`null` 片段/claim：
 *
 * - 列表保持 `d1f-search-record-list-v1`；
 * - 详情 completed = `d1f-search-record-v2`（v1 键 + `result_available`/
 *   `hits`/`citations`）；no_hit = v1 + 可选 `model`；no_generation/failed =
 *   v1 原样；
 * - `model` 是 v1/v2 共用加性可选键：有记录才出现，成员可 null；
 * - 未知 `outcome`/`warning` 不崩溃、不猜测；缺失键按空/「未记录」降级；
 * - `record_visibility` 非 `visible` 一律按受限处理（fail-closed）。
 *
 * 本模块只做形状归一化与文案 key 映射，不做 I/O；API 层（`./api.ts`）调用
 * 解析器，组件只消费归一化后的类型（`./types.ts`）。**绝不伪造**片段、
 * claim、来源名或模型字段。
 */

import { RESEARCH_GENERIC_ERROR_KEY, extractResearchErrorCode } from './errors'
import type {
  ResearchSearchRecordCitation,
  ResearchSearchRecordCitations,
  ResearchSearchRecordCoverage,
  ResearchSearchRecordDegradation,
  ResearchSearchRecordDetail,
  ResearchSearchRecordErrorKind,
  ResearchSearchRecordFailure,
  ResearchSearchRecordHit,
  ResearchSearchRecordHits,
  ResearchSearchRecordListItem,
  ResearchSearchRecordModel,
  ResearchSearchRecordPage,
  ResearchSearchRecordScope,
  ResearchSearchRecordScopeRef,
  ResearchSearchRecordScopeSource,
  ResearchSearchRecordSourceCounts,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > 0 ? value : null
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNullableInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : null
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 能力位读取（计划 §2.7/§2.12 #14）：**仅严格 `=== true`** 视为启用；
 * 缺失、`false`、字符串、数字等一律 false（fail-closed，B M-01）。
 */
export function readSearchHistoryCapability(capabilities: unknown): boolean {
  if (!isRecord(capabilities)) return false
  return capabilities.search_history === true
}

function parseScopeRef(raw: unknown): ResearchSearchRecordScopeRef | null {
  if (!isRecord(raw)) return null
  const documentId = asString(raw.document_id)
  if (documentId.length === 0) return null
  return {
    document_id: documentId,
    document_version: asString(raw.document_version),
  }
}

function parseScope(raw: unknown): ResearchSearchRecordScope | null {
  if (!isRecord(raw)) return null
  const refs = Array.isArray(raw.resolved_source_refs)
    ? raw.resolved_source_refs
      .map(parseScopeRef)
      .filter((ref): ref is ResearchSearchRecordScopeRef => ref !== null)
    : []
  return {
    schema_version: asString(raw.schema_version),
    contract_version: asNullableString(raw.contract_version),
    resolution: asString(raw.resolution),
    mode: asNullableString(raw.mode),
    requested_source_ids: asStringArray(raw.requested_source_ids),
    note_ids: asStringArray(raw.note_ids),
    resolved_source_refs: refs,
    missing_source_ids: asStringArray(raw.missing_source_ids),
    includes_exact_versions: asBoolean(raw.includes_exact_versions),
    contains_document_body: asBoolean(raw.contains_document_body),
    single_source_id: asNullableString(raw.single_source_id),
    warnings: asStringArray(raw.warnings),
    source_total: asFiniteNumber(raw.source_total, refs.length),
  }
}

function parseScopeSource(raw: unknown): ResearchSearchRecordScopeSource | null {
  if (!isRecord(raw)) return null
  const documentId = asString(raw.document_id)
  if (documentId.length === 0) return null
  return {
    document_id: documentId,
    document_version: asString(raw.document_version),
    source_id: asNullableString(raw.source_id),
    status: asNullableString(raw.status),
    warning: asNullableString(raw.warning),
  }
}

function parseHit(raw: unknown): ResearchSearchRecordHit | null {
  if (!isRecord(raw)) return null
  const documentId = asString(raw.document_id)
  const chunkId = asString(raw.chunk_id)
  if (documentId.length === 0 && chunkId.length === 0) return null
  return {
    document_id: documentId,
    document_version: asString(raw.document_version),
    chunk_id: chunkId,
    page_idx: asNullableInt(raw.page_idx),
    source_id: asNullableString(raw.source_id),
    // null = 片段不可用；不把空串/占位当片段（计划 §2.8「不伪造」）。
    snippet: asNullableString(raw.snippet),
    warning: asNullableString(raw.warning),
  }
}

function parseCitation(raw: unknown): ResearchSearchRecordCitation | null {
  if (!isRecord(raw)) return null
  const documentId = asString(raw.document_id)
  const chunkId = asString(raw.chunk_id)
  if (documentId.length === 0 && chunkId.length === 0) return null
  return {
    citation_id: asNullableInt(raw.citation_id),
    chunk_id: chunkId,
    document_id: documentId,
    document_version: asString(raw.document_version),
    page_idx: asNullableInt(raw.page_idx),
    source_id: asNullableString(raw.source_id),
    claim: asNullableString(raw.claim),
    snippet: asNullableString(raw.snippet),
    warning: asNullableString(raw.warning),
  }
}

/** 解析 v2 `hits`；wire 未携带该键 → `null`（v1 行不渲染 v2 分区）。 */
export function parseSearchRecordHits(raw: unknown): ResearchSearchRecordHits | null {
  if (!isRecord(raw)) return null
  const items = Array.isArray(raw.items)
    ? raw.items
      .map(parseHit)
      .filter((hit): hit is ResearchSearchRecordHit => hit !== null)
    : []
  return {
    total: asFiniteNumber(raw.total),
    truncated: asBoolean(raw.truncated),
    items,
  }
}

/** 解析 v2 `citations`；wire 未携带该键 → `null`。 */
export function parseSearchRecordCitations(raw: unknown): ResearchSearchRecordCitations | null {
  if (!isRecord(raw)) return null
  const items = Array.isArray(raw.items)
    ? raw.items
      .map(parseCitation)
      .filter((citation): citation is ResearchSearchRecordCitation => citation !== null)
    : []
  return {
    total: asFiniteNumber(raw.total),
    truncated: asBoolean(raw.truncated),
    items,
  }
}

function parseModel(raw: unknown): ResearchSearchRecordModel | null {
  if (!isRecord(raw)) return null
  return {
    model_id: asNullableString(raw.model_id),
    provider_id: asNullableString(raw.provider_id),
  }
}

function parseDegradation(raw: unknown): ResearchSearchRecordDegradation | null {
  if (!isRecord(raw)) return null
  const code = asString(raw.code)
  if (code.length === 0) return null
  return {
    code,
    scope: asNullableString(raw.scope),
    severity: asNullableString(raw.severity),
    affects_answer: asNullableBoolean(raw.affects_answer),
    retryable: asNullableBoolean(raw.retryable),
    origin: asNullableString(raw.origin),
  }
}

function parseFailure(raw: unknown): ResearchSearchRecordFailure | null {
  if (!isRecord(raw)) return null
  const code = asString(raw.code)
  if (code.length === 0) return null
  return { code, detail_safe: asNullableString(raw.detail_safe) }
}

function parseCoverage(raw: unknown): ResearchSearchRecordCoverage | null {
  if (!isRecord(raw)) return null
  const out: ResearchSearchRecordCoverage = {}
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function parseSourceCounts(raw: unknown, sources: ResearchSearchRecordScopeSource[]): ResearchSearchRecordSourceCounts {
  if (!isRecord(raw)) {
    const total = sources.length
    return { total, visible: total, restricted: 0 }
  }
  return {
    total: asFiniteNumber(raw.total),
    visible: asFiniteNumber(raw.visible),
    restricted: asFiniteNumber(raw.restricted),
  }
}

function parseListItem(raw: unknown): ResearchSearchRecordListItem | null {
  if (!isRecord(raw)) return null
  const recordId = asString(raw.record_id)
  const generationId = asString(raw.generation_id)
  if (recordId.length === 0 && generationId.length === 0) return null
  return {
    schema_version: asString(raw.schema_version),
    record_id: recordId || generationId,
    generation_id: generationId || recordId,
    created_at: asNullableString(raw.created_at),
    completed_at: asNullableString(raw.completed_at),
    query: asString(raw.query),
    outcome: asNullableString(raw.outcome),
    outcome_detail: asNullableString(raw.outcome_detail),
    generation_state: asNullableString(raw.generation_state),
    requested_mode: asNullableString(raw.requested_mode),
    resolved_mode: asNullableString(raw.resolved_mode),
    context_level: asNullableString(raw.context_level),
    hit_count: asFiniteNumber(raw.hit_count),
    scope_mode: asNullableString(raw.scope_mode),
    source_total: asFiniteNumber(raw.source_total),
    failure_code: asNullableString(raw.failure_code),
    degradation_codes: asStringArray(raw.degradation_codes),
  }
}

/**
 * 解析列表响应。非对象/畸形 items 归一为空列表（如实降级，不伪造记录）；
 * `next_cursor` 非字符串/空串 → null（终止分页）。
 */
export function parseSearchRecordListPage(raw: unknown): ResearchSearchRecordPage {
  if (!isRecord(raw)) {
    return { schema_version: '', items: [], next_cursor: null }
  }
  const items = Array.isArray(raw.items)
    ? raw.items
      .map(parseListItem)
      .filter((item): item is ResearchSearchRecordListItem => item !== null)
    : []
  return {
    schema_version: asString(raw.schema_version),
    items,
    next_cursor: asNullableString(raw.next_cursor),
  }
}

/**
 * 解析详情响应。
 *
 * - 非对象 → 抛错（API 层将其作为查询错误，UI 走通用错误态；不构造空记录冒充
 *   「无数据」）；
 * - `schema_version`/`outcome` 未知值原样保留；
 * - v2 三键缺失 → `result_available/hits/citations = null`（v1 行不渲染 v2）；
 * - `record_visibility` 非 `visible` → `restricted`（fail-closed）。
 */
export function parseSearchRecordDetail(raw: unknown): ResearchSearchRecordDetail {
  if (!isRecord(raw)) {
    throw new Error('invalid_search_record_detail')
  }
  const sources = Array.isArray(raw.sources)
    ? raw.sources
      .map(parseScopeSource)
      .filter((source): source is ResearchSearchRecordScopeSource => source !== null)
    : []
  const conclusionRaw = isRecord(raw.conclusion) ? raw.conclusion : null
  const conclusion = {
    text: conclusionRaw === null ? null : asNullableString(conclusionRaw.text),
    truncated: conclusionRaw === null ? false : asBoolean(conclusionRaw.truncated),
  }
  return {
    schema_version: asString(raw.schema_version),
    record_id: asString(raw.record_id),
    generation_id: asString(raw.generation_id),
    created_at: asNullableString(raw.created_at),
    completed_at: asNullableString(raw.completed_at),
    query: asString(raw.query),
    outcome: asNullableString(raw.outcome),
    outcome_detail: asNullableString(raw.outcome_detail),
    generation_state: asNullableString(raw.generation_state),
    requested_mode: asNullableString(raw.requested_mode),
    resolved_mode: asNullableString(raw.resolved_mode),
    context_level: asNullableString(raw.context_level),
    hit_count: asFiniteNumber(raw.hit_count),
    scope: parseScope(raw.scope),
    source_counts: parseSourceCounts(raw.source_counts, sources),
    sources,
    conclusion,
    degradations: Array.isArray(raw.degradations)
      ? raw.degradations
        .map(parseDegradation)
        .filter((item): item is ResearchSearchRecordDegradation => item !== null)
      : [],
    degradation_schema_version: asNullableString(raw.degradation_schema_version),
    failure: parseFailure(raw.failure),
    coverage: parseCoverage(raw.coverage),
    record_visibility: raw.record_visibility === 'visible' ? 'visible' : 'restricted',
    warnings: asStringArray(raw.warnings),
    result_available: asNullableBoolean(raw.result_available),
    hits: parseSearchRecordHits(raw.hits),
    citations: parseSearchRecordCitations(raw.citations),
    model: parseModel(raw.model),
  }
}

/**
 * 搜索历史读取错误分类（计划 §2.8/§2.11）。
 *
 * - 403 → 仅 Owner 可查看；404 → 记录不存在/无权查看；
 * - 503 `search_record_not_enabled` → 未启用（**不重试**，不重试风暴）；
 * - 503 其它/`search_record_store_unavailable` → 存储暂不可用（可重试）；
 * - 其余 → 通用错误。
 */
export function classifySearchRecordError(err: unknown): ResearchSearchRecordErrorKind {
  const response = isRecord(err) ? err.response : null
  const status = isRecord(response) ? response.status : undefined
  const code = extractResearchErrorCode(err)
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 503) {
    return code === 'search_record_not_enabled' ? 'not_enabled' : 'store_unavailable'
  }
  if (code === 'search_record_not_enabled') return 'not_enabled'
  if (code === 'search_record_store_unavailable') return 'store_unavailable'
  return 'unknown'
}

/** 错误分类 → 用户文案 key（未知错误复用既有 generic 兜底）。 */
export function searchRecordErrorCopyKey(kind: ResearchSearchRecordErrorKind): string {
  switch (kind) {
    case 'not_enabled':
      return 'research.searchHistory.errors.notEnabled'
    case 'forbidden':
      return 'research.searchHistory.errors.forbidden'
    case 'not_found':
      return 'research.searchHistory.errors.notFound'
    case 'store_unavailable':
      return 'research.searchHistory.errors.storeUnavailable'
    default:
      return RESEARCH_GENERIC_ERROR_KEY
  }
}

/** 错误分类是否可重试（未启用/无权/不存在重试无意义）。 */
export function isSearchRecordErrorRetryable(kind: ResearchSearchRecordErrorKind): boolean {
  return kind === 'store_unavailable' || kind === 'unknown'
}

/** outcome → 标签文案 key（未知值 → 「其他终态」）。 */
export function searchRecordOutcomeLabelKey(outcome: string | null): string {
  switch (outcome) {
    case 'completed':
      return 'research.searchHistory.outcome.completed'
    case 'no_hit':
      return 'research.searchHistory.outcome.noHit'
    case 'no_generation':
      return 'research.searchHistory.outcome.noGeneration'
    case 'failed':
      return 'research.searchHistory.outcome.failed'
    default:
      return 'research.searchHistory.outcome.unknown'
  }
}

/** outcome_detail → 文案 key；未知/null → null（原码次级展示）。 */
export function searchRecordOutcomeDetailKey(detail: string | null): string | null {
  switch (detail) {
    case 'system_route':
      return 'research.searchHistory.outcomeDetail.systemRoute'
    case 'source_evidence_empty':
      return 'research.searchHistory.outcomeDetail.sourceEvidenceEmpty'
    default:
      return null
  }
}

/** scope mode → 标签文案 key（未知/null → 「范围」）。 */
export function searchRecordScopeModeLabelKey(mode: string | null): string {
  switch (mode) {
    case 'all':
      return 'research.searchHistory.scopeMode.all'
    case 'selected':
      return 'research.searchHistory.scopeMode.selected'
    case 'single':
      return 'research.searchHistory.scopeMode.single'
    default:
      return 'research.searchHistory.scopeMode.unknown'
  }
}

/**
 * 命中项引用状态（计划 §2.12 #16），三态：
 * - `cited`：`(document_version, chunk_id)` 复合键出现在 citations 集合中
 *   （`page_idx` 同值优先用于同一复合键多候选时的匹配顺序；复合键成员已足以
 *   判定已引用，不因页不同而误判未引用）；
 * - `not_cited`：citations 集合**完整**（`truncated=false`）且未命中；
 * - `unknown`：citations 身份快照被截断（host 按引擎顺序去重后最多存 200 项、
 *   `citation_count` 保留精确数）——未命中集合可能落在截断窗口之外，
 *   **不得断言「未引用」**（避免假否定），UI 显示「引用状态未确认」。
 */
export type HitCitationStatus = 'cited' | 'not_cited' | 'unknown'

export function hitCitationStatus(
  hit: ResearchSearchRecordHit,
  citations: readonly ResearchSearchRecordCitation[],
  citationsTruncated: boolean,
): HitCitationStatus {
  const sameChunk = citations.filter(
    (citation) =>
      citation.document_version === hit.document_version
      && citation.chunk_id === hit.chunk_id,
  )
  // page_idx 同值优先：先取同页候选（匹配顺序口径，结论与复合键成员一致）。
  if (
    hit.page_idx !== null
    && sameChunk.some((citation) => citation.page_idx === hit.page_idx)
  ) {
    return 'cited'
  }
  if (sameChunk.length > 0) return 'cited'
  return citationsTruncated ? 'unknown' : 'not_cited'
}

/** 兼容辅助：是否「已引用」（`unknown` 不算已引用）。 */
export function isHitCited(
  hit: ResearchSearchRecordHit,
  citations: readonly ResearchSearchRecordCitation[],
): boolean {
  return hitCitationStatus(hit, citations, false) === 'cited'
}

/**
 * 是否有 v2 结果投影可渲染（completed v2 或容错携带了 hits/citations 键）。
 *
 * 口径（L-3）：按**可选键是否存在**渲染 v2 分区，而不是硬分支
 * `schema_version`。这是有意的消费者容错：wire 升版/加性键先于消费者发布时
 * 不丢数据；未知/未来 schema 只要携带结果键就按同一投影渲染。当前 host
 * 契约保证仅 completed 携带三键（v1 行不渲染 v2 分区，见 §2.8）。
 */
export function hasSearchRecordResultProjection(
  detail: ResearchSearchRecordDetail,
): boolean {
  return detail.hits !== null || detail.citations !== null || detail.result_available !== null
}

/** 详情是否受限（非 `visible` 一律按受限处理）。 */
export function isSearchRecordRestricted(detail: ResearchSearchRecordDetail): boolean {
  return detail.record_visibility === 'restricted'
}
