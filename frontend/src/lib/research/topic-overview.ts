/**
 * Issue #1016（D1-G 主单）主题概览 wire 的**容错解析、能力位、请求构造**与
 * 展示纯函数。
 *
 * 计划 §2.2/§2.6/§2.9（wire 冻结见 `dev_docs/plans/issue1016_d1g_topic_overview_plan_20261105.md`
 * §2.6 与 `shared/WIRE_CONTRACT.md` §3/§4）：
 *
 * - POST 200 与 GET 200 同一形状：`{schema_version, request_id, overview}`；
 * - `overview` 的 `overview_id`/`generation_id` 是核心身份键：缺失即视为无效
 *   响应（`null`），组件不渲染、API 层抛错（不伪装「未生成」空态）；
 * - `visibility` 非 `ready` 一律按 `restricted` 处理（fail-closed）：即使上游
 *   投影异常携带正文/引用/来源身份，也一律丢弃，只保留执行元数据与聚合计数；
 * - 未知加性键、未知 warning/limitation/degradation 值、缺失可选键一律容错：
 *   不崩溃、不猜测、不伪造；未知 schema_version 不拒绝（加性演进容错）；
 * - 请求体专用 builder：含 `focus`、**不含 `query`**（`TopicOverviewRequest`
 *   不声明 query，复用 `buildC05GeneratedRequest` 会让 focus 静默丢失），
 *   `source_scope` 复用既有 `buildSourceScope`（C-05 唯一构造），`note_ids`
 *   恒 `[]`（概览路径 Note 一律拒绝），空 selected fail-closed。
 *
 * 本模块只做形状归一化与纯函数展示映射，不做 I/O；API 层（`./api.ts`）调用
 * 解析器，组件只消费归一化后的类型。**绝不伪造**正文、引用、来源身份或
 * 模型字段。
 */

import { buildSourceScope } from './c05-request'
import type { C05RequestScope, C05ScopeBody } from './c05-request'

export const TOPIC_OVERVIEW_SCHEMA_VERSION = 'd1g-topic-overview-v1' as const

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

/** 概览引用（canonical 快照；`source_id` 缺失/版本不符由 host 置 null）。 */
export interface TopicOverviewCitation {
  /** 引擎 citation 编号（缺失 → null；仅用于展示/键，不参与身份判定）。 */
  citation_id: number | null
  /** claim（缺失 → null：不渲染空占位，不伪造主张文本）。 */
  claim: string | null
  doc_id: string
  doc_version: string
  /** 0-based 页码；缺失 → null（不伪造页码）。 */
  page_idx: number | null
  chunk_id: string
  /** mirror 解析到的来源身份；`null` = 不可用（不补造）。 */
  source_id: string | null
  /** `source_unavailable`；未知值原样保留（加性演进容错，不崩溃）。 */
  warning: string | null
}

/** 声明范围里的来源引用（restricted 时 denied 项整条删除，不泄露身份）。 */
export interface TopicOverviewScopeSource {
  document_id: string
  document_version: string
  source_id: string | null
}

/** 声明范围快照（`scope`）。 */
export interface TopicOverviewScope {
  mode: string | null
  contract_version: string | null
  includes_exact_versions: boolean
  captured_at: string | null
  /** 原始声明来源数；**不**等于 `sources.length`（restricted/denied 会剔除）。 */
  source_count: number
  refs_truncated: boolean
  sources: TopicOverviewScopeSource[]
  missing_source_ids: string[]
  single_source_id: string | null
}

/** 实际纳入证据的来源（`processing.included_sources`）。 */
export interface TopicOverviewIncludedSource {
  document_id: string
  document_version: string
  chunk_count: number
  source_id: string | null
}

/** 证据模态计数（`processing.evidence_modalities`）。 */
export interface TopicOverviewEvidenceModalities {
  text: number
  table: number
  figure: number
  mixed: number
}

/**
 * canonical 降级项（C-17）：只保留稳定 `code` + 可展示的 scope/severity；
 * 未知码原样保留（不映射、不崩溃），非对象 code 项丢弃。
 */
export interface TopicOverviewDegradation {
  code: string
  scope: string | null
  severity: string | null
}

/** 执行投影（`processing`）：计数与降级信息，restricted 时保留。 */
export interface TopicOverviewProcessing {
  resolved_mode: string | null
  evidence_chunk_count: number
  citation_count: number
  citations_total: number
  citations_dropped: number
  evidence_modalities: TopicOverviewEvidenceModalities
  /** 聚合覆盖信息（键集合未冻结；标量键保留，非标量丢弃）。 */
  coverage: Record<string, string | number | boolean | null> | null
  included_sources: TopicOverviewIncludedSource[]
  degradations: TopicOverviewDegradation[]
  degradation_reason: string | null
  evidence_degraded: boolean | null
  full_text_read: boolean
}

/** 概览解析出的四段（任一段解析失败/缺失 → 该段 null；全缺 → `sections=null`）。 */
export interface TopicOverviewSections {
  main_questions: string | null
  findings: string | null
  disagreements: string | null
  reading_priorities: string | null
}

/** 生成模型执行元数据（restricted 时保留）。 */
export interface TopicOverviewModel {
  model_id: string | null
  provider_id: string | null
}

/** C-01 目的投影（restricted 时保留）。 */
export interface TopicOverviewPurpose {
  work_purpose: string | null
  work_purpose_source: string
}

/** GET/POST 200 的 `overview` wire。 */
export interface TopicOverviewWire {
  overview_id: string
  generation_id: string
  generated_at: string | null
  generation_created_at: string | null
  focus: string | null
  visibility: 'ready' | 'restricted'
  content_markdown: string | null
  sections: TopicOverviewSections | null
  citations: TopicOverviewCitation[]
  scope: TopicOverviewScope | null
  processing: TopicOverviewProcessing | null
  model: TopicOverviewModel | null
  purpose: TopicOverviewPurpose | null
  limitations: string[]
  warnings: string[]
}

/** GET/POST 200 的完整响应 envelope（`parseTopicOverviewResponse` 入参形状）。 */
export interface TopicOverviewResponse {
  schema_version: string
  request_id: string
  overview: TopicOverviewWire
}

/**
 * 能力位读取（计划 §2.8/§2.9）：**仅严格 `=== true`** 视为启用；缺失、
 * `false`、字符串、数字等一律 false（fail-closed，入口不渲染、既有 UI 零变化）。
 */
export function readTopicOverviewCapability(capabilities: unknown): boolean {
  if (!isRecord(capabilities)) return false
  return capabilities.topic_overview === true
}

function parseCitation(raw: unknown): TopicOverviewCitation | null {
  if (!isRecord(raw)) return null
  const docId = asString(raw.doc_id)
  const chunkId = asString(raw.chunk_id)
  const claim = asNullableString(raw.claim)
  // 完全无身份且无主张的项视为畸形（不渲染空引用）。
  if (docId.length === 0 && chunkId.length === 0 && claim === null) return null
  return {
    citation_id: asNullableInt(raw.citation_id),
    claim,
    doc_id: docId,
    doc_version: asString(raw.doc_version),
    page_idx: asNullableInt(raw.page_idx),
    chunk_id: chunkId,
    source_id: asNullableString(raw.source_id),
    warning: asNullableString(raw.warning),
  }
}

function parseScopeSource(raw: unknown): TopicOverviewScopeSource | null {
  if (!isRecord(raw)) return null
  const documentId = asString(raw.document_id)
  if (documentId.length === 0) return null
  return {
    document_id: documentId,
    document_version: asString(raw.document_version),
    source_id: asNullableString(raw.source_id),
  }
}

function parseScope(raw: unknown): TopicOverviewScope | null {
  if (!isRecord(raw)) return null
  const sources = Array.isArray(raw.sources)
    ? raw.sources
      .map(parseScopeSource)
      .filter((source): source is TopicOverviewScopeSource => source !== null)
    : []
  return {
    mode: asNullableString(raw.mode),
    contract_version: asNullableString(raw.contract_version),
    includes_exact_versions: asBoolean(raw.includes_exact_versions),
    captured_at: asNullableString(raw.captured_at),
    // 不能用 sources.length 代替：restricted/denied 时 sources 会清空而
    // 聚合数仍保留原值（计划 §2.6）。
    source_count: asFiniteNumber(raw.source_count),
    refs_truncated: asBoolean(raw.refs_truncated),
    sources,
    missing_source_ids: asStringArray(raw.missing_source_ids),
    single_source_id: asNullableString(raw.single_source_id),
  }
}

function parseIncludedSource(raw: unknown): TopicOverviewIncludedSource | null {
  if (!isRecord(raw)) return null
  const documentId = asString(raw.document_id)
  if (documentId.length === 0) return null
  return {
    document_id: documentId,
    document_version: asString(raw.document_version),
    chunk_count: asFiniteNumber(raw.chunk_count),
    source_id: asNullableString(raw.source_id),
  }
}

function parseEvidenceModalities(
  raw: unknown,
): TopicOverviewEvidenceModalities {
  if (!isRecord(raw)) return { text: 0, table: 0, figure: 0, mixed: 0 }
  return {
    text: asFiniteNumber(raw.text),
    table: asFiniteNumber(raw.table),
    figure: asFiniteNumber(raw.figure),
    mixed: asFiniteNumber(raw.mixed),
  }
}

function parseCoverage(
  raw: unknown,
): Record<string, string | number | boolean | null> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, string | number | boolean | null> = {}
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

function parseDegradation(raw: unknown): TopicOverviewDegradation | null {
  // 兼容 legacy/canonical 两种承载：纯码字符串或 `{code,...}` 对象。
  if (typeof raw === 'string') {
    return raw.length > 0 ? { code: raw, scope: null, severity: null } : null
  }
  if (!isRecord(raw)) return null
  const code = asString(raw.code)
  if (code.length === 0) return null
  return {
    code,
    scope: asNullableString(raw.scope),
    severity: asNullableString(raw.severity),
  }
}

function parseProcessing(raw: unknown): TopicOverviewProcessing | null {
  if (!isRecord(raw)) return null
  return {
    resolved_mode: asNullableString(raw.resolved_mode),
    evidence_chunk_count: asFiniteNumber(raw.evidence_chunk_count),
    citation_count: asFiniteNumber(raw.citation_count),
    citations_total: asFiniteNumber(raw.citations_total),
    citations_dropped: asFiniteNumber(raw.citations_dropped),
    evidence_modalities: parseEvidenceModalities(raw.evidence_modalities),
    coverage: parseCoverage(raw.coverage),
    included_sources: Array.isArray(raw.included_sources)
      ? raw.included_sources
        .map(parseIncludedSource)
        .filter((source): source is TopicOverviewIncludedSource => source !== null)
      : [],
    degradations: Array.isArray(raw.degradations)
      ? raw.degradations
        .map(parseDegradation)
        .filter((item): item is TopicOverviewDegradation => item !== null)
      : [],
    degradation_reason: asNullableString(raw.degradation_reason),
    evidence_degraded: asNullableBoolean(raw.evidence_degraded),
    full_text_read: asBoolean(raw.full_text_read),
  }
}

function parseSections(raw: unknown): TopicOverviewSections | null {
  if (!isRecord(raw)) return null
  const sections: TopicOverviewSections = {
    main_questions: asNullableString(raw.main_questions),
    findings: asNullableString(raw.findings),
    disagreements: asNullableString(raw.disagreements),
    reading_priorities: asNullableString(raw.reading_priorities),
  }
  // host 解析失败时整块 null；四段全缺时同样按「无 sections」处理，
  // 组件回落到整篇 content_markdown。
  if (
    sections.main_questions === null
    && sections.findings === null
    && sections.disagreements === null
    && sections.reading_priorities === null
  ) {
    return null
  }
  return sections
}

function parseModel(raw: unknown): TopicOverviewModel | null {
  if (!isRecord(raw)) return null
  return {
    model_id: asNullableString(raw.model_id),
    provider_id: asNullableString(raw.provider_id),
  }
}

/** C-01 purpose 投影（缺失/畸形 → null：不伪造 purpose）。 */
function parsePurpose(raw: unknown): TopicOverviewPurpose | null {
  if (!isRecord(raw)) return null
  return {
    work_purpose: asNullableString(raw.work_purpose),
    work_purpose_source: asString(raw.work_purpose_source),
  }
}

/** restricted 投影：丢弃正文/分段/引用/来源身份，保留聚合计数与执行元数据。 */
function restrictScope(scope: TopicOverviewScope | null): TopicOverviewScope | null {
  if (scope === null) return null
  return {
    ...scope,
    sources: [],
    missing_source_ids: [],
    single_source_id: null,
  }
}

function restrictProcessing(
  processing: TopicOverviewProcessing | null,
): TopicOverviewProcessing | null {
  if (processing === null) return null
  return { ...processing, included_sources: [] }
}

/**
 * 解析 GET/POST 200 响应 envelope，返回归一化 `overview` wire。
 *
 * - 非对象 / 缺 `overview` / `overview` 非对象 → `null`；
 * - 缺核心身份键（`overview_id`/`generation_id` 任一非非空字符串）→ `null`
 *   （API 层据此抛错，不把畸形成功体伪装成「未生成」空态）；
 * - `visibility !== 'ready'` → restricted 投影（fail-closed）；
 * - 未知加性键/未知枚举值忽略或原样保留，不崩溃。
 */
export function parseTopicOverviewResponse(raw: unknown): TopicOverviewWire | null {
  if (!isRecord(raw)) return null
  const overview = raw.overview
  if (!isRecord(overview)) return null

  const overviewId = asString(overview.overview_id)
  const generationId = asString(overview.generation_id)
  if (overviewId.length === 0 || generationId.length === 0) return null

  const ready = overview.visibility === 'ready'
  const citations = Array.isArray(overview.citations)
    ? overview.citations
      .map(parseCitation)
      .filter((citation): citation is TopicOverviewCitation => citation !== null)
    : []

  return {
    overview_id: overviewId,
    generation_id: generationId,
    generated_at: asNullableString(overview.generated_at),
    generation_created_at: asNullableString(overview.generation_created_at),
    focus: asNullableString(overview.focus),
    visibility: ready ? 'ready' : 'restricted',
    content_markdown: ready ? asNullableString(overview.content_markdown) : null,
    sections: ready ? parseSections(overview.sections) : null,
    citations: ready ? citations : [],
    scope: ready ? parseScope(overview.scope) : restrictScope(parseScope(overview.scope)),
    processing: ready
      ? parseProcessing(overview.processing)
      : restrictProcessing(parseProcessing(overview.processing)),
    model: parseModel(overview.model),
    purpose: parsePurpose(overview.purpose),
    limitations: asStringArray(overview.limitations),
    warnings: asStringArray(overview.warnings),
  }
}

/** 构造概览请求体的冻结选项（`TopicOverviewRequest` 不声明 query）。 */
export interface TopicOverviewCreateOptions {
  /** 关注问题；空串 = 固定默认概览指令（服务器侧）。 */
  focus: string
  /** 本地模型 id；外部模型由 C-05 D-1 以既有 409 拒绝。 */
  modelId: string
  responseLanguage?: 'zh' | 'en'
  /** C-01：概览只接受 `document_qa`（缺失时服务器按 document_qa 缺省）。 */
  workPurpose?: 'document_qa'
}

/**
 * 概览 POST 请求体（`TopicOverviewRequest` + 正交 C-05 载荷）。
 *
 * 纪律：
 * - **不使用** `buildC05GeneratedRequest`：它携带 `query`，而
 *   `TopicOverviewRequest` 不声明 query —— focus 会被静默忽略；
 * - `source_scope` 用既有 `buildSourceScope`（C-05 唯一构造，三形态固定）；
 * - `note_ids` 恒 `[]`（概览路径 Note 一律拒绝，不把 Note 当资料）；
 * - 空 `selected` fail-closed（抛既有 `c05_request_empty_selected`，不扩大为 all）。
 */
export interface TopicOverviewCreateBody {
  focus: string
  model_id: string
  source_scope: C05ScopeBody
  note_ids: string[]
  response_language?: 'zh' | 'en'
  work_purpose?: 'document_qa'
}

export function buildTopicOverviewRequest(
  scope: C05RequestScope,
  options: TopicOverviewCreateOptions,
): TopicOverviewCreateBody {
  if (scope.mode === 'selected' && scope.sourceIds.length === 0) {
    // 空 selected 不扩为 all：Note 不构成资料范围（本路径 note_ids 恒空），
    // 与 `buildC05GeneratedRequest` 的 fail-closed 防御一致。
    throw new Error('c05_request_empty_selected')
  }
  return {
    focus: options.focus,
    model_id: options.modelId,
    ...(options.responseLanguage !== undefined
      ? { response_language: options.responseLanguage }
      : {}),
    ...(options.workPurpose !== undefined
      ? { work_purpose: options.workPurpose }
      : {}),
    source_scope: buildSourceScope(scope),
    // 概览路径拒绝 Note：无论 scope.noteIds 是否为空都不进入请求体。
    note_ids: [],
  }
}

/** 资料身份最小结构（`overview.scope.sources` 与 `ResearchSource[]` 均满足）。 */
export interface TopicOverviewSourceIdentity {
  readonly document_id: string
  readonly document_version: string
}

/** 概览范围 vs 当前资料的差异计数（只提示，不自动更新）。 */
export interface TopicOverviewSourceChanges {
  added: number
  versionChanged: number
  retired: number
}

function sourceVersionsById(
  sources: readonly TopicOverviewSourceIdentity[] | null | undefined,
): Map<string, string> {
  const versions = new Map<string, string>()
  if (!Array.isArray(sources)) return versions
  for (const source of sources) {
    const documentId = asString(source?.document_id)
    if (documentId.length === 0) continue
    // 同一 document_id 出现多次时保留首个版本（去重后计数，不重复提示）。
    if (!versions.has(documentId)) {
      versions.set(documentId, asString(source?.document_version))
    }
  }
  return versions
}

/**
 * 对比概览声明范围（`scope.sources`）与当前资料列表：
 * - `added`：当前有、概览范围没有的来源数；
 * - `versionChanged`：同一 `document_id` 但 `document_version` 不同的来源数；
 * - `retired`：概览范围有、当前已不在的来源数。
 *
 * 只用于「当前资料有变化，可更新概览」提示；不自动更新、不改 GET 内容。
 * 空/缺失输入按 0 处理（`scope` 为 null 时可直接传）。
 */
export function topicOverviewSourceChanges(
  overviewSources: readonly TopicOverviewSourceIdentity[] | null | undefined,
  currentSources: readonly TopicOverviewSourceIdentity[] | null | undefined,
): TopicOverviewSourceChanges {
  const previous = sourceVersionsById(overviewSources)
  const current = sourceVersionsById(currentSources)
  let added = 0
  let versionChanged = 0
  let retired = 0
  for (const [documentId, version] of current) {
    const previousVersion = previous.get(documentId)
    if (previousVersion === undefined) {
      added += 1
      continue
    }
    if (previousVersion !== version) versionChanged += 1
  }
  for (const documentId of previous.keys()) {
    if (!current.has(documentId)) retired += 1
  }
  return { added, versionChanged, retired }
}

/** 「继续讨论」固定引导文本（计划 §2.9：固定文本 + focus/首段问题）。 */
const DISCUSSION_GUIDE = '基于当前主题概览继续讨论：'
const DISCUSSION_GUIDE_ONLY = '基于当前主题概览继续讨论。'

/** 取 Markdown 首段问题：跳过空行与标题行、剥离列表符号，只取第一条。 */
function firstQuestionLine(markdown: string | null): string | null {
  if (markdown === null) return null
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    // 段标题（`## 主要问题`）不是问题本身，跳过。
    if (/^#{1,6}\s+/.test(trimmed)) continue
    const stripped = trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim()
    if (stripped.length > 0) return stripped
  }
  return null
}

/**
 * 「继续讨论」草稿文本：固定引导文本 +（`focus` 非空 ? `focus` : 概览首段问题）。
 * 两者都不可用时只返回引导句（不出现 undefined/null、不依赖组件与 locale）。
 *
 * 说明：冻结签名不接收 locale —— 引导文本按计划 §2.9 固定，概览正文/问题
 * 本身已由 host 按 `response_language` 生成。
 */
export function topicOverviewDiscussionText(overview: TopicOverviewWire): string {
  const focus = (overview.focus ?? '').trim()
  const target = focus.length > 0
    ? focus
    : firstQuestionLine(overview.sections?.main_questions ?? null)
  if (target === null) return DISCUSSION_GUIDE_ONLY
  return `${DISCUSSION_GUIDE}${target}`
}
