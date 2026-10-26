/**
 * 研究会话 wire 契约解析与投影（RDLens #602 第三批 PR-1）。
 *
 * 规范来源：
 * - `dev_docs/设计方案/Research/issue602_batch3/01_DESIGN.md` §3.1、§4.2、§4.6、§9.1
 * - `02_INTERFACE_FREEZE.md` §2–§4、§8
 * - 第一批冻结契约 `Issue602_第一批_契约与测试场景_v1_20261020.json` revision=6
 *
 * 本模块只做**纯函数**校验/规整/投影，不发请求、不读存储、不持有状态。
 * wire 类型全部放在本文件（PR-1 决策 R1：`types.ts` 零修改）。
 *
 * 解析失败一律返回稳定客户端码 `invalid_response`（02 §7），调用方只能
 * 显示“响应无法识别/暂时不可用”，不得猜测缺失字段或回退旧 `/chat`。
 */

/** 新协议请求头（02 §2）。 */
export const SESSION_CONTRACT_HEADER = 'X-Research-Session-Contract' as const

/** 新协议版本常量（02 §2；`capabilities.sessions.contract` 必须等于该值）。 */
export const SESSION_CONTRACT_VERSION = 'research-session-v1' as const

/** 会话身份域（第一批 `session_ref.domain`）。 */
export const SESSION_DOMAIN = 'research' as const

/** 详情消息分页半径（DESIGN §4.6）；投影只覆盖当前页内消息。 */
export const DETAIL_MESSAGE_MAX = 100 as const

/** 列表单页上限（第一批 `list_response.items.maxItems`）。 */
export const SESSION_LIST_MAX_ITEMS = 100 as const

export type ResearchSessionKind = 'global' | 'source'

/** 会话四元身份（+ 项目）；不得以 `sessionId` 单独作缓存/Map 键。 */
export interface ResearchSessionRef {
  readonly domain: typeof SESSION_DOMAIN
  readonly kind: ResearchSessionKind
  readonly projectId: string
  readonly sessionId: string
  readonly sourceId: string | null
}

/**
 * 会话级可见性（DESIGN §4.6 / 02 §4）。
 * `restricted` 只允许固定占位，不得展示派生标题与正文。
 */
export type ResearchSessionVisibility = 'visible' | 'restricted' | 'legacy_context_unverifiable'

export type ResearchAcceptanceState = 'not_observed' | 'accepted' | 'terminal' | 'outcome_unknown'

export type ResearchGenerationState =
  | 'accepted'
  | 'running'
  | 'job_queued'
  | 'completed'
  | 'failed'
  | 'outcome_unknown'

/** 能力协商结果；`degraded=true` 表示字段缺失/契约不符/形状非法（§3.3 只读）。 */
export interface ResearchSessionCapabilities {
  readonly contract: string | null
  readonly editorReady: boolean
  readonly submissionReady: {
    readonly global: boolean
    readonly source: boolean
  }
  readonly degraded: boolean
  readonly reason: 'missing' | 'contract_unsupported' | 'invalid_shape' | null
}

/** 客户端稳定错误码（02 §7 中属于客户端侧的两个）。 */
export const CLIENT_ERROR_CODES = {
  invalidResponse: 'invalid_response',
  positionUnavailable: 'position_unavailable',
} as const

/** 解析失败的稳定形状。 */
export interface ResearchSessionParseError {
  readonly code: typeof CLIENT_ERROR_CODES.invalidResponse
  readonly message: string
  readonly field: string | null
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResearchSessionParseError }

export type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value }
}

function invalid<T = never>(field: string, message: string): ParseResult<T> {
  return { ok: false, error: { code: CLIENT_ERROR_CODES.invalidResponse, message, field } }
}

/**
 * 拒绝 schema `additionalProperties:false` 对象上的未知键。
 * 返回 false 表示通过（便于把错误带 field 统一抛给调用方）。
 */
function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allow = new Set(allowed)
  return Object.keys(value).every((key) => allow.has(key))
}

/** 字符串长度上限校验（第一批 schema 大量使用 1..256）。 */
function isNonEmptyString(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/
const SUBMISSION_KEY_PATTERN = /^s1_[a-f0-9]{64}$/
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value)
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
}

function isViewerUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 9_007_199_254_740_991
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && CURSOR_PATTERN.test(value)
}

function isStringArrayUnique(value: unknown, maxItems: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isNonEmptyString(entry, 256)) return false
    if (seen.has(entry)) return false
    seen.add(entry)
  }
  return true
}

/**
 * 构造 `sessionKey`（DESIGN §3.1 / 02 §4）：
 * `research.v1|<project>|<kind>|<source-or-empty>|<session>`，各段 `encodeURIComponent`，
 * 空 source 保留显式空段（不能省略分隔符）。
 */
export function sessionKey(ref: ResearchSessionRef): string {
  return [
    'research.v1',
    encodeURIComponent(ref.projectId),
    ref.kind,
    ref.sourceId === null ? '' : encodeURIComponent(ref.sourceId),
    encodeURIComponent(ref.sessionId),
  ].join('|')
}

/** 身份相等比较（四元 + domain）。 */
export function sessionRefEquals(
  left: ResearchSessionRef | null | undefined,
  right: ResearchSessionRef | null | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.domain === right.domain &&
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.sourceId === right.sourceId
  )
}

/** 解析 `session_ref`；kind=global 要求 sourceId=null，kind=source 要求非空。 */
export function parseSessionRef(value: unknown, field = 'session_ref'): ParseResult<ResearchSessionRef> {
  if (!isRecord(value)) return invalid(field, 'session_ref must be an object')
  if (!hasOnlyKeys(value, ['domain', 'kind', 'project_id', 'session_id', 'source_id'])) {
    return invalid(field, 'session_ref has unexpected fields')
  }
  if (value.domain !== SESSION_DOMAIN) return invalid(`${field}.domain`, 'domain must be research')
  if (value.kind !== 'global' && value.kind !== 'source') {
    return invalid(`${field}.kind`, 'kind must be global or source')
  }
  const projectId = value.project_id
  if (!isNonEmptyString(projectId, 256)) return invalid(`${field}.project_id`, 'project_id must be 1..256 characters')
  const sessionId = value.session_id
  if (typeof sessionId !== 'string' || !RESOURCE_ID_PATTERN.test(sessionId)) {
    return invalid(`${field}.session_id`, 'session_id must match ^[A-Za-z0-9_-]{1,128}$')
  }
  const rawSource = value.source_id
  if (rawSource !== null && !isNonEmptyString(rawSource, 256)) {
    return invalid(`${field}.source_id`, 'source_id must be null or 1..256 characters')
  }
  if (value.kind === 'global' && rawSource !== null) {
    return invalid(`${field}.source_id`, 'global sessions require source_id=null')
  }
  if (value.kind === 'source' && (rawSource === null || rawSource.length === 0)) {
    return invalid(`${field}.source_id`, 'source sessions require a non-empty source_id')
  }
  return ok({
    domain: SESSION_DOMAIN,
    kind: value.kind,
    projectId,
    sessionId,
    sourceId: value.kind === 'source' ? (rawSource as string) : null,
  })
}

/** 失败闭合的能力投影（字段缺失/形状非法时只读，绝不猜能力）。 */
export function degradedCapabilities(
  reason: 'missing' | 'contract_unsupported' | 'invalid_shape',
  contract: string | null = null,
): ResearchSessionCapabilities {
  return {
    contract,
    editorReady: false,
    submissionReady: { global: false, source: false },
    degraded: true,
    reason,
  }
}

/**
 * 解析 `capabilities`（DESIGN §3.3）：
 * - contract 不符 → 保留阅读，编辑/发送禁用；
 * - 形状缺失/非法 → 同上（fail-closed），不抛错；
 * - 合法 → editorReady / submissionReady 逐 kind 透传。
 */
export function parseCapabilities(value: unknown, field = 'capabilities'): ResearchSessionCapabilities {
  if (value === undefined || value === null) return degradedCapabilities('missing')
  if (!isRecord(value)) return degradedCapabilities('invalid_shape')
  const sessions = value.sessions
  if (!isRecord(sessions)) return degradedCapabilities('missing')
  const contract = typeof sessions.contract === 'string' ? sessions.contract : null
  const contractSupported = contract === SESSION_CONTRACT_VERSION
  const rawEditorReady = sessions.editor_ready
  const rawSubmission = sessions.submission_ready
  const submissionShapeValid =
    isRecord(rawSubmission) &&
    typeof rawSubmission.global === 'boolean' &&
    typeof rawSubmission.source === 'boolean'
  if (typeof rawEditorReady !== 'boolean' || !submissionShapeValid) {
    return degradedCapabilities(contract === null ? 'missing' : 'invalid_shape', contract)
  }
  if (!contractSupported) {
    return degradedCapabilities('contract_unsupported', contract)
  }
  return {
    contract,
    editorReady: rawEditorReady,
    submissionReady: {
      global: (rawSubmission as JsonObject).global as boolean,
      source: (rawSubmission as JsonObject).source as boolean,
    },
    degraded: false,
    reason: null,
  }
}

/** 编辑状态 `base_scope` 投影（wire 规整为 camelCase 内部形状）。 */
export interface WireEditorBaseScope {
  readonly mode: 'all' | 'selected'
  readonly sourceIds: readonly string[]
  readonly singleSourceId: null
}

export interface WireChatAnchor {
  readonly messageId: string
  readonly offsetPx: number
  readonly followTail: boolean
}

export interface WireReaderAnchor {
  readonly sourceId: string
  readonly documentId: string
  readonly documentVersion: string
  readonly format: 'normalized_markdown'
  readonly chunkId: string | null
  readonly chunkOrdinal: number
  readonly contentHash: string
  readonly pageIdx: number | null
  readonly offsetPx: number
}

/** 编辑状态投影；`kind` 冗余保存以便调用方复查来源约束。 */
export interface WireEditorState {
  readonly kind: ResearchSessionKind
  readonly schemaVersion: 1
  readonly baseScope: WireEditorBaseScope | null
  readonly singleSourceId: string | null
  readonly noteIds: readonly string[]
  readonly draft: {
    readonly text: string
    readonly token: string
  }
  readonly chatAnchor: WireChatAnchor | null
  readonly readerAnchor: WireReaderAnchor | null
}

function parseInt32(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < -2_147_483_647 || value > 2_147_483_647) return null
  return value
}

function parseBaseScope(value: unknown, field: string): ParseResult<WireEditorBaseScope> {
  if (!isRecord(value)) return invalid(field, 'base_scope must be an object')
  if (!hasOnlyKeys(value, ['mode', 'source_ids', 'single_source_id'])) {
    return invalid(field, 'base_scope has unexpected fields')
  }
  if (value.mode !== 'all' && value.mode !== 'selected') {
    return invalid(`${field}.mode`, 'mode must be all or selected')
  }
  if (value.single_source_id !== null) {
    return invalid(`${field}.single_source_id`, 'base_scope.single_source_id must be null')
  }
  const sourceIds = value.source_ids
  if (!Array.isArray(sourceIds) || sourceIds.length > 1000) {
    return invalid(`${field}.source_ids`, 'source_ids must be an array of at most 1000 entries')
  }
  const seen = new Set<string>()
  for (const entry of sourceIds) {
    if (!isNonEmptyString(entry, 256)) return invalid(`${field}.source_ids`, 'source_ids entries must be 1..256 characters')
    if (seen.has(entry)) return invalid(`${field}.source_ids`, 'source_ids must be unique')
    seen.add(entry)
  }
  if (value.mode === 'all' && sourceIds.length > 0) {
    return invalid(`${field}.source_ids`, 'mode=all requires an empty source_ids')
  }
  return ok({ mode: value.mode, sourceIds, singleSourceId: null })
}

function parseChatAnchor(value: unknown, field: string): ParseResult<WireChatAnchor | null> {
  if (value === null) return ok(null)
  if (!isRecord(value)) return invalid(field, 'chat_anchor must be an object or null')
  if (!hasOnlyKeys(value, ['message_id', 'offset_px', 'follow_tail'])) {
    return invalid(field, 'chat_anchor has unexpected fields')
  }
  if (!isNonEmptyString(value.message_id, 256)) return invalid(`${field}.message_id`, 'message_id must be 1..256 characters')
  const offset = parseInt32(value.offset_px)
  if (offset === null) return invalid(`${field}.offset_px`, 'offset_px must be a 32-bit integer')
  if (typeof value.follow_tail !== 'boolean') return invalid(`${field}.follow_tail`, 'follow_tail must be a boolean')
  return ok({ messageId: value.message_id, offsetPx: offset, followTail: value.follow_tail })
}

function parseReaderAnchor(value: unknown, field: string): ParseResult<WireReaderAnchor | null> {
  if (value === null) return ok(null)
  if (!isRecord(value)) return invalid(field, 'reader_anchor must be an object or null')
  const keys = [
    'source_id',
    'document_id',
    'document_version',
    'format',
    'chunk_id',
    'chunk_ordinal',
    'content_hash',
    'page_idx',
    'offset_px',
  ] as const
  if (!hasOnlyKeys(value, keys)) return invalid(field, 'reader_anchor has unexpected fields')
  const sourceId = value.source_id
  const documentId = value.document_id
  const documentVersion = value.document_version
  const contentHash = value.content_hash
  if (!isNonEmptyString(sourceId, 256)) {
    return invalid(`${field}.source_id`, 'source_id must be 1..256 characters')
  }
  if (!isNonEmptyString(documentId, 256)) {
    return invalid(`${field}.document_id`, 'document_id must be 1..256 characters')
  }
  if (!isNonEmptyString(documentVersion, 256)) {
    return invalid(`${field}.document_version`, 'document_version must be 1..256 characters')
  }
  if (!isNonEmptyString(contentHash, 256)) {
    return invalid(`${field}.content_hash`, 'content_hash must be 1..256 characters')
  }
  if (value.format !== 'normalized_markdown') {
    return invalid(`${field}.format`, 'format must be normalized_markdown')
  }
  const rawChunkId = value.chunk_id
  if (rawChunkId !== null && !isNonEmptyString(rawChunkId, 256)) {
    return invalid(`${field}.chunk_id`, 'chunk_id must be null or 1..256 characters')
  }
  const chunkId: string | null = isNonEmptyString(rawChunkId, 256) ? rawChunkId : null
  const chunkOrdinal = value.chunk_ordinal
  if (typeof chunkOrdinal !== 'number' || !Number.isInteger(chunkOrdinal) || chunkOrdinal < 0 || chunkOrdinal > 2_147_483_647) {
    return invalid(`${field}.chunk_ordinal`, 'chunk_ordinal must be a non-negative 32-bit integer')
  }
  const rawPageIdx = value.page_idx
  const pageIdx: number | null =
    typeof rawPageIdx === 'number' && Number.isInteger(rawPageIdx) && rawPageIdx >= 0 ? rawPageIdx : null
  if (rawPageIdx !== null && pageIdx === null) {
    return invalid(`${field}.page_idx`, 'page_idx must be null or a non-negative integer')
  }
  const offsetPx = parseInt32(value.offset_px)
  if (offsetPx === null) return invalid(`${field}.offset_px`, 'offset_px must be a 32-bit integer')
  return ok({
    sourceId,
    documentId,
    documentVersion,
    format: 'normalized_markdown',
    chunkId,
    chunkOrdinal,
    contentHash,
    pageIdx,
    offsetPx,
  })
}

/**
 * 解析 `editor_state`（第一批 `$defs`）；按 kind 施加 global/source 约束：
 * - global：`base_scope` 必须是对象；
 * - source：`base_scope`、`single_source_id` 必须为 null 且 `note_ids` 为空。
 */
export function parseEditorState(
  value: unknown,
  kind: ResearchSessionKind,
  field = 'editor_state',
): ParseResult<WireEditorState> {
  if (!isRecord(value)) return invalid(field, 'editor_state must be an object')
  const keys = [
    'schema_version',
    'base_scope',
    'single_source_id',
    'note_ids',
    'draft',
    'chat_anchor',
    'reader_anchor',
  ] as const
  if (!hasOnlyKeys(value, keys)) return invalid(field, 'editor_state has unexpected fields')
  if (value.schema_version !== 1) return invalid(`${field}.schema_version`, 'schema_version must be 1')
  const baseScope: ParseResult<WireEditorBaseScope | null> =
    value.base_scope === null ? ok(null) : parseBaseScope(value.base_scope, `${field}.base_scope`)
  if (!baseScope.ok) return baseScope
  if (value.single_source_id !== null && !isNonEmptyString(value.single_source_id, 256)) {
    return invalid(`${field}.single_source_id`, 'single_source_id must be null or 1..256 characters')
  }
  if (!Array.isArray(value.note_ids) || value.note_ids.length > 1000) {
    return invalid(`${field}.note_ids`, 'note_ids must be an array of at most 1000 entries')
  }
  const noteIds = value.note_ids
  const seenNotes = new Set<string>()
  for (const entry of noteIds) {
    if (!isNonEmptyString(entry, 256)) return invalid(`${field}.note_ids`, 'note_ids entries must be 1..256 characters')
    if (seenNotes.has(entry)) return invalid(`${field}.note_ids`, 'note_ids must be unique')
    seenNotes.add(entry)
  }
  const draft = value.draft
  if (!isRecord(draft)) return invalid(`${field}.draft`, 'draft must be an object')
  if (!hasOnlyKeys(draft, ['text', 'token'])) return invalid(`${field}.draft`, 'draft has unexpected fields')
  if (typeof draft.text !== 'string') return invalid(`${field}.draft.text`, 'draft.text must be a string')
  if (!isToken(draft.token)) return invalid(`${field}.draft.token`, 'draft.token must match ^[A-Za-z0-9_-]{1,128}$')
  const chatAnchor = parseChatAnchor(value.chat_anchor, `${field}.chat_anchor`)
  if (!chatAnchor.ok) return chatAnchor
  const readerAnchor = parseReaderAnchor(value.reader_anchor, `${field}.reader_anchor`)
  if (!readerAnchor.ok) return readerAnchor
  if (kind === 'global') {
    if (baseScope.value === null) return invalid(`${field}.base_scope`, 'global editor_state requires base_scope')
  } else {
    if (baseScope.value !== null) return invalid(`${field}.base_scope`, 'source editor_state requires base_scope=null')
    if (value.single_source_id !== null) {
      return invalid(`${field}.single_source_id`, 'source editor_state requires single_source_id=null')
    }
    if (noteIds.length > 0) return invalid(`${field}.note_ids`, 'source editor_state requires empty note_ids')
  }
  return ok({
    kind,
    schemaVersion: 1,
    baseScope: baseScope.value,
    singleSourceId: value.single_source_id as string | null,
    noteIds,
    draft: { text: draft.text, token: draft.token },
    chatAnchor: chatAnchor.value,
    readerAnchor: readerAnchor.value,
  })
}

/** 列表条目投影（`session_summary` 或降级 `legacy_session`）。 */
export interface ResearchSessionSummaryProjection {
  readonly ref: ResearchSessionRef
  readonly title: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly visibility: ResearchSessionVisibility | null
  readonly hasDraft: boolean | null
  /** true 表示来自无 `session_ref` 的旧 DTO（第三批实际不可达的降级路径）。 */
  readonly legacy: boolean
  readonly visibilityDegraded: boolean
}

function parseVisibility(value: unknown): ResearchSessionVisibility | null {
  if (value === 'visible' || value === 'restricted' || value === 'legacy_context_unverifiable') return value
  return null
}

function parseSummaryItem(
  value: unknown,
  field: string,
): ParseResult<ResearchSessionSummaryProjection> {
  if (!isRecord(value)) return invalid(field, 'session summary must be an object')
  const hasRef = value.session_ref !== undefined
  if (!hasRef) {
    // 降级路径：旧列表 DTO（`legacy_session`，additionalProperties:true）。
    // 第三批恒带契约头，实际不可达；只在字段确实缺失时投影为“未知”。
    if (!isToken(value.session_id)) return invalid(`${field}.session_id`, 'legacy session_id must match ^[A-Za-z0-9_-]{1,128}$')
    if (value.title !== null && typeof value.title !== 'string') {
      return invalid(`${field}.title`, 'legacy title must be a string or null')
    }
    if (typeof value.title === 'string' && value.title.length > 80) {
      return invalid(`${field}.title`, 'legacy title must be at most 80 characters')
    }
    if (!isDateTime(value.created_at)) return invalid(`${field}.created_at`, 'created_at must be a date-time string')
    if (!isDateTime(value.updated_at)) return invalid(`${field}.updated_at`, 'updated_at must be a date-time string')
    const visibility = parseVisibility(value.record_visibility)
    return ok({
      ref: {
        domain: SESSION_DOMAIN,
        kind: 'global',
        projectId: '',
        sessionId: value.session_id as string,
        sourceId: null,
      },
      title: (value.title as string | null) ?? null,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
      visibility,
      hasDraft: null,
      legacy: true,
      visibilityDegraded: visibility === null,
    })
  }
  const summaryKeys = [
    'session_ref',
    'title',
    'created_at',
    'updated_at',
    'record_visibility',
    'has_draft',
  ] as const
  if (!hasOnlyKeys(value, summaryKeys)) return invalid(field, 'session summary has unexpected fields')
  const ref = parseSessionRef(value.session_ref, `${field}.session_ref`)
  if (!ref.ok) return ref
  if (value.title !== null && typeof value.title !== 'string') {
    return invalid(`${field}.title`, 'title must be a string or null')
  }
  if (typeof value.title === 'string' && value.title.length > 80) {
    return invalid(`${field}.title`, 'title must be at most 80 characters')
  }
  if (!isDateTime(value.created_at)) return invalid(`${field}.created_at`, 'created_at must be a date-time string')
  if (!isDateTime(value.updated_at)) return invalid(`${field}.updated_at`, 'updated_at must be a date-time string')
  const visibility = parseVisibility(value.record_visibility)
  // `record_visibility` 在 session_summary 中是必填；**缺失**视为降级（未知，仅
  // 覆盖无契约头旧 DTO），但出现无法识别的值属于形状非法，必须拒绝——
  // 不得把非法值静默当成“未知/占位”（DESIGN §4.2/§4.6）。
  if (value.record_visibility !== undefined && visibility === null) {
    return invalid(`${field}.record_visibility`, 'record_visibility is not a known value')
  }
  const visibilityDegraded = value.record_visibility === undefined
  if (value.has_draft !== null && typeof value.has_draft !== 'boolean') {
    return invalid(`${field}.has_draft`, 'has_draft must be a boolean or null')
  }
  return ok({
    ref: ref.value,
    title: (value.title as string | null) ?? null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    visibility,
    hasDraft: (value.has_draft as boolean | null) ?? null,
    legacy: false,
    visibilityDegraded,
  })
}

/** `list_response` 投影。 */
export interface ResearchSessionListProjection {
  readonly items: readonly ResearchSessionSummaryProjection[]
  readonly nextCursor: string | null
  readonly viewerUserId: number
  readonly capabilities: ResearchSessionCapabilities
}

/** 解析 `GET /chat/sessions` 响应（02 §3：list_query → list_response）。 */
export function parseListResponse(value: unknown): ParseResult<ResearchSessionListProjection> {
  if (!isRecord(value)) return invalid('', 'list response must be an object')
  const keys = ['items', 'next_cursor', 'viewer_user_id', 'capabilities'] as const
  if (!hasOnlyKeys(value, keys)) return invalid('', 'list response has unexpected fields')
  const items = value.items
  if (!Array.isArray(items) || items.length > SESSION_LIST_MAX_ITEMS) {
    return invalid('items', 'items must be an array of at most 100 entries')
  }
  if (value.next_cursor !== null && !isCursor(value.next_cursor)) {
    return invalid('next_cursor', 'next_cursor must be null or a valid cursor')
  }
  if (!isViewerUserId(value.viewer_user_id)) {
    return invalid('viewer_user_id', 'viewer_user_id must be a positive safe integer')
  }
  const parsedItems: ResearchSessionSummaryProjection[] = []
  for (const [index, item] of items.entries()) {
    const parsed = parseSummaryItem(item, `items[${index}]`)
    if (!parsed.ok) return parsed
    parsedItems.push(parsed.value)
  }
  return ok({
    items: parsedItems,
    nextCursor: value.next_cursor as string | null,
    viewerUserId: value.viewer_user_id,
    capabilities: parseCapabilities(value.capabilities),
  })
}

/** `editor_response` 投影（详情与编辑状态同一响应形状）。 */
export interface ResearchEditorResponseProjection {
  readonly ref: ResearchSessionRef
  readonly editorRevision: number
  readonly editorState: WireEditorState | null
  readonly stateWarnings: readonly string[]
  readonly editorIntentHash: string | null
  readonly viewerUserId: number
  readonly capabilities: ResearchSessionCapabilities
}

const EDITOR_RESPONSE_KEYS = [
  'session_ref',
  'editor_revision',
  'editor_state',
  'state_warnings',
  'editor_intent_hash',
  'viewer_user_id',
  'capabilities',
] as const

function parseStateWarnings(value: unknown): ParseResult<readonly string[]> {
  if (!Array.isArray(value)) return invalid('state_warnings', 'state_warnings must be an array')
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isNonEmptyString(entry, 256)) return invalid('state_warnings', 'state_warnings entries must be 1..256 characters')
    if (seen.has(entry)) return invalid('state_warnings', 'state_warnings must be unique')
    seen.add(entry)
  }
  return ok(value)
}

/**
 * 解析 `editor_response`（GET/PUT editor-state）。
 *
 * 硬约束（第一批 allOf）：
 * - `editor_state=null` ⇔ `editor_intent_hash=null` 且 warnings 含 `editor_state_unreadable`；
 * - 非 null ⇔ hash 为 64 位小写十六进制且 warnings 不含该值。
 */
export function parseEditorResponse(value: unknown): ParseResult<ResearchEditorResponseProjection> {
  if (!isRecord(value)) return invalid('', 'editor response must be an object')
  if (!hasOnlyKeys(value, EDITOR_RESPONSE_KEYS)) {
    return invalid('', 'editor response has unexpected fields')
  }
  const ref = parseSessionRef(value.session_ref)
  if (!ref.ok) return ref
  if (!isRevision(value.editor_revision)) {
    return invalid('editor_revision', 'editor_revision must be an integer in 0..2147483647')
  }
  const warnings = parseStateWarnings(value.state_warnings)
  if (!warnings.ok) return warnings
  const rawState = value.editor_state
  let editorState: WireEditorState | null = null
  if (rawState !== null) {
    const parsed = parseEditorState(rawState, ref.value.kind)
    if (!parsed.ok) return parsed
    editorState = parsed.value
  }
  const hashValue = value.editor_intent_hash
  const warningsList = warnings.value
  const hasUnreadableWarning = warningsList.includes('editor_state_unreadable')
  if (editorState === null) {
    if (hashValue !== null) return invalid('editor_intent_hash', 'editor_intent_hash must be null when editor_state is null')
    if (!hasUnreadableWarning) {
      return invalid('state_warnings', 'editor_state_unreadable warning is required when editor_state is null')
    }
  } else {
    if (!isHash(hashValue)) return invalid('editor_intent_hash', 'editor_intent_hash must be 64 lowercase hex characters')
    if (hasUnreadableWarning) {
      return invalid('state_warnings', 'editor_state_unreadable cannot accompany a readable editor_state')
    }
  }
  if (!isViewerUserId(value.viewer_user_id)) {
    return invalid('viewer_user_id', 'viewer_user_id must be a positive safe integer')
  }
  return ok({
    ref: ref.value,
    editorRevision: value.editor_revision,
    editorState,
    stateWarnings: warningsList,
    editorIntentHash: editorState === null ? null : (hashValue as string),
    viewerUserId: value.viewer_user_id,
    capabilities: parseCapabilities(value.capabilities),
  })
}

/** `save_response` 投影。 */
export interface ResearchSaveResponseProjection {
  readonly ref: ResearchSessionRef
  readonly editorRevision: number
  readonly editorState: WireEditorState | null
  readonly mutationId: string
  readonly savedAt: string
  readonly editorIntentHash: string
}

/** 解析 `PUT .../editor-state` 响应（save_request → save_response）。 */
export function parseSaveResponse(value: unknown): ParseResult<ResearchSaveResponseProjection> {
  if (!isRecord(value)) return invalid('', 'save response must be an object')
  const keys = ['session_ref', 'editor_revision', 'editor_state', 'mutation_id', 'saved_at', 'editor_intent_hash'] as const
  if (!hasOnlyKeys(value, keys)) return invalid('', 'save response has unexpected fields')
  const ref = parseSessionRef(value.session_ref)
  if (!ref.ok) return ref
  if (!isRevision(value.editor_revision)) {
    return invalid('editor_revision', 'editor_revision must be an integer in 0..2147483647')
  }
  let editorState: WireEditorState | null = null
  if (value.editor_state !== null) {
    const parsed = parseEditorState(value.editor_state, ref.value.kind)
    if (!parsed.ok) return parsed
    editorState = parsed.value
  }
  if (!isToken(value.mutation_id)) {
    return invalid('mutation_id', 'mutation_id must match ^[A-Za-z0-9_-]{1,128}$')
  }
  if (!isDateTime(value.saved_at)) return invalid('saved_at', 'saved_at must be a date-time string')
  if (!isHash(value.editor_intent_hash)) {
    return invalid('editor_intent_hash', 'editor_intent_hash must be 64 lowercase hex characters')
  }
  return ok({
    ref: ref.value,
    editorRevision: value.editor_revision,
    editorState,
    mutationId: value.mutation_id,
    savedAt: value.saved_at,
    editorIntentHash: value.editor_intent_hash,
  })
}

/** `context_report` 投影（PR-1 只校验/透传，渲染归 PR-5b）。 */
export interface ResearchContextReportProjection {
  readonly version: 1
  readonly status: 'complete' | 'trimmed' | 'blocked' | 'unknown'
  readonly history: {
    readonly availableTurns: number | null
    readonly includedTurns: number | null
    readonly omittedTurns: number | null
  }
  readonly evidence: {
    readonly includedChunks: number | null
    readonly omittedChunks: number | null
  }
  readonly inputBudget: number | null
  readonly serializedInputTokens: number | null
  readonly estimatorVersion: string | null
  readonly reasonCodes: readonly string[]
  readonly requiredContextMissing: boolean
  readonly measurementScope: 'final_reasoning_call' | 'unknown'
}

function parseCount(value: unknown, field: string): ParseResult<number | null> {
  if (value === null) return ok(null)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    return invalid(field, 'count must be null or a non-negative 32-bit integer')
  }
  return ok(value)
}

function parseContextReport(value: unknown): ParseResult<ResearchContextReportProjection> {
  if (!isRecord(value)) return invalid('context_report', 'context_report must be an object')
  const keys = [
    'version',
    'status',
    'history',
    'evidence',
    'input_budget',
    'serialized_input_tokens',
    'estimator_version',
    'reason_codes',
    'required_context_missing',
    'measurement_scope',
  ] as const
  if (!hasOnlyKeys(value, keys)) return invalid('context_report', 'context_report has unexpected fields')
  if (value.version !== 1) return invalid('context_report.version', 'version must be 1')
  if (!['complete', 'trimmed', 'blocked', 'unknown'].includes(value.status as string)) {
    return invalid('context_report.status', 'status must be complete|trimmed|blocked|unknown')
  }
  const history = value.history
  if (!isRecord(history) || !hasOnlyKeys(history, ['available_turns', 'included_turns', 'omitted_turns'])) {
    return invalid('context_report.history', 'history must be an object with three counters')
  }
  const availableTurns = parseCount(history.available_turns, 'context_report.history.available_turns')
  if (!availableTurns.ok) return availableTurns
  const includedTurns = parseCount(history.included_turns, 'context_report.history.included_turns')
  if (!includedTurns.ok) return includedTurns
  const omittedTurns = parseCount(history.omitted_turns, 'context_report.history.omitted_turns')
  if (!omittedTurns.ok) return omittedTurns
  const evidence = value.evidence
  if (!isRecord(evidence) || !hasOnlyKeys(evidence, ['included_chunks', 'omitted_chunks'])) {
    return invalid('context_report.evidence', 'evidence must be an object with two counters')
  }
  const includedChunks = parseCount(evidence.included_chunks, 'context_report.evidence.included_chunks')
  if (!includedChunks.ok) return includedChunks
  const omittedChunks = parseCount(evidence.omitted_chunks, 'context_report.evidence.omitted_chunks')
  if (!omittedChunks.ok) return omittedChunks
  const inputBudget = parseCount(value.input_budget, 'context_report.input_budget')
  if (!inputBudget.ok) return inputBudget
  const serializedInputTokens = parseCount(
    value.serialized_input_tokens,
    'context_report.serialized_input_tokens',
  )
  if (!serializedInputTokens.ok) return serializedInputTokens
  if (value.estimator_version !== null && !isNonEmptyString(value.estimator_version, 256)) {
    return invalid('context_report.estimator_version', 'estimator_version must be null or 1..256 characters')
  }
  if (!isStringArrayUnique(value.reason_codes, 1000)) {
    return invalid('context_report.reason_codes', 'reason_codes must be unique codes')
  }
  if (typeof value.required_context_missing !== 'boolean') {
    return invalid('context_report.required_context_missing', 'required_context_missing must be a boolean')
  }
  if (value.measurement_scope !== 'final_reasoning_call' && value.measurement_scope !== 'unknown') {
    return invalid('context_report.measurement_scope', 'measurement_scope must be final_reasoning_call|unknown')
  }
  return ok({
    version: 1,
    status: value.status as ResearchContextReportProjection['status'],
    history: {
      availableTurns: availableTurns.value,
      includedTurns: includedTurns.value,
      omittedTurns: omittedTurns.value,
    },
    evidence: {
      includedChunks: includedChunks.value,
      omittedChunks: omittedChunks.value,
    },
    inputBudget: inputBudget.value,
    serializedInputTokens: serializedInputTokens.value,
    estimatorVersion: (value.estimator_version as string | null) ?? null,
    reasonCodes: value.reason_codes,
    requiredContextMissing: value.required_context_missing,
    measurementScope: value.measurement_scope,
  })
}

/** `submission_response` 投影（含状态矩阵校验）。 */
export interface ResearchSubmissionResponseProjection {
  readonly ref: ResearchSessionRef
  readonly draftToken: string
  readonly idempotencyKey: string
  readonly acceptanceState: ResearchAcceptanceState
  readonly generationId: string | null
  readonly generationState: ResearchGenerationState | null
  readonly acceptedEditorRevision: number | null
  readonly editorIntentHash: string | null
  readonly submittedDraftText: string | null
  readonly contextReport: ResearchContextReportProjection | null
}

/** 解析 `GET .../submissions/{draft_token}`（submission_response）。 */
export function parseSubmissionResponse(value: unknown): ParseResult<ResearchSubmissionResponseProjection> {
  if (!isRecord(value)) return invalid('', 'submission response must be an object')
  const keys = [
    'session_ref',
    'draft_token',
    'idempotency_key',
    'acceptance_state',
    'generation_id',
    'generation_state',
    'accepted_editor_revision',
    'editor_intent_hash',
    'submitted_draft_text',
    'context_report',
  ] as const
  if (!hasOnlyKeys(value, keys)) return invalid('', 'submission response has unexpected fields')
  const ref = parseSessionRef(value.session_ref)
  if (!ref.ok) return ref
  if (!isToken(value.draft_token)) {
    return invalid('draft_token', 'draft_token must match ^[A-Za-z0-9_-]{1,128}$')
  }
  if (typeof value.idempotency_key !== 'string' || !SUBMISSION_KEY_PATTERN.test(value.idempotency_key)) {
    return invalid('idempotency_key', 'idempotency_key must match ^s1_[a-f0-9]{64}$')
  }
  const acceptance = value.acceptance_state
  if (acceptance !== 'not_observed' && acceptance !== 'accepted' && acceptance !== 'terminal' && acceptance !== 'outcome_unknown') {
    return invalid('acceptance_state', 'acceptance_state is not a known value')
  }
  const rawGenerationState = value.generation_state
  const allowedStates: Record<ResearchAcceptanceState, readonly (string | null)[]> = {
    not_observed: [null],
    accepted: ['accepted', 'running', 'job_queued'],
    terminal: ['completed', 'failed'],
    outcome_unknown: ['outcome_unknown'],
  }
  if (!allowedStates[acceptance].includes(rawGenerationState as string | null)) {
    return invalid('generation_state', `generation_state is not consistent with acceptance_state=${acceptance}`)
  }
  if (acceptance === 'not_observed') {
    const nullish = [
      value.generation_id,
      value.generation_state,
      value.accepted_editor_revision,
      value.editor_intent_hash,
      value.submitted_draft_text,
      value.context_report,
    ]
    if (nullish.some((entry) => entry !== null)) {
      return invalid('acceptance_state', 'not_observed requires all derived fields to be null')
    }
    return ok({
      ref: ref.value,
      draftToken: value.draft_token,
      idempotencyKey: value.idempotency_key,
      acceptanceState: 'not_observed',
      generationId: null,
      generationState: null,
      acceptedEditorRevision: null,
      editorIntentHash: null,
      submittedDraftText: null,
      contextReport: null,
    })
  }
  if (!isNonEmptyString(value.generation_id, 256)) {
    return invalid('generation_id', 'generation_id must be 1..256 characters')
  }
  if (!isRevision(value.accepted_editor_revision)) {
    return invalid('accepted_editor_revision', 'accepted_editor_revision must be an integer in 0..2147483647')
  }
  if (!isHash(value.editor_intent_hash)) {
    return invalid('editor_intent_hash', 'editor_intent_hash must be 64 lowercase hex characters')
  }
  if (typeof value.submitted_draft_text !== 'string') {
    return invalid('submitted_draft_text', 'submitted_draft_text must be a string')
  }
  let contextReport: ResearchContextReportProjection | null = null
  if (value.context_report !== null) {
    const parsed = parseContextReport(value.context_report)
    if (!parsed.ok) return parsed
    contextReport = parsed.value
  }
  return ok({
    ref: ref.value,
    draftToken: value.draft_token,
    idempotencyKey: value.idempotency_key,
    acceptanceState: acceptance,
    generationId: value.generation_id,
    generationState: rawGenerationState as ResearchGenerationState,
    acceptedEditorRevision: value.accepted_editor_revision,
    editorIntentHash: value.editor_intent_hash,
    submittedDraftText: value.submitted_draft_text,
    contextReport,
  })
}

/** 服务端稳定错误码集合（02 §7）。 */
export const SESSION_SERVER_ERROR_CODES = [
  'chat_owner_required',
  'history_egress_not_authorized',
  'session_not_found',
  'editor_revision_conflict',
  'editor_mutation_conflict',
  'editor_revision_exhausted',
  'editor_state_unreadable',
  'session_context_changed',
  'session_busy',
  'submission_intent_conflict',
  'stream_identity_mismatch',
  'acceptance_outcome_unknown',
  'editor_state_too_large',
  'editor_state_invalid',
  'session_contract_unsupported',
  'context_limit_exceeded',
  'scope_header_payload_mismatch',
  'scope_requires_specific_source',
  'c05_contract_not_enabled',
  'session_store_unavailable',
  'input_snapshot_unavailable',
  'c05_entry_not_ready',
  'admission_unavailable',
  'admission_capacity',
  'internal',
  'project_deleted',
  'epoch_mismatch',
  'job_cancelled',
] as const

export type SessionServerErrorCode = (typeof SESSION_SERVER_ERROR_CODES)[number]

const SERVER_ERROR_CODE_SET = new Set<string>(SESSION_SERVER_ERROR_CODES)

/** 客户端可处理的认证/权限类错误码；`401` 没有专用 code（按状态判定）。 */
export const SESSION_AUTH_ERROR_CODES = {
  ownerRequired: 'chat_owner_required',
  historyEgressNotAuthorized: 'history_egress_not_authorized',
} as const

/** 会话错误投影。 */
export interface ResearchSessionErrorProjection {
  readonly status: number
  /** 服务端稳定码；未知/缺失时回退 `unknown_error`（401 回退 `unauthenticated`）。 */
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly requestId: string | null
  readonly currentRevision: number | null
  readonly ref: ResearchSessionRef | null
  readonly recognized: boolean
}

/** 解析错误响应体（02 §8 `parseSessionError`），只做稳定码投影，不渲染文案。 */
export function parseSessionError(status: number, body: unknown): ResearchSessionErrorProjection {
  const fallbackCode = status === 401 ? 'unauthenticated' : 'unknown_error'
  const retryableFallback = status >= 500
  if (!isRecord(body) || !isRecord(body.detail)) {
    return {
      status,
      code: fallbackCode,
      message: '',
      retryable: retryableFallback,
      requestId: null,
      currentRevision: null,
      ref: null,
      recognized: false,
    }
  }
  const detail = body.detail
  const code = typeof detail.code === 'string' && detail.code.length > 0 && detail.code.length <= 256
    ? detail.code
    : fallbackCode
  const message = typeof detail.message === 'string' ? detail.message : ''
  const retryable = typeof detail.retryable === 'boolean' ? detail.retryable : retryableFallback
  const requestId =
    typeof detail.request_id === 'string' && detail.request_id.length > 0 && detail.request_id.length <= 256
      ? detail.request_id
      : null
  const currentRevision = typeof detail.current_revision === 'number' && Number.isInteger(detail.current_revision)
    ? detail.current_revision
    : null
  let ref: ResearchSessionRef | null = null
  if (detail.session_ref !== undefined) {
    const parsed = parseSessionRef(detail.session_ref, 'detail.session_ref')
    if (parsed.ok) ref = parsed.value
  }
  return {
    status,
    code,
    message,
    retryable,
    requestId,
    currentRevision,
    ref,
    recognized: SERVER_ERROR_CODE_SET.has(code),
  }
}

// ---------------------------------------------------------------------------
// 可见性投影（DESIGN §4.2、§4.6；PR-1 验收点 B6 / 评审 M5 补充用例）
// ---------------------------------------------------------------------------

const VISIBILITY_RANK: Record<ResearchSessionVisibility, number> = {
  visible: 0,
  legacy_context_unverifiable: 1,
  restricted: 2,
}

/**
 * 会话可见性投影：列表投影与详情投影**取更严一档**。
 *
 * 规则（DESIGN §4.6）：
 * - 任一侧 `restricted` → `restricted`（详情单页 `visible` 不得推翻列表 restricted）；
 * - 否则任一侧 `legacy_context_unverifiable` → 保留该值；
 * - 两侧都 `visible` → `visible`；
 * - 只有字段确实缺失（对应解析结果为 `null`）才降级为“未知”，
 *   `degraded=true` 表示存在缺失侧；**不得**把缺失无条件当成占位而不标记。
 */
export interface ProjectedSessionVisibility {
  readonly visibility: ResearchSessionVisibility | null
  /** true 表示至少一侧未提供可见性（未知），调用方按占位处理并标注。 */
  readonly degraded: boolean
  readonly source: 'list' | 'detail' | 'both' | 'unknown'
  /** 若最终为 restricted，记录是列表侧还是详情侧使其受限（用于审计/测试）。 */
  readonly restrictedBy: 'list' | 'detail' | null
}

export function projectSessionVisibility(
  listVisibility: ResearchSessionVisibility | null | undefined,
  detailVisibility: ResearchSessionVisibility | null | undefined,
): ProjectedSessionVisibility {
  const list = listVisibility ?? null
  const detail = detailVisibility ?? null
  if (list === null && detail === null) {
    return { visibility: null, degraded: true, source: 'unknown', restrictedBy: null }
  }
  if (list === null) {
    return { visibility: detail, degraded: true, source: 'detail', restrictedBy: detail === 'restricted' ? 'detail' : null }
  }
  if (detail === null) {
    return { visibility: list, degraded: true, source: 'list', restrictedBy: list === 'restricted' ? 'list' : null }
  }
  const listRank = VISIBILITY_RANK[list]
  const detailRank = VISIBILITY_RANK[detail]
  const visibility = detailRank > listRank ? detail : list
  const restrictedBy =
    visibility === 'restricted' ? (list === 'restricted' ? 'list' : 'detail') : null
  return {
    visibility,
    degraded: false,
    source: listRank === detailRank ? 'both' : detailRank > listRank ? 'detail' : 'list',
    restrictedBy: restrictedBy === null ? null : (restrictedBy as 'list' | 'detail'),
  }
}

/**
 * 由详情**当前页内消息**保守派生会话可见性（DESIGN §4.6）：
 * 页内任一 assistant 消息 `restricted` 即 `restricted`；否则若存在
 * `legacy_context_unverifiable` 则保留；全部 `visible` 才是 `visible`；
 * 任一条缺失/非法可见性 → `null`（未知，调用方不得据此放宽）。
 */
export function deriveDetailSessionVisibility(
  messages: readonly unknown[],
): ProjectedSessionVisibility {
  let restricted = false
  let legacy = false
  let unknown = false
  let assistantSeen = false
  for (const message of messages) {
    if (!isRecord(message)) {
      unknown = true
      continue
    }
    const role = message.role
    if (typeof role !== 'string') {
      unknown = true
      continue
    }
    if (role !== 'assistant') continue
    assistantSeen = true
    const visibility = parseVisibility(message.record_visibility)
    if (visibility === 'restricted') restricted = true
    else if (visibility === 'legacy_context_unverifiable') legacy = true
    else if (visibility !== 'visible') unknown = true
  }
  if (restricted) {
    return { visibility: 'restricted', degraded: unknown, source: 'detail', restrictedBy: 'detail' }
  }
  if (!assistantSeen) {
    return { visibility: null, degraded: true, source: 'unknown', restrictedBy: null }
  }
  if (unknown) {
    return { visibility: null, degraded: true, source: 'detail', restrictedBy: null }
  }
  return {
    visibility: legacy ? 'legacy_context_unverifiable' : 'visible',
    degraded: false,
    source: 'detail',
    restrictedBy: null,
  }
}

/** 单条消息投影：restricted 时不得携带正文（正文置 null，`displayable=false`）。 */
export interface ProjectedMessage {
  readonly messageId: string
  readonly role: 'user' | 'assistant' | 'system' | 'unknown'
  readonly visibility: ResearchSessionVisibility | null
  readonly content: string | null
  readonly displayable: boolean
  readonly degraded: boolean
}

export function projectMessage(record: unknown): ProjectedMessage {
  if (!isRecord(record)) {
    return {
      messageId: '',
      role: 'unknown',
      visibility: null,
      content: null,
      displayable: false,
      degraded: true,
    }
  }
  const messageId =
    typeof record.message_id === 'string' && record.message_id.length <= 256 ? record.message_id : ''
  const rawRole = record.role
  const role = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' ? rawRole : 'unknown'
  const visibility = parseVisibility(record.record_visibility)
  const degraded = visibility === null
  const content = typeof record.content === 'string' ? record.content : null
  const restricted = visibility === 'restricted'
  return {
    messageId,
    role,
    visibility,
    content: restricted ? null : content,
    displayable: !restricted && messageId.length > 0,
    degraded,
  }
}

/**
 * 可见性对应的渲染描述符（PR-1 决策 R5：**无 locale 文案**的稳定纯函数，
 * 具体文案由后续 PR 的 locale 层渲染）。
 */
export interface ProjectedVisibilityCopy {
  readonly code: 'visible' | 'restricted' | 'legacy_context_unverifiable' | 'unknown'
  readonly showsTitle: boolean
  readonly canOpen: boolean
  /** 只显示安全 ID/时间/状态/非正文计量（restricted）。 */
  readonly onlyNonBodyMetrics: boolean
  readonly badge: 'none' | 'legacy_unverifiable'
  readonly placeholderKey: string | null
  readonly degraded: boolean
}

export function projectRestrictedMessage(
  projection: ProjectedSessionVisibility,
): ProjectedVisibilityCopy {
  switch (projection.visibility) {
    case 'visible':
      return {
        code: 'visible',
        showsTitle: true,
        canOpen: true,
        onlyNonBodyMetrics: false,
        badge: 'none',
        placeholderKey: null,
        degraded: projection.degraded,
      }
    case 'legacy_context_unverifiable':
      return {
        code: 'legacy_context_unverifiable',
        showsTitle: true,
        canOpen: true,
        onlyNonBodyMetrics: false,
        badge: 'legacy_unverifiable',
        placeholderKey: null,
        degraded: projection.degraded,
      }
    case 'restricted':
      return {
        code: 'restricted',
        showsTitle: false,
        canOpen: true,
        onlyNonBodyMetrics: true,
        badge: 'none',
        placeholderKey: 'research.session.visibility.restricted',
        degraded: projection.degraded,
      }
    default:
      return {
        code: 'unknown',
        showsTitle: false,
        canOpen: false,
        onlyNonBodyMetrics: false,
        badge: 'none',
        placeholderKey: 'research.session.visibility.unknown',
        degraded: true,
      }
  }
}
