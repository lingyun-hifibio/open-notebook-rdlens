/**
 * Issue #1046 PR4（D2-B2）：d2-v1 Note API 传输层。
 *
 * 权威依据：
 * - 机器契约 `deploy/research/issue585_d2_contract_v1.yaml` §3/§4/§8；
 * - host PR3 实现 `src/rdlens/research/router.py`（Note 路由）与
 *   `src/rdlens/research/issue585/note_api.py`（读投影/错误包络）；
 * - 方案 v4 §4（编辑与恢复）。
 *
 * 设计要点：
 * - 复用既有 `apiClient`（`@/lib/api/client`）与 `buildResearchUrl`，绝不新建
 *   axios 实例、绝不绕过统一鉴权（Bearer 由 apiClient 拦截器注入）；
 * - 全部 d2-v1 请求携带 `X-Research-Note-Contract: d2-v1`（旧契约头
 *   `X-Research-Contract: v1` 由网关侧保持，前端不伪造）；
 * - 所有失败归一为 `NoteApiError`（稳定码 + retryable + request_id，409 冲突
 *   可带已授权 current_revision/current_snapshot_hash）；不携带正文/堆栈；
 * - 响应形状防御性校验：畸形响应归为「结果未知」（retryable），由状态机用
 *   同一 mutation_id 同请求确认，绝不按成功结算。
 */

import { apiClient } from '@/lib/api/client'
import type { ResearchPage } from '@/lib/types/research'
import { buildResearchUrl } from '../api'
import {
  NOTE_CONTRACT_HEADER,
  NOTE_CONTRACT_VALUE,
  type NoteApiError,
  type NoteCitationBinding,
  type NoteCitationSourceKind,
  type NoteD2FragmentCreateRequest,
  type NoteD2FragmentInsertRequest,
  type NoteDocumentDependency,
  type NoteErrorCode,
  type NoteLocator,
  type NoteOrigin,
  type NoteReceipt,
  type ResearchNoteD2,
} from './types'

// ── 请求/响应 wire 形状（与 host router / mutation_contract 逐字一致） ──

export interface NoteD2CreateRequest {
  mutation_id: string
  /** 缺省由服务端补「未命名成果」（契约 §3 title_rules）。 */
  title?: string
  /** 缺省由服务端补空串。 */
  content?: string
}

export interface NoteD2SaveRequest {
  mutation_id: string
  expected_revision: number
  title: string
  content: string
}

export interface NoteD2DeleteRequest {
  mutation_id: string
  expected_revision: number
}

export interface NoteD2EnableEditingRequest {
  mutation_id: string
}

export interface NoteD2CopyRequest {
  mutation_id: string
  /** 本地草稿编辑基线（不要求等于源文档最新 revision）。 */
  source_revision: number
  source_snapshot_hash: string
  title: string
  content: string
}

/** 首次启用保护响应（`{note, receipt}`；已保护时为当前投影 + receipt=null）。 */
export interface NoteD2EnableEditingResult {
  note: ResearchNoteD2
  receipt: NoteReceipt | null
}

export interface NoteD2ListParams {
  q?: string
  cursor?: string
  limit?: number
}

// ── 稳定错误码 ──

/** 契约 §8 全量稳定码（含传输层兜底码）。 */
const NOTE_ERROR_CODES: ReadonlySet<string> = new Set<NoteErrorCode>([
  'note_not_found',
  'note_access_restricted',
  'note_edit_schema_unsupported',
  'note_revision_required',
  'note_revision_conflict',
  'note_revision_exhausted',
  'note_snapshot_fence_exhausted',
  'mutation_id_reused',
  'note_request_invalid',
  'note_snapshot_unavailable',
  'note_dependency_unavailable',
  'note_store_unavailable',
  'fragment_source_not_found',
  'network_error',
  'unknown_error',
])

export function isNoteErrorCode(value: unknown): value is NoteErrorCode {
  return typeof value === 'string' && NOTE_ERROR_CODES.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 已归一化的错误是否原样返回（避免重复包装）。 */
export function isNoteApiError(value: unknown): value is NoteApiError {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    NOTE_ERROR_CODES.has(value.code) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean' &&
    typeof value.status === 'number'
  )
}

/**
 * 聚合错误包络（契约 §8）：`{detail: {code, message, retryable, request_id,
 * current_revision?, current_snapshot_hash?}}`。detail 为字符串时可解析 HTTP
 * 状态兜底；无响应（网络/中断）→ `network_error`（可重试）。
 */
export function normalizeNoteApiError(
  error: unknown,
  fallback: NoteErrorCode = 'unknown_error',
): NoteApiError {
  if (isNoteApiError(error)) return error

  const response = isRecord(error) && isRecord(error.response) ? error.response : null
  const status = response && typeof response.status === 'number' ? response.status : 0
  const data = response?.data
  const detail = isRecord(data) ? data.detail : undefined

  if (isRecord(detail)) {
    const rawCode = typeof detail.code === 'string' ? detail.code : null
    const code = isNoteErrorCode(rawCode)
      ? rawCode
      : (inferCodeFromStatus(status) ?? fallback)
    const message = typeof detail.message === 'string' ? detail.message : ''
    const retryable =
      typeof detail.retryable === 'boolean'
        ? detail.retryable
        : isTransportRetryableStatus(status)
    const requestId =
      typeof detail.request_id === 'string' && detail.request_id.length > 0
        ? detail.request_id
        : readRequestIdHeader(response)
    const currentRevision = readRevisionDetail(detail.current_revision)
    const currentSnapshotHash = readHashDetail(detail.current_snapshot_hash)
    return {
      code,
      message,
      retryable,
      status,
      ...(requestId ? { requestId } : {}),
      ...(currentRevision !== undefined ? { currentRevision } : {}),
      ...(currentSnapshotHash !== undefined ? { currentSnapshotHash } : {}),
    }
  }

  // 无 detail 对象（旧错误形状/网关兜底）：仅按状态映射可判定码。
  if (status === 0) {
    return {
      code: fallback === 'unknown_error' ? 'network_error' : fallback,
      message: '',
      retryable: true,
      status: 0,
    }
  }

  const inferred = inferCodeFromStatus(status) ?? fallback
  const requestId = readRequestIdHeader(response)
  return {
    code: inferred,
    message: typeof detail === 'string' ? detail : '',
    retryable: isTransportRetryableStatus(status),
    status,
    ...(requestId ? { requestId } : {}),
  }
}

function isTransportRetryableStatus(status: number): boolean {
  return status === 0 || status >= 500
}

/** 只有无歧义的状态才映射稳定码；409 等歧义状态交回契约码。 */
function inferCodeFromStatus(status: number): NoteErrorCode | null {
  if (status === 404) return 'note_not_found'
  if (status === 403) return 'note_access_restricted'
  if (status === 428) return 'note_revision_required'
  return null
}

function readRequestIdHeader(response: Record<string, unknown> | null): string | null {
  if (!response || !isRecord(response.headers)) return null
  const headers = response.headers
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'x-request-id') continue
    const value = headers[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  return null
}

function readRevisionDetail(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647) {
    return value
  }
  return undefined
}

function readHashDetail(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value
  return undefined
}

/**
 * 响应/回执形状不合法：服务端可能已经应用了变更，因此按「结果未知」
 * （retryable）上报，状态机保留同一 mutation_id 重放确认，绝不按成功结算。
 */
export function noteProtocolError(message = 'invalid note api response'): NoteApiError {
  return { code: 'unknown_error', message, retryable: true, status: 0 }
}

// ── 响应解析 ──

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw noteProtocolError()
  return value
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw noteProtocolError()
  return value
}

function optionalNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw noteProtocolError()
  return value
}

function optionalRevision(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw noteProtocolError()
  }
  return value
}

function optionalHash(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw noteProtocolError()
  return value
}

/**
 * 读投影归一化（旧字段 + 4 个新键）。
 *
 * 受限占位（列表）无标题/正文 → 归为空串（契约禁止在受限行展示正文；
 * `access_state='restricted'` 才是渲染依据）。旧 host 无新键时按等价
 * 「未保护」处理（`edit_schema=null`），绝不把缺失误读为受保护。
 */
const NOTE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  'source',
  'chat_message',
  'note',
  'legacy_insight',
])

function isNoteCitationSourceKind(value: unknown): value is NoteCitationSourceKind {
  return typeof value === 'string' && NOTE_SOURCE_KINDS.has(value)
}

function isStableIdValue(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** locator：null 或标量袋（键小写 snake）；畸形返回 null，不伪造定位。 */
function normalizeLocator(raw: unknown): NoteLocator | null {
  if (!isRecord(raw)) return null
  const normalized: NoteLocator = {}
  for (const key of Object.keys(raw)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) return null
    const value = raw[key]
    if (value === null || typeof value === 'boolean') {
      normalized[key] = value
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || Math.abs(value) > 9007199254740991) return null
      normalized[key] = value
      continue
    }
    if (typeof value === 'string') {
      if (value.length > 256) return null
      normalized[key] = value
      continue
    }
    return null
  }
  return normalized
}

/** 单个引用绑定的防御性解析（畸形条目丢弃，不抛整篇失败）。 */
function normalizeCitationBinding(raw: unknown): NoteCitationBinding | null {
  if (!isRecord(raw)) return null
  const bindingId = raw.binding_id
  const sourceKind = raw.source_kind
  const sourceId = raw.source_id
  const sourceVersion = raw.source_version
  const unresolved = raw.unresolved
  if (!isStableIdValue(bindingId)) return null
  if (!isNoteCitationSourceKind(sourceKind)) return null
  if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 256) return null
  if (sourceVersion !== null && typeof sourceVersion !== 'string') return null
  if (typeof unresolved !== 'boolean') return null
  return {
    binding_id: bindingId,
    source_kind: sourceKind,
    source_id: sourceId,
    source_version: sourceVersion,
    locator: normalizeLocator(raw.locator),
    unresolved,
  }
}

/** 读数投影的加性三键：缺失/畸形 → 空数组（fail-safe，不伪造来源）。 */
export function normalizeNoteCitationMetadata(raw: unknown): {
  citation_bindings: NoteCitationBinding[]
  origins: NoteOrigin[]
  document_dependencies: NoteDocumentDependency[]
} {
  const record = isRecord(raw) ? raw : {}
  const bindings = Array.isArray(record.citation_bindings)
    ? record.citation_bindings
        .map(normalizeCitationBinding)
        .filter((item): item is NoteCitationBinding => item !== null)
    : []
  const origins: NoteOrigin[] = Array.isArray(record.origins)
    ? record.origins.flatMap((item) => {
        if (!isRecord(item)) return []
        const originId = item.origin_id
        const sourceKind = item.source_kind
        const sourceId = item.source_id
        if (!isStableIdValue(originId) || !isNoteCitationSourceKind(sourceKind)) return []
        if (typeof sourceId !== 'string' || sourceId.length === 0) return []
        const sourceVersion = item.source_version
        if (sourceVersion !== null && typeof sourceVersion !== 'string') return []
        return [{
          origin_id: originId,
          source_kind: sourceKind,
          source_id: sourceId,
          source_version: sourceVersion,
          locator: normalizeLocator(item.locator),
        }]
      })
    : []
  const dependencies: NoteDocumentDependency[] = Array.isArray(record.document_dependencies)
    ? record.document_dependencies.flatMap((item): NoteDocumentDependency[] => {
        if (!isRecord(item)) return []
        const noteId = item.note_id
        const noteHash = item.note_content_hash
        if (isStableIdValue(noteId) && typeof noteHash === 'string' && /^[0-9a-f]{64}$/.test(noteHash)) {
          return [{ note_id: noteId, note_content_hash: noteHash }]
        }
        const documentId = item.document_id
        const documentVersion = item.document_version
        if (
          typeof documentId === 'string' &&
          documentId.length > 0 &&
          typeof documentVersion === 'string' &&
          documentVersion.length > 0
        ) {
          return [{ document_id: documentId, document_version: documentVersion }]
        }
        return []
      })
    : []
  return {
    citation_bindings: bindings,
    origins,
    document_dependencies: dependencies,
  }
}

export function normalizeNoteD2(raw: unknown): ResearchNoteD2 {
  const record = requireRecord(raw)
  const accessState = record.access_state
  if (
    accessState !== undefined &&
    accessState !== null &&
    accessState !== 'visible' &&
    accessState !== 'restricted'
  ) {
    throw noteProtocolError()
  }
  const citationMetadata = normalizeNoteCitationMetadata(record)
  return {
    note_id: requireString(record.note_id),
    project_id: typeof record.project_id === 'string' ? record.project_id : '',
    title: typeof record.title === 'string' ? record.title : '',
    content: typeof record.content === 'string' ? record.content : '',
    note_type: 'human',
    created_at: optionalNullableString(record.created_at),
    updated_at: optionalNullableString(record.updated_at),
    revision: optionalRevision(record.revision),
    snapshot_hash: optionalHash(record.snapshot_hash),
    edit_schema: optionalNullableString(record.edit_schema),
    access_state:
      accessState === 'restricted'
        ? 'restricted'
        : accessState === 'visible'
          ? 'visible'
          : null,
    ...citationMetadata,
  }
}

export function normalizeNotePage(raw: unknown): ResearchPage<ResearchNoteD2> {
  const record = requireRecord(raw)
  if (!Array.isArray(record.items)) throw noteProtocolError()
  const items = record.items.map(normalizeNoteD2)
  const nextCursor =
    record.next_cursor === null || record.next_cursor === undefined
      ? null
      : requireString(record.next_cursor)
  return { items, next_cursor: nextCursor }
}

export function normalizeNoteReceipt(raw: unknown): NoteReceipt {
  const record = requireRecord(raw)
  const appliedRevision = record.applied_revision
  if (
    typeof appliedRevision !== 'number' ||
    !Number.isInteger(appliedRevision) ||
    appliedRevision < 1 ||
    appliedRevision > 2147483647
  ) {
    throw noteProtocolError()
  }
  const snapshotHash = optionalHash(record.snapshot_hash)
  const replayed = record.replayed
  if (typeof replayed !== 'boolean') throw noteProtocolError()
  return {
    note_id: requireString(record.note_id),
    mutation_id: requireString(record.mutation_id),
    applied_revision: appliedRevision,
    snapshot_hash: snapshotHash,
    saved_at: requireString(record.saved_at),
    replayed,
  }
}

// ── 请求工具 ──

function noteHeaders(): Record<string, string> {
  return { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE }
}

function noteUrl(projectId: string, ...segments: string[]): string {
  const path =
    segments.length === 0
      ? ''
      : `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`
  return buildResearchUrl(projectId, path)
}

/** 新 mutation_id（契约 `^[A-Za-z0-9_-]{1,128}$`；每次新变更一个新 id）。 */
export function newNoteMutationId(): string {
  const cryptoObject =
    typeof globalThis === 'object' ? (globalThis as { crypto?: Crypto }).crypto : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `nm${cryptoObject.randomUUID().replace(/-/g, '')}`
  }
  return `nm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 128)
}

// ── 端点（全部经既有 apiClient；Bearer/baseURL 由拦截器统一注入） ──

/** 列表/词法搜索（d2-v1 投影；`q` 非空时服务端排除受限行）。 */
export async function listNotesD2(
  projectId: string,
  params: NoteD2ListParams = {},
  signal?: AbortSignal,
): Promise<ResearchPage<ResearchNoteD2>> {
  const response = await apiClient.get<unknown>(noteUrl(projectId, 'notes'), {
    params,
    headers: noteHeaders(),
    ...(signal ? { signal } : {}),
  })
  return normalizeNotePage(response.data)
}

/** 单条读取（受限 → 403 `note_access_restricted`；不存在/跨项目 → 404）。 */
export async function getNoteD2(
  projectId: string,
  noteId: string,
  signal?: AbortSignal,
): Promise<ResearchNoteD2> {
  const response = await apiClient.get<unknown>(noteUrl(projectId, 'notes', noteId), {
    headers: noteHeaders(),
    ...(signal ? { signal } : {}),
  })
  return normalizeNoteD2(response.data)
}

/** 新建受保护 Note（201 新建 / 200 幂等重放；缺省标题/正文由服务端补）。 */
export async function createNoteD2(
  projectId: string,
  body: NoteD2CreateRequest,
): Promise<NoteReceipt> {
  const response = await apiClient.post<unknown>(noteUrl(projectId, 'notes'), body, {
    headers: noteHeaders(),
  })
  return normalizeNoteReceipt(response.data)
}

/** 完整快照保存（revision CAS；409 冲突带已授权当前 revision/hash）。 */
export async function saveNoteD2(
  projectId: string,
  noteId: string,
  body: NoteD2SaveRequest,
): Promise<NoteReceipt> {
  const response = await apiClient.patch<unknown>(noteUrl(projectId, 'notes', noteId), body, {
    headers: noteHeaders(),
  })
  return normalizeNoteReceipt(response.data)
}

/** revision CAS 删除（回执 `snapshot_hash=null`）。 */
export async function deleteNoteD2(
  projectId: string,
  noteId: string,
  body: NoteD2DeleteRequest,
): Promise<NoteReceipt> {
  const response = await apiClient.delete<unknown>(noteUrl(projectId, 'notes', noteId), {
    data: body,
    headers: noteHeaders(),
  })
  return normalizeNoteReceipt(response.data)
}

/** 首次启用 d2-v1 保护（只加保护字段，不修剪/重写正文）。 */
export async function enableNoteEditingD2(
  projectId: string,
  noteId: string,
  body: NoteD2EnableEditingRequest,
): Promise<NoteD2EnableEditingResult> {
  const response = await apiClient.post<unknown>(
    noteUrl(projectId, 'notes', noteId, 'editing'),
    body,
    { headers: noteHeaders() },
  )
  const record = requireRecord(response.data)
  return {
    note: normalizeNoteD2(record.note),
    receipt: record.receipt === null || record.receipt === undefined
      ? null
      : normalizeNoteReceipt(record.receipt),
  }
}

/**
 * 受保护另存（copies）：以本地草稿基线 + 当前正文创建新 Note，继承服务端
 * 冻结的源保守依赖。源删除 404 / 受限 403 / 依赖不可判定 503（契约 §3.1）。
 */
export async function copyNoteD2(
  projectId: string,
  noteId: string,
  body: NoteD2CopyRequest,
): Promise<NoteReceipt> {
  const response = await apiClient.post<unknown>(
    noteUrl(projectId, 'notes', noteId, 'copies'),
    body,
    { headers: noteHeaders() },
  )
  return normalizeNoteReceipt(response.data)
}

/**
 * 片段插入到已有 Note（D2-B3，§5/§5.1）：绑定 expected_revision；服务端解析
 * 可信来源快照并在单事务写入正文/引用/出处/依赖 + 回执。来源不可读、选区
 * 失效、权限失败时不产生空壳/部分写入（错误码见契约 §8 与 host B3 增量）。
 */
export async function insertNoteFragmentD2(
  projectId: string,
  noteId: string,
  body: NoteD2FragmentInsertRequest,
): Promise<NoteReceipt> {
  const response = await apiClient.post<unknown>(
    noteUrl(projectId, 'notes', noteId, 'fragments'),
    body,
    { headers: noteHeaders() },
  )
  return normalizeNoteReceipt(response.data)
}

/**
 * 直接用可信片段新建 Note（§5.1〔R29〕）：与 fragments 共用来源描述/UTF-16
 * 范围/服务端解析器；失败不创建空壳文档；成功后同一 mutation_id 重放返回
 * 原回执（新 note_id 稳定）。
 */
export async function createNoteFragmentD2(
  projectId: string,
  body: NoteD2FragmentCreateRequest,
): Promise<NoteReceipt> {
  const response = await apiClient.post<unknown>(noteUrl(projectId, 'notes'), body, {
    headers: noteHeaders(),
  })
  return normalizeNoteReceipt(response.data)
}

// ── 可注入的 client 形状（状态机以接口依赖注入，便于单测） ──

export interface NoteApiClient {
  listNotes: typeof listNotesD2
  getNote: typeof getNoteD2
  createNote: typeof createNoteD2
  saveNote: typeof saveNoteD2
  deleteNote: typeof deleteNoteD2
  enableNoteEditing: typeof enableNoteEditingD2
  copyNote: typeof copyNoteD2
  insertFragment: typeof insertNoteFragmentD2
  createNoteFragment: typeof createNoteFragmentD2
}

/** 生产默认实现（纯转发，便于测试注入 fake）。 */
export const noteApiClient: NoteApiClient = {
  listNotes: listNotesD2,
  getNote: getNoteD2,
  createNote: createNoteD2,
  saveNote: saveNoteD2,
  deleteNote: deleteNoteD2,
  enableNoteEditing: enableNoteEditingD2,
  copyNote: copyNoteD2,
  insertFragment: insertNoteFragmentD2,
  createNoteFragment: createNoteFragmentD2,
}
