/**
 * Issue #1048 PR7（D2-B4）：写作传输适配层。
 *
 * 权威依据：
 * - 方案 v4 §6.1（两个写作入口、请求 11 键）、§6.3（读投影）、§8.2（能力）；
 * - 机器契约 `writing_input_v4.request.paths` /
 *   `writing_input_v4.read_projection` / `errors` 节；
 * - #602 会话提交的既有两步传输（202 受理回执 → `Last-Event-ID: 0` attach
 *   SSE），本层只做**写作变体适配**，鉴权/重连/去重语义全部复用
 *   `api.ts::openResearchChatStream`。
 *
 * 传输细节集中在本文件（后端 wire 最终确认时只需改这里）：
 * - POST `.../chat/sessions/{session_id}/writing`（source 变体同构）；
 * - body 为闭合 11 键 writing request；会话身份在路径中；
 * - 头：`X-Research-Session-Contract: research-session-v1`、
 *   `X-Research-Contract: c05-v1`(global)/`v1`(source)、`Idempotency-Key`；
 * - 失败不抛裸异常，统一归一为 `WritingApiError`（不含正文/堆栈）。
 */

import { apiClient } from '@/lib/api/client'
import {
  buildResearchUrl,
  createChatSession,
  getEditorState,
  getResearchChatSession,
  openResearchWritingStream,
  type ResearchGlobalChatSessionDetail,
  type ResearchSessionAcceptReceipt,
} from '../api'
import {
  parseEditorResponse,
  parseSessionRef,
  type ResearchSessionRef,
} from '@/lib/research/session-contract'
import { getNoteD2 } from './note-client'
import { normalizeNoteApiError } from './note-client'
import type { ResearchSseEvent } from '@/lib/research/types'
import {
  type WritingAccessState,
  type WritingApiError,
  type WritingChecks,
  type WritingContextAdoptedTurn,
  type WritingContextCapacity,
  type WritingContextDocumentContext,
  type WritingContextExcludedTurn,
  type WritingContextIntegrity,
  type WritingContextProjection,
  type WritingErrorCode,
  type WritingHistoryMode,
  type WritingNoteVerification,
  type WritingSessionCreateResult,
  type WritingSelection,
  type WritingSubmissionRequest,
} from './writing-types'

// ── 稳定错误码 ──

const WRITING_ERROR_CODES: ReadonlySet<string> = new Set<WritingErrorCode>([
  'writing_not_available',
  'writing_context_changed',
  'writing_input_unavailable',
  'context_limit_exceeded',
  'submission_intent_conflict',
  'session_contract_unsupported',
  'session_busy',
  'invalid_request',
  'conflict',
  'access_denied',
  'session_not_found',
  'chat_owner_required',
  'generation_failed',
  'invalid_response',
  'network_error',
  'unknown_error',
])

const HISTORY_EXCLUDED_REASONS = new Set<string>([
  'history_scope_excluded',
  'history_budget_excluded',
  'history_authority_excluded',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSafeCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  )
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function hasClosedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => key in value)
}

function isWritingApiError(value: unknown): value is WritingApiError {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    WRITING_ERROR_CODES.has(value.code) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean' &&
    typeof value.status === 'number'
  )
}

function readErrorDetail(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error)) return null
  const response = isRecord(error.response) ? error.response : null
  if (response === null) return null
  const data = response.data
  if (!isRecord(data)) return null
  return isRecord(data.detail) ? data.detail : null
}

function readHttpStatus(error: unknown): number {
  if (!isRecord(error)) return 0
  const response = isRecord(error.response) ? error.response : null
  const status = response?.status
  return typeof status === 'number' ? status : 0
}

function readRequestId(error: unknown, detail: Record<string, unknown> | null): string | undefined {
  if (detail !== null && isNonEmptyString(detail.request_id)) return detail.request_id
  if (!isRecord(error)) return undefined
  const response = isRecord(error.response) ? error.response : null
  const headers = response?.headers
  if (!isRecord(headers)) return undefined
  const value = headers['x-request-id']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 状态码兜底推断（仅当服务端未给可识别 detail.code 时）。
 *
 * 不得把 422 一律当容量超限、409 一律当 context changed（review MEDIUM-6）：
 * - 422 → 通用 `invalid_request`（容量语义只由显式 `context_limit_exceeded`）；
 * - 409 → 通用 `conflict`（可重试性保留 detail 的 retryable/状态推断）；
 * - 403 → 通用 `access_denied`（不冒充 owner 会话语义）；
 * - 426 → `session_contract_unsupported`（host 的契约头拒绝状态）。
 */
function inferCodeFromStatus(status: number): WritingErrorCode | null {
  if (status === 0) return 'network_error'
  if (status === 403) return 'access_denied'
  if (status === 404) return 'session_not_found'
  if (status === 409) return 'conflict'
  if (status === 422) return 'invalid_request'
  if (status === 426) return 'session_contract_unsupported'
  if (status === 503) return 'writing_input_unavailable'
  return null
}

function isTransportRetryableStatus(status: number): boolean {
  return status === 0 || status >= 500
}

/**
 * 归一化写作 API 错误（axios/网络/畸形响应）。
 *
 * 只保留稳定码与 request_id；服务端 detail.message 不直接渲染给用户。
 */
export function normalizeWritingApiError(error: unknown): WritingApiError {
  if (isWritingApiError(error)) return error
  const status = readHttpStatus(error)
  const detail = readErrorDetail(error)
  const rawCode = detail !== null && typeof detail.code === 'string' ? detail.code : null
  const code: WritingErrorCode =
    rawCode !== null && WRITING_ERROR_CODES.has(rawCode)
      ? (rawCode as WritingErrorCode)
      : (inferCodeFromStatus(status) ?? 'unknown_error')
  const retryable =
    detail !== null && typeof detail.retryable === 'boolean'
      ? detail.retryable
      : isTransportRetryableStatus(status)
  const requestId = readRequestId(error, detail)
  return {
    code,
    message: detail !== null && typeof detail.message === 'string' ? detail.message : '',
    retryable,
    status,
    ...(requestId !== undefined ? { requestId } : {}),
  }
}

/** 构造 HTTP 状态错误（非 axios 路径的兜底；保持稳定码形状）。 */
export function writingApiError(
  code: WritingErrorCode,
  input: { status?: number; retryable?: boolean; message?: string } = {},
): WritingApiError {
  const status = input.status ?? 0
  return {
    code,
    message: input.message ?? '',
    retryable: input.retryable ?? (status === 0 || status >= 500),
    status,
  }
}

function invalidResponseError(): WritingApiError {
  return writingApiError('invalid_response', { status: 200, retryable: true })
}

/**
 * 从传输层回调的 `(status, body)` 归一化写作 API 错误（共享给编排 hook）。
 *
 * 只接受已知稳定码；未知码按状态兜底（422→invalid_request、409→conflict、
 * 403→access_denied、426→session_contract_unsupported），**不**把容量/上下文
 * 变化文案套到所有同状态错误上；服务端 `retryable` 原样保留。
 */
export function normalizeWritingHttpFailure(
  status: number,
  body: unknown,
): WritingApiError {
  const detail =
    isRecord(body) && isRecord(body.detail) ? body.detail : null
  const rawCode = detail !== null && typeof detail.code === 'string' ? detail.code : null
  const known = rawCode !== null && WRITING_ERROR_CODES.has(rawCode)
  const code: WritingErrorCode = known
    ? (rawCode as WritingErrorCode)
    : (inferCodeFromStatus(status) ?? 'unknown_error')
  const retryable =
    detail !== null && typeof detail.retryable === 'boolean'
      ? detail.retryable
      : isTransportRetryableStatus(status)
  return {
    code,
    message: detail !== null && typeof detail.message === 'string' ? detail.message : '',
    retryable,
    status,
  }
}

// ── 会话创建（客户端预生成 session_id；同 id 重试） ──

export interface CreateWritingSessionInput {
  readonly projectId: string
  readonly sessionId: string
  readonly kind: 'global' | 'source'
  readonly sourceId?: string | null
}

const CREATE_RESPONSE_KEYS = [
  'session_ref',
  'editor_revision',
  'editor_state',
  'state_warnings',
  'created',
  'editor_intent_hash',
] as const

function parseWritingSessionCreateResponse(
  raw: unknown,
  expected: CreateWritingSessionInput,
): WritingSessionCreateResult {
  if (!isRecord(raw) || !hasClosedKeys(raw, CREATE_RESPONSE_KEYS)) {
    return { ok: false, error: invalidResponseError() }
  }
  const refResult = parseSessionRef(raw.session_ref)
  if (!refResult.ok) return { ok: false, error: invalidResponseError() }
  const ref = refResult.value
  if (
    ref.kind !== expected.kind ||
    ref.projectId !== expected.projectId ||
    ref.sessionId !== expected.sessionId ||
    (expected.kind === 'source'
      ? ref.sourceId !== (expected.sourceId ?? null)
      : ref.sourceId !== null)
  ) {
    return { ok: false, error: invalidResponseError() }
  }
  if (
    typeof raw.created !== 'boolean' ||
    !isSafeCount(raw.editor_revision) ||
    !Array.isArray(raw.state_warnings) ||
    !raw.state_warnings.every((entry) => typeof entry === 'string' && entry.length > 0) ||
    !(raw.editor_intent_hash === null || isHex64(raw.editor_intent_hash))
  ) {
    return { ok: false, error: invalidResponseError() }
  }
  return { ok: true, ref, created: raw.created }
}

/**
 * 创建写作目标会话（复用 #602 `POST .../chat/sessions`）。
 *
 * 客户端预生成 `session_id`；网络失败/结果未知时调用方必须用**同一 id**
 * 重试（服务端 201/`created=true` 或 200/`created=false` 均视为同一会话），
 * 禁止重复创建新会话。
 */
export async function createWritingSession(
  input: CreateWritingSessionInput,
): Promise<WritingSessionCreateResult> {
  try {
    const raw = await createChatSession(input.projectId, {
      kind: input.kind,
      sourceId: input.sourceId ?? null,
      sessionId: input.sessionId,
    })
    return parseWritingSessionCreateResponse(raw, input)
  } catch (error) {
    return { ok: false, error: normalizeWritingApiError(error) }
  }
}

// ── 写作提交（两步传输经由 api.openResearchWritingStream） ──

export interface WritingSubmitCallbacks {
  readonly onEvent: (event: ResearchSseEvent) => void
  /** 首步 202 受理回执（已通过身份匹配；只记录/关联 generation_id）。 */
  readonly onAcceptReceipt?: (receipt: ResearchSessionAcceptReceipt) => void
  readonly onHttpError?: (status: number, body: unknown) => void
  readonly onNetworkError?: (error: Error) => void
  readonly onProtocolError?: (reason: string) => void
  readonly onIdleTimeout?: (phase: 'response' | 'idle') => void
  readonly onEnd?: () => void
}

export interface SubmitWritingInput extends WritingSubmitCallbacks {
  readonly projectId: string
  readonly sessionRef: ResearchSessionRef
  /** 冻结的写作请求（11 键；调用方已等到 composer ACK 后才构造）。 */
  readonly request: WritingSubmissionRequest
  /** 同一次写作尝试的重试/attach 必须复用同一幂等键。 */
  readonly idempotencyKey: string
  readonly lastEventId?: number
}

/** 打开写作提交 SSE 流；返回中止函数（仅断开本地读取，不等于取消执行）。 */
export function submitWritingSubmission(
  input: SubmitWritingInput,
): (reason?: 'user_cancel' | 'identity' | 'page_change' | 'terminal_reached') => void {
  const {
    projectId,
    sessionRef,
    request,
    idempotencyKey,
    lastEventId,
    ...callbacks
  } = input
  return openResearchWritingStream({
    protocol: 'research-writing-v1',
    projectId,
    sessionRef,
    request,
    idempotencyKey,
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...callbacks,
  })
}

// ── GET /writing-contexts/{generation_id}（实际输入回看） ──

export type WritingContextResult =
  | { readonly ok: true; readonly projection: WritingContextProjection }
  | { readonly ok: false; readonly error: WritingApiError }

const CONTEXT_KEYS = [
  'generation_id',
  'input_id',
  'input_schema_version',
  'input_hash',
  'document_context',
  'history',
  'integrity',
  'capacity',
  'writing_checks',
  'access_state',
] as const

function parseSelectionKind(value: unknown): 'full' | 'range' | null {
  return value === 'full' || value === 'range' ? value : null
}

function parseDocumentContext(value: unknown): WritingContextDocumentContext | null {
  if (!isRecord(value)) return null
  const selectionKind = parseSelectionKind(value.selection_kind)
  if (selectionKind === null) return null
  if (
    typeof value.note_id !== 'string' ||
    !isSafeCount(value.revision) ||
    value.revision < 1 ||
    !isHex64(value.snapshot_hash) ||
    !isHex64(value.selected_text_hash) ||
    !(value.selected_text === null || typeof value.selected_text === 'string')
  ) {
    return null
  }
  const start = value.start_utf16
  const end = value.end_utf16
  if (selectionKind === 'full') {
    if (start !== null || end !== null) return null
  } else if (!isSafeCount(start) || !isSafeCount(end) || start! >= end!) {
    return null
  }
  return {
    note_id: value.note_id,
    revision: value.revision,
    snapshot_hash: value.snapshot_hash,
    selection_kind: selectionKind,
    start_utf16: typeof start === 'number' ? start : null,
    end_utf16: typeof end === 'number' ? end : null,
    selected_text: typeof value.selected_text === 'string' ? value.selected_text : null,
    selected_text_hash: value.selected_text_hash,
  }
}

function parseAdoptedTurn(value: unknown): WritingContextAdoptedTurn | null {
  if (!isRecord(value)) return null
  if (
    typeof value.message_id !== 'string' ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    !(value.text === null || typeof value.text === 'string') ||
    !isHex64(value.text_hash)
  ) {
    return null
  }
  return {
    message_id: value.message_id,
    role: value.role,
    text: typeof value.text === 'string' ? value.text : null,
    text_hash: value.text_hash,
  }
}

function parseExcludedTurn(value: unknown): WritingContextExcludedTurn | null {
  if (!isRecord(value)) return null
  if (
    typeof value.message_id !== 'string' ||
    typeof value.reason !== 'string' ||
    !HISTORY_EXCLUDED_REASONS.has(value.reason)
  ) {
    return null
  }
  return {
    message_id: value.message_id,
    reason: value.reason as WritingContextExcludedTurn['reason'],
  }
}

function parseHistoryMode(value: unknown): WritingHistoryMode | null {
  return value === 'none' || value === 'current' ? value : null
}

function parseCapacity(value: unknown): WritingContextCapacity | null {
  if (!isRecord(value)) return null
  if (
    !isSafeCount(value.input_utf8_bytes) ||
    !isSafeCount(value.envelope_utf8_bytes) ||
    !isSafeCount(value.limit_utf8_bytes) ||
    value.limit_utf8_bytes < 1
  ) {
    return null
  }
  return {
    input_utf8_bytes: value.input_utf8_bytes,
    envelope_utf8_bytes: value.envelope_utf8_bytes,
    limit_utf8_bytes: value.limit_utf8_bytes,
  }
}

function parseIntegrity(value: unknown): WritingContextIntegrity | null {
  if (!isRecord(value)) return null
  if (
    !isHex64(value.document_context_hash) ||
    !isHex64(value.history_hash) ||
    !isHex64(value.envelope_hash)
  ) {
    return null
  }
  return {
    document_context_hash: value.document_context_hash,
    history_hash: value.history_hash,
    envelope_hash: value.envelope_hash,
  }
}

function parseWritingChecks(value: unknown): WritingChecks | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (
    value.version !== 1 ||
    !Array.isArray(value.missing_binding_ids) ||
    !value.missing_binding_ids.every((entry) => typeof entry === 'string') ||
    !(value.unavailable_reason === null || typeof value.unavailable_reason === 'string')
  ) {
    return undefined
  }
  return {
    version: 1,
    missing_binding_ids: value.missing_binding_ids as string[],
    unavailable_reason: typeof value.unavailable_reason === 'string' ? value.unavailable_reason : null,
  }
}

/**
 * 严格解析读投影（契约 `read_projection` 10 键闭合）。
 *
 * 受限时只允许 `selected_text`/adopted `text` 为 null（只显示受限状态），
 * 不把冻结正文当作可展示内容。
 */
export function parseWritingContextProjection(raw: unknown): WritingContextResult {
  if (!isRecord(raw) || !hasClosedKeys(raw, CONTEXT_KEYS)) {
    return { ok: false, error: invalidResponseError() }
  }
  const accessState = raw.access_state
  if (accessState !== 'visible' && accessState !== 'restricted') {
    return { ok: false, error: invalidResponseError() }
  }
  const documentContext = parseDocumentContext(raw.document_context)
  const integrity = parseIntegrity(raw.integrity)
  const capacity = parseCapacity(raw.capacity)
  const checks = parseWritingChecks(raw.writing_checks)
  if (
    documentContext === null ||
    integrity === null ||
    capacity === null ||
    checks === undefined ||
    !isNonEmptyString(raw.generation_id) ||
    !isNonEmptyString(raw.input_id) ||
    !isSafeCount(raw.input_schema_version) ||
    !isHex64(raw.input_hash)
  ) {
    return { ok: false, error: invalidResponseError() }
  }
  const history = raw.history
  if (!isRecord(history) || !hasClosedKeys(history, ['mode', 'adopted', 'excluded'])) {
    return { ok: false, error: invalidResponseError() }
  }
  const mode = parseHistoryMode(history.mode)
  if (mode === null || !Array.isArray(history.adopted) || !Array.isArray(history.excluded)) {
    return { ok: false, error: invalidResponseError() }
  }
  const adopted: WritingContextAdoptedTurn[] = []
  for (const entry of history.adopted) {
    const turn = parseAdoptedTurn(entry)
    if (turn === null) return { ok: false, error: invalidResponseError() }
    adopted.push(turn)
  }
  const excluded: WritingContextExcludedTurn[] = []
  for (const entry of history.excluded) {
    const turn = parseExcludedTurn(entry)
    if (turn === null) return { ok: false, error: invalidResponseError() }
    excluded.push(turn)
  }
  // 受限投影不得携带冻结正文（服务端契约要求；客户端 fail-closed）。
  const restricted: WritingAccessState = accessState
  if (
    restricted === 'restricted' &&
    (documentContext.selected_text !== null ||
      adopted.some((turn) => turn.text !== null))
  ) {
    return { ok: false, error: invalidResponseError() }
  }
  return {
    ok: true,
    projection: {
      generation_id: raw.generation_id,
      input_id: raw.input_id,
      input_schema_version: raw.input_schema_version,
      input_hash: raw.input_hash,
      document_context: documentContext,
      history: { mode, adopted, excluded },
      integrity,
      capacity,
      writing_checks: checks,
      access_state: restricted,
    },
  }
}

/**
 * `GET /v1/research/projects/{project_id}/writing-contexts/{generation_id}`。
 *
 * 验证所属项目/调用者权限由服务端负责；受限时只返回受限状态。
 */
export async function getWritingContext(
  projectId: string,
  generationId: string,
): Promise<WritingContextResult> {
  if (!isNonEmptyString(projectId) || !isNonEmptyString(generationId)) {
    return { ok: false, error: writingApiError('unknown_error', { status: 0 }) }
  }
  try {
    const response = await apiClient.get<unknown>(
      buildResearchUrl(projectId, `/writing-contexts/${encodeURIComponent(generationId)}`),
    )
    return parseWritingContextProjection(response.data)
  } catch (error) {
    return { ok: false, error: normalizeWritingApiError(error) }
  }
}

// ── 结果消息定位（手工摘入需要耐久 message_id） ──

export type WritingResultMessageResult =
  | {
      readonly ok: true
      readonly messageId: string
      readonly content: string
      readonly userMessageId: string | null
    }
  | { readonly ok: false; readonly reason: 'no_generation' | 'not_found' | 'content_mismatch' }

/**
 * 由 generation_id 生成 headed chat 投递的耐久 message_id。
 *
 * host 投递路径对同一次执行使用确定性 id（`chat/delivery.py`：
 * `msg_{generation_id}_assistant` / `msg_{generation_id}_user`），因此写作结果
 * 可以按 generation 精确定位，不按正文/序号猜测（review MEDIUM-7）。
 */
export function writingResultMessageId(generationId: string): string {
  return `msg_${generationId}_assistant`
}

/** 写作请求对应的耐久 user message id（同源确定性规则）。 */
export function writingResultUserMessageId(generationId: string): string {
  return `msg_${generationId}_user`
}

/**
 * 从会话详情按 generation_id 精确定位写作结果消息（手工摘入用）。
 *
 * - 候选取自确定性 `msg_{generationId}_assistant`；正文必须与已发布正文完全
 *   相等（内容不一致 → 明确失败，不回退按正文搜索）；
 * - 同正文重复出现的其它轮次不影响定位（按 generation，而不是按文本/序号）；
 * - generation_id 缺失 → `no_generation`（调用方显示不可摘入原因）。
 */
export function resolveWritingResultMessage(
  detail: ResearchGlobalChatSessionDetail,
  expectedContent: string,
  generationId: string | null,
): WritingResultMessageResult {
  if (generationId === null || generationId.length === 0) {
    return { ok: false, reason: 'no_generation' }
  }
  if (expectedContent.length === 0) return { ok: false, reason: 'content_mismatch' }
  const messageId = writingResultMessageId(generationId)
  const match = detail.messages.find((message) => message.message_id === messageId)
  if (match === undefined) return { ok: false, reason: 'not_found' }
  if (match.role !== 'assistant' || match.content !== expectedContent) {
    return { ok: false, reason: 'content_mismatch' }
  }
  const userMessageId = writingResultUserMessageId(generationId)
  const hasUser = detail.messages.some((message) => message.message_id === userMessageId)
  return {
    ok: true,
    messageId,
    content: match.content,
    userMessageId: hasUser ? userMessageId : null,
  }
}

/** 拉取会话详情并按 generation 定位写作结果（手工摘入前调用）。 */
export async function locateWritingResultMessage(
  projectId: string,
  sessionId: string,
  generationId: string | null,
  expectedContent: string,
): Promise<WritingResultMessageResult> {
  if (generationId === null) return { ok: false, reason: 'no_generation' }
  try {
    const detail = await getResearchChatSession(projectId, sessionId, { order: 'desc', limit: 50 })
    return resolveWritingResultMessage(detail, expectedContent, generationId)
  } catch {
    return { ok: false, reason: 'not_found' }
  }
}

// ── 服务端 owner 身份 / Note 权限重查（方案 §6.1.2；review LOW-3/MEDIUM-3） ──

/**
 * 解析契约 `owner_user_id`：优先现有会话 editor-state 服务端返回的
 * `viewer_user_id`（正整数），不依赖宿主 `claims.sub` 必须是数字串。
 *
 * 返回 null = 服务端未能确认；调用方显示可见 `owner_unknown`，不伪造身份。
 */
export async function resolveWritingOwnerUserId(
  projectId: string,
  sessionRef: ResearchSessionRef,
): Promise<number | null> {
  try {
    const raw = await getEditorState(projectId, {
      kind: sessionRef.kind,
      sessionId: sessionRef.sessionId,
      sourceId: sessionRef.kind === 'source' ? (sessionRef.sourceId ?? null) : null,
    })
    const parsed = parseEditorResponse(raw)
    if (!parsed.ok) return null
    const value = parsed.value.viewerUserId
    return Number.isSafeInteger(value) && value >= 1 ? value : null
  } catch {
    return null
  }
}

/**
 * 恢复未发送选择前重新读取 Note（权限 + 版本），方案 §6.1.2。
 *
 * 只把服务端当前 `access_state=visible` 且 revision/snapshot_hash 可读的
 * 结果当作可恢复依据；受限/不存在/暂不可判定均如实返回，不把 unknown
 * 当作 visible。
 */
export async function verifyWritingNote(
  projectId: string,
  noteId: string,
): Promise<WritingNoteVerification> {
  try {
    const note = await getNoteD2(projectId, noteId)
    if (note.access_state === 'restricted') {
      return { ok: false, reason: 'restricted' }
    }
    if (note.revision === null || note.snapshot_hash === null) {
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: true, revision: note.revision, snapshotHash: note.snapshot_hash }
  } catch (error) {
    const normalized = normalizeNoteApiError(error)
    if (
      normalized.code === 'note_access_restricted' ||
      normalized.status === 403
    ) {
      return { ok: false, reason: 'restricted' }
    }
    if (normalized.code === 'note_not_found' || normalized.status === 404) {
      return { ok: false, reason: 'not_found' }
    }
    return { ok: false, reason: 'unavailable' }
  }
}

// ── 语言 / owner 身份 ──

/** UI 语言 → 契约 response_language（'zh' | 'en'；未知 → 'en'）。 */
export function writingResponseLanguage(language: string | null | undefined): 'zh' | 'en' {
  return typeof language === 'string' && language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** viewer 身份（claims.sub 字符串）→ 契约 owner_user_id（正整数）。 */
export function writingOwnerUserId(viewerUserId: string | null | undefined): number | null {
  if (typeof viewerUserId !== 'string' || !/^[0-9]+$/.test(viewerUserId)) return null
  const value = Number(viewerUserId)
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

// ── 选择/投影的小工具（纯函数；UI 复用） ──

/** 选区 → 展示用范围文本（`[start, end)` 或 full）。 */
export function describeWritingSelection(selection: WritingSelection): string {
  return selection.kind === 'full'
    ? 'full'
    : `[${selection.start_utf16}, ${selection.end_utf16})`
}
