/**
 * Issue #1048 PR7（D2-B4）：写作意图编码与请求构造（纯函数层）。
 *
 * 与主仓 `src/rdlens/research/issue585/writing_contract.py` 的
 * `writing_intent_hash` / `validate_writing_request` /
 * `normalize_document_selection` 逐字段对齐：
 * - 意图对象为 **15 键闭合对象**，命名空间 `research-writing-v4/intent`；
 * - `writing_intent_hash` 与 Note revision、旧 schema1 哈希**完全独立**：
 *   文档选择只以 `document_context`（note_id/revision/snapshot_hash/selection）
 *   参与，composer 身份以 `editor_revision`/`editor_intent_hash`/`draft_token`
 *   参与；
 * - 编码复用 `canonical.ts`（d2-canonical-v1）的 `H([namespace, C(value)])`，
 *   不得自行拼接摘要文本。
 *
 * 本模块不读存储、不发请求；失败以闭合结果对象返回（不抛裸异常给 UI）。
 */

import { CanonicalEncodingError, hashValue } from './canonical'
import { utf8Bytes } from '@/lib/research/session-idempotency'
import type { ResearchSessionKind } from '@/lib/research/session-contract'
import {
  WRITING_ENVELOPE_MAX_UTF8_BYTES,
  WRITING_INTENT_NAMESPACE,
  WRITING_QUERY_MAX_UTF8_BYTES,
  WRITING_REQUEST_SCHEMA_VERSION,
  WRITING_WORK_PURPOSE,
  type WritingCapacitySummary,
  type WritingDocumentContext,
  type WritingHistoryMode,
  type WritingIntentFields,
  type WritingSelection,
  type WritingSubmissionRequest,
} from './writing-types'

const STABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_:-]{1,256}$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/
const DRAFT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const REVISION_MAX = 2 ** 31 - 1
const SAFE_INT_MAX = 9007199254740991

/** 校验/编码失败（稳定机器码；中文/英文文案由 UI 映射，不展示 message 原文）。 */
export type WritingIntentErrorCode =
  | 'invalid_document_context'
  | 'invalid_selection'
  | 'invalid_composer_identity'
  | 'invalid_intent_fields'
  | 'query_too_large'
  | 'encoding_failed'

export type WritingIntentBuildResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: WritingIntentErrorCode; readonly message: string }

const fail = <T>(
  code: WritingIntentErrorCode,
  message: string,
): WritingIntentBuildResult<T> => ({ ok: false, code, message })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInt(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

/** UTF-8 字节长度（浏览器/Node 一致；不依赖 TextEncoder 的环境差异）。 */
export function writingUtf8Bytes(text: string): number {
  return utf8Bytes(text).length
}

/** 选区形状校验并归一（`range` 必须 `0 <= start < end <= MAX_SAFE_INTEGER`）。 */
export function normalizeWritingSelection(
  value: unknown,
): WritingIntentBuildResult<WritingSelection> {
  if (!isRecord(value)) return fail('invalid_selection', 'selection must be an object')
  const kind = value.kind
  if (kind === 'full') {
    if (Object.keys(value).length !== 1) {
      return fail('invalid_selection', 'full selection has closed key set {"kind"}')
    }
    return { ok: true, value: { kind: 'full' } }
  }
  if (kind !== 'range') {
    return fail('invalid_selection', 'selection.kind must be full or range')
  }
  if (
    Object.keys(value).length !== 3 ||
    !('start_utf16' in value) ||
    !('end_utf16' in value)
  ) {
    return fail(
      'invalid_selection',
      'range selection has closed key set {"kind","start_utf16","end_utf16"}',
    )
  }
  const start = value.start_utf16
  const end = value.end_utf16
  if (!isSafeInt(start, 0, SAFE_INT_MAX) || !isSafeInt(end, 0, SAFE_INT_MAX)) {
    return fail('invalid_selection', 'range offsets must be non-negative safe integers')
  }
  if (start >= end) {
    return fail('invalid_selection', 'range selection must satisfy start_utf16 < end_utf16')
  }
  return { ok: true, value: { kind: 'range', start_utf16: start, end_utf16: end } }
}

/** 请求级 document_context 校验并归一（revision >= 1，snapshot_hash 为 hex64）。 */
export function normalizeWritingDocumentContext(
  value: unknown,
): WritingIntentBuildResult<WritingDocumentContext> {
  if (!isRecord(value)) {
    return fail('invalid_document_context', 'document_context must be an object')
  }
  const keys = Object.keys(value)
  const expected = ['note_id', 'revision', 'snapshot_hash', 'selection']
  if (
    keys.length !== expected.length ||
    !expected.every((key) => key in value)
  ) {
    return fail(
      'invalid_document_context',
      'document_context has closed key set {note_id, revision, snapshot_hash, selection}',
    )
  }
  if (typeof value.note_id !== 'string' || !STABLE_ID_PATTERN.test(value.note_id)) {
    return fail('invalid_document_context', 'document_context.note_id is invalid')
  }
  if (!isSafeInt(value.revision, 1, REVISION_MAX)) {
    return fail('invalid_document_context', 'document_context.revision must be >= 1')
  }
  if (
    typeof value.snapshot_hash !== 'string' ||
    !HEX64_PATTERN.test(value.snapshot_hash)
  ) {
    return fail('invalid_document_context', 'document_context.snapshot_hash must be hex64')
  }
  const selection = normalizeWritingSelection(value.selection)
  if (!selection.ok) return selection
  return {
    ok: true,
    value: {
      note_id: value.note_id,
      revision: value.revision,
      snapshot_hash: value.snapshot_hash,
      selection: selection.value,
    },
  }
}

/** 构建盲（归一化）的意图对象：只接受闭合 15 键，值域与主仓一致。 */
export function normalizeWritingIntentFields(
  fields: unknown,
): WritingIntentBuildResult<WritingIntentFields> {
  if (!isRecord(fields)) return fail('invalid_intent_fields', 'intent fields must be an object')
  const keys = [
    'schema_version',
    'project_id',
    'owner_user_id',
    'session_kind',
    'source_id',
    'session_id',
    'editor_revision',
    'editor_intent_hash',
    'draft_token',
    'query',
    'model_id',
    'response_language',
    'work_purpose',
    'document_context',
    'history_mode',
  ] as const
  if (
    Object.keys(fields).length !== keys.length ||
    !keys.every((key) => key in fields)
  ) {
    return fail('invalid_intent_fields', 'intent fields must be a closed 15-key object')
  }
  if (fields.schema_version !== 1) {
    return fail('invalid_intent_fields', 'intent.schema_version must be 1')
  }
  if (
    typeof fields.project_id !== 'string' ||
    !PROJECT_ID_PATTERN.test(fields.project_id)
  ) {
    return fail('invalid_intent_fields', 'intent.project_id is invalid')
  }
  if (!isSafeInt(fields.owner_user_id, 1, Number.MAX_SAFE_INTEGER)) {
    return fail('invalid_intent_fields', 'intent.owner_user_id must be a positive integer')
  }
  const sessionKind = fields.session_kind
  if (sessionKind !== 'global' && sessionKind !== 'source') {
    return fail('invalid_intent_fields', 'intent.session_kind must be global or source')
  }
  let sourceId: string | null = null
  if (sessionKind === 'source') {
    if (typeof fields.source_id !== 'string' || !SOURCE_ID_PATTERN.test(fields.source_id)) {
      return fail('invalid_intent_fields', 'source session requires a valid source_id')
    }
    sourceId = fields.source_id
  } else if (fields.source_id !== null) {
    return fail('invalid_intent_fields', 'global session must not carry source_id')
  }
  if (typeof fields.session_id !== 'string' || !STABLE_ID_PATTERN.test(fields.session_id)) {
    return fail('invalid_intent_fields', 'intent.session_id is invalid')
  }
  if (!isSafeInt(fields.editor_revision, 0, REVISION_MAX)) {
    return fail('invalid_intent_fields', 'intent.editor_revision is invalid')
  }
  if (
    typeof fields.editor_intent_hash !== 'string' ||
    !HEX64_PATTERN.test(fields.editor_intent_hash)
  ) {
    return fail('invalid_intent_fields', 'intent.editor_intent_hash must be hex64')
  }
  if (
    typeof fields.draft_token !== 'string' ||
    !DRAFT_TOKEN_PATTERN.test(fields.draft_token)
  ) {
    return fail('invalid_intent_fields', 'intent.draft_token is invalid')
  }
  if (typeof fields.query !== 'string') {
    return fail('invalid_intent_fields', 'intent.query must be a string')
  }
  if (typeof fields.model_id !== 'string' || fields.model_id.length === 0) {
    return fail('invalid_intent_fields', 'intent.model_id must be a non-empty string')
  }
  const responseLanguage = fields.response_language
  if (responseLanguage !== null && typeof responseLanguage !== 'string') {
    return fail('invalid_intent_fields', 'intent.response_language must be string or null')
  }
  if (fields.work_purpose !== WRITING_WORK_PURPOSE) {
    return fail('invalid_intent_fields', 'intent.work_purpose must be writing')
  }
  const documentContext = normalizeWritingDocumentContext(fields.document_context)
  if (!documentContext.ok) {
    return fail('invalid_intent_fields', documentContext.message)
  }
  const historyMode = fields.history_mode
  if (historyMode !== 'none' && historyMode !== 'current') {
    return fail('invalid_intent_fields', 'intent.history_mode must be none or current')
  }
  return {
    ok: true,
    value: {
      schema_version: 1,
      project_id: fields.project_id,
      owner_user_id: fields.owner_user_id,
      session_kind: sessionKind,
      source_id: sourceId,
      session_id: fields.session_id,
      editor_revision: fields.editor_revision,
      editor_intent_hash: fields.editor_intent_hash,
      draft_token: fields.draft_token,
      query: fields.query,
      model_id: fields.model_id,
      response_language: responseLanguage,
      work_purpose: WRITING_WORK_PURPOSE,
      document_context: documentContext.value,
      history_mode: historyMode,
    },
  }
}

/**
 * `writing_intent_hash = H(["research-writing-v4/intent", C(15 键意图对象)])`。
 *
 * 独立于 Note revision 与旧 schema1 哈希；服务端重算同值并核对。Note revision
 * 只在 `document_context` 中出现。
 */
export function writingIntentHash(
  fields: WritingIntentFields | unknown,
): WritingIntentBuildResult<string> {
  const normalized = normalizeWritingIntentFields(fields)
  if (!normalized.ok) return normalized
  try {
    return {
      ok: true,
      value: hashValue(WRITING_INTENT_NAMESPACE, normalized.value),
    }
  } catch (error) {
    if (error instanceof CanonicalEncodingError) {
      return fail('encoding_failed', 'writing intent cannot be canonically encoded')
    }
    return fail('encoding_failed', 'writing intent hashing failed')
  }
}

/** 构造请求的输入（composer 身份来自已 ACK 的服务端保存）。 */
export interface BuildWritingRequestInput {
  readonly projectId: string
  readonly ownerUserId: number
  readonly sessionKind: ResearchSessionKind
  readonly sourceId: string | null
  readonly sessionId: string
  /** 已保存 composer 的 revision（ACK 后读取，不是 Note revision）。 */
  readonly editorRevision: number
  /** 已保存 composer 的 editor_intent_hash（hex64）。 */
  readonly editorIntentHash: string
  /** 已保存 composer 的 draft_token。 */
  readonly draftToken: string
  readonly query: string
  readonly modelId: string
  readonly responseLanguage: string | null
  readonly documentContext: WritingDocumentContext
  readonly historyMode: WritingHistoryMode
}

export interface BuiltWritingRequest {
  readonly request: WritingSubmissionRequest
  readonly intentHash: string
}

/**
 * 构造闭合 11 键请求体并计算 `writing_intent_hash`。
 *
 * 注意：调用方必须在**已等到 composer 保存 ACK** 之后读取
 * `editorRevision/editorIntentHash/draftToken`；本函数不会回退读取 Note
 * revision 或旧 schema1 哈希。
 */
export function buildWritingSubmissionRequest(
  input: BuildWritingRequestInput,
): WritingIntentBuildResult<BuiltWritingRequest> {
  const queryBytes = writingUtf8Bytes(input.query)
  if (queryBytes > WRITING_QUERY_MAX_UTF8_BYTES) {
    return fail('query_too_large', 'query exceeds the 128 KiB writing limit')
  }
  const intentFields: WritingIntentFields = {
    schema_version: 1,
    project_id: input.projectId,
    owner_user_id: input.ownerUserId,
    session_kind: input.sessionKind,
    source_id: input.sourceId,
    session_id: input.sessionId,
    editor_revision: input.editorRevision,
    editor_intent_hash: input.editorIntentHash,
    draft_token: input.draftToken,
    query: input.query,
    model_id: input.modelId,
    response_language: input.responseLanguage,
    work_purpose: WRITING_WORK_PURPOSE,
    document_context: input.documentContext,
    history_mode: input.historyMode,
  }
  const normalizedIntent = normalizeWritingIntentFields(intentFields)
  if (!normalizedIntent.ok) return normalizedIntent
  const intentHash = writingIntentHash(normalizedIntent.value)
  if (!intentHash.ok) return intentHash
  const documentContext = normalizeWritingDocumentContext(normalizedIntent.value.document_context)
  if (!documentContext.ok) return documentContext
  return {
    ok: true,
    value: {
      intentHash: intentHash.value,
      request: {
        schema_version: WRITING_REQUEST_SCHEMA_VERSION,
        editor_revision: normalizedIntent.value.editor_revision,
        draft_token: normalizedIntent.value.draft_token,
        editor_intent_hash: normalizedIntent.value.editor_intent_hash,
        writing_intent_hash: intentHash.value,
        query: normalizedIntent.value.query,
        model: normalizedIntent.value.model_id,
        response_language: normalizedIntent.value.response_language,
        work_purpose: WRITING_WORK_PURPOSE,
        document_context: documentContext.value,
        history_mode: normalizedIntent.value.history_mode,
      },
    },
  }
}

/** 输入选择确认的容量摘要（UI 只做提示；服务端 422 仍是权威）。 */
export function measureWritingCapacity(input: {
  readonly selectedText: string
  readonly query: string
}): WritingCapacitySummary {
  const selectedTextBytes = writingUtf8Bytes(input.selectedText)
  const queryBytes = writingUtf8Bytes(input.query)
  const overLimitParts: ('document_context' | 'query')[] = []
  if (selectedTextBytes > WRITING_ENVELOPE_MAX_UTF8_BYTES) overLimitParts.push('document_context')
  if (queryBytes > WRITING_QUERY_MAX_UTF8_BYTES) overLimitParts.push('query')
  return {
    selectedTextChars: input.selectedText.length,
    selectedTextBytes,
    queryChars: input.query.length,
    queryBytes,
    envelopeLimitBytes: WRITING_ENVELOPE_MAX_UTF8_BYTES,
    queryLimitBytes: WRITING_QUERY_MAX_UTF8_BYTES,
    overLimit: overLimitParts.length > 0,
    overLimitParts,
  }
}

/** 从编辑器全文与 UTF-16 选区取出实际选中文字（不做 trim/归一化）。 */
export function selectedWritingText(
  content: string,
  selection: WritingSelection,
): string {
  if (selection.kind === 'full') return content
  const start = Math.max(0, Math.min(selection.start_utf16, content.length))
  const end = Math.max(start, Math.min(selection.end_utf16, content.length))
  return content.slice(start, end)
}

/** 选区描述符（缓存/恢复时校验形状；不接受越界区间）。 */
export function isValidWritingSelection(value: unknown): value is WritingSelection {
  return normalizeWritingSelection(value).ok
}
