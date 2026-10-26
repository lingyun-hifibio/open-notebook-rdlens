/**
 * 研究会话本机缓存（RDLens #602 第三批 PR-1）。
 *
 * 规范来源：DESIGN §3.5、02_INTERFACE_FREEZE §6、PR-1 卡「session-cache」。
 *
 * 设计要点：
 * - 键前缀 `rdlens.research.session.v1`，逐段编码且**单射**：
 *   `encodeURIComponent(v).replace(/\./g, '%2E')`，否则 `a.b` 项目会串读；
 * - 分区键：`.candidate.<project>`、`.global.<viewer>.<project>`、
 *   `.source.<viewer>.<project>.<source>`、`.display.<viewer>.<project>`、
 *   `.draft.<viewer>.<project>.<kind>.<source-or-empty>.<session>.<writerId>`、
 *   `.submission.<viewer>.<project>.<kind>.<source-or-empty>.<session>.<draftToken>`、
 *   `.active-submission.<viewer>.<project>.<kind>.<source-or-empty>.<session>`；
 * - 读取条件：已认证 viewer + 项目匹配 + 当前 `authGeneration` 有效；
 *   locked/旧代不得读 viewer-keyed 指针/草稿/标记（candidate pointer 例外）；
 * - 禁止落盘：Bearer token、assistant 正文、受限内容、其他会话历史；
 *   提交标记只保留协议头白名单（Authorization/Cookie 永不落盘）；
 * - 写入失败（quota/隐私模式）退回内存并标记 `degraded`，不丢文本；
 * - 草稿按 writer 分支：每个 document 实例随机 writerId，ACK 只清本分支
 *   且本地版本对应的记录；旧分支作恢复候选，不自动删除。
 */

import { SESSION_CONTRACT_VERSION } from './session-contract'
import type { ResearchAcceptanceState, ResearchSessionRef } from './session-contract'
import { buildSubmissionKey, canonicalJson, type CanonicalJsonValue } from './session-idempotency'

/** 缓存键前缀（02 §6）。 */
export const SESSION_CACHE_PREFIX = 'rdlens.research.session.v1' as const

/** 草稿记录版本。 */
export const SESSION_DRAFT_VERSION = 1 as const

/** 提交标记版本。 */
export const SESSION_SUBMISSION_MARKER_VERSION = 1 as const

/** 未结算标记预算（DESIGN §3.5 建议 20）。 */
export const SESSION_SUBMISSION_MARKER_BUDGET = 20 as const

/**
 * 提交标记允许持久化的请求头白名单（02 §6 / DESIGN §3.5）。
 * `Authorization`、`Cookie` 等任何认证凭据永不落盘。
 */
export const SESSION_PERSISTABLE_HEADERS = [
  'X-Research-Session-Contract',
  'X-Research-Contract',
  'Idempotency-Key',
] as const

/** 最小 Storage 形状（便于测试注入 quota/隐私失败实现）。 */
export interface SessionCacheStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 写入降级原因。 */
export type SessionCacheWriteReason = 'quota' | 'security' | 'unavailable' | null

export interface SessionCacheWriteResult {
  readonly ok: boolean
  /** false 表示只写进内存（本机缓存不可用，UI 需提示但不丢文本）。 */
  readonly persisted: boolean
  readonly degraded: boolean
  readonly reason: SessionCacheWriteReason
}

/** viewer 分区作用域（写入键的组成部分）。 */
export interface SessionCacheScope {
  readonly viewerUserId: string
  readonly projectId: string
}

/**
 * 读取授权：只有已认证、项目匹配且代际为当前代际时才允许读 viewer 分区。
 * `authGeneration=0` 表示尚未认证（locked），不得读任何 viewer 数据。
 */
export interface SessionCacheAuthority {
  readonly authenticatedViewerUserId: string | null
  readonly projectId: string | null
  readonly authGeneration: number
  readonly currentAuthGeneration: number
}

/** 会话指针（global/source 各一份，互不覆盖）。 */
export interface SessionPointerRecord {
  readonly version: 1
  readonly ref: ResearchSessionRef
  readonly savedAt: string
}

/** 显示模型指针（本机显示状态；不是 wire 扩展，允许 null ref）。 */
export type SessionDisplayPointer =
  | { readonly version: 1; readonly surface: 'global'; readonly ref: ResearchSessionRef | null }
  | {
      readonly version: 1
      readonly surface: 'source'
      readonly sourceId: string
      readonly ref: ResearchSessionRef | null
    }

/** 候选指针：viewer 确认前唯一允许读取的指针元数据（不含正文/草稿）。 */
export interface SessionCandidatePointer {
  readonly version: 1
  readonly ref: ResearchSessionRef
  readonly savedAt: string
}

/** 草稿记录（DESIGN §3.5 必需字段）。 */
export interface SessionDraftRecord {
  readonly version: typeof SESSION_DRAFT_VERSION
  readonly text: string
  readonly token: string
  readonly baseScope: {
    readonly mode: 'all' | 'selected'
    readonly sourceIds: readonly string[]
    readonly singleSourceId: null
  } | null
  readonly singleSourceId: string | null
  readonly noteIds: readonly string[]
  readonly localVersion: number
  readonly baseRevision: number
  readonly savedAt: string
  readonly dirty: boolean
}

/** 草稿分支（同一会话可有多 writerId）。 */
export interface SessionDraftBranch {
  readonly writerId: string
  readonly record: SessionDraftRecord
}

/** 经契约校验的原始 wire 请求快照（提交标记恢复用）。 */
export interface SessionSubmissionRequestSnapshot {
  readonly method: 'POST'
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

/** 提交标记（按 draft_token 分条；active-submission 单独指针）。 */
export interface SessionSubmissionMarker {
  readonly version: typeof SESSION_SUBMISSION_MARKER_VERSION
  readonly draftToken: string
  readonly idempotencyKey: string
  readonly acceptanceState: ResearchAcceptanceState
  /** `exactRequestAvailable=false` 时不得用该快照重建请求（只允许 lookup）。 */
  readonly request: SessionSubmissionRequestSnapshot | null
  readonly exactRequestAvailable: boolean
  readonly generationId: string | null
  readonly observedRevision: number | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly terminalAt: string | null
}

interface CacheOptions {
  readonly storage?: SessionCacheStorage | null
}

interface CacheEntry {
  readonly storage: SessionCacheStorage | null
  readonly fallback: Map<string, string>
}

/** localStorage 不可用时的进程内兜底（按完整键记录，不跨标签）。 */
const memoryFallback = new Map<string, string>()

/**
 * 删除持久值失败时的墓碑：后续读取返回 null，防止旧的持久值“复活”
 * （review F8：T2 降级覆盖后删除失败，不得再读回 T1）。
 */
const removedKeys = new Set<string>()

/**
 * 解析默认 Storage：只在浏览器且 `localStorage` 可访问时返回；
 * SSR / 隐私模式抛错时返回 null（调用方退回内存）。
 */
export function resolveSessionCacheStorage(): SessionCacheStorage | null {
  if (typeof window === 'undefined') return null
  try {
    const storage = window.localStorage
    if (!storage) return null
    // 触发一次读取以暴露 SecurityError（隐私模式）
    storage.getItem(SESSION_CACHE_PREFIX)
    return storage
  } catch {
    return null
  }
}

function entryFor(options?: CacheOptions): CacheEntry {
  if (options && 'storage' in options) {
    return { storage: options.storage ?? null, fallback: memoryFallback }
  }
  return { storage: resolveSessionCacheStorage(), fallback: memoryFallback }
}

function classifyStorageError(error: unknown): SessionCacheWriteReason {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name?: unknown }).name) : ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota'
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'security'
  return 'unavailable'
}

function readRaw(entry: CacheEntry, key: string): { value: string | null; reason: SessionCacheWriteReason } {
  // 删除失败的墓碑优先：旧持久值不得复活。
  if (removedKeys.has(key)) return { value: null, reason: null }
  // 内存兜底代表“本进程最近一次成功写入”（持久化失败时的降级副本），
  // 必须优先于可能已过期的持久值返回（DESIGN §3.5 durable 不是权威）。
  const fallbackValue = entry.fallback.get(key)
  if (fallbackValue !== undefined) return { value: fallbackValue, reason: null }
  if (!entry.storage) return { value: null, reason: null }
  try {
    return { value: entry.storage.getItem(key), reason: null }
  } catch (error) {
    return { value: null, reason: classifyStorageError(error) }
  }
}

function writeRaw(
  entry: CacheEntry,
  key: string,
  value: string,
): { persisted: boolean; reason: SessionCacheWriteReason } {
  removedKeys.delete(key)
  if (entry.storage) {
    try {
      entry.storage.setItem(key, value)
      entry.fallback.delete(key)
      return { persisted: true, reason: null }
    } catch (error) {
      entry.fallback.set(key, value)
      return { persisted: false, reason: classifyStorageError(error) }
    }
  }
  entry.fallback.set(key, value)
  return { persisted: false, reason: 'unavailable' }
}

function removeRaw(entry: CacheEntry, key: string): void {
  entry.fallback.delete(key)
  if (!entry.storage) {
    removedKeys.add(key)
    return
  }
  try {
    entry.storage.removeItem(key)
  } catch {
    // 删除失败不阻断清理流程，但必须留墓碑：内存兜底已删除、旧持久值
    // 不得在后续读取中复活（review F8）。
    removedKeys.add(key)
  }
}

function writeResult(outcome: { persisted: boolean; reason: SessionCacheWriteReason }): SessionCacheWriteResult {
  return {
    ok: true,
    persisted: outcome.persisted,
    degraded: !outcome.persisted,
    reason: outcome.reason,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/**
 * 单段编码：`encodeURIComponent` 之外还要转义 `.`，保证键分段单射。
 * 由于 `%` 本身会被编码为 `%25`，字面量 `%2E` 与转义点不会碰撞。
 */
export function sessionCacheSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E')
}

function buildKey(segments: readonly string[]): string {
  return [SESSION_CACHE_PREFIX, ...segments.map(sessionCacheSegment)].join('.')
}

/** 可见性授权：已认证 viewer + 项目匹配 + 代际为当前代际（且非 0）。 */
export function isViewerScopedCacheReadable(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
): boolean {
  return (
    authority.authGeneration > 0 &&
    authority.authGeneration === authority.currentAuthGeneration &&
    authority.authenticatedViewerUserId !== null &&
    authority.authenticatedViewerUserId === scope.viewerUserId &&
    authority.projectId !== null &&
    authority.projectId === scope.projectId
  )
}

// ---------------------------------------------------------------------------
// candidate pointer（viewer 确认前唯一允许读取的指针）
// ---------------------------------------------------------------------------

export function readCandidatePointer(
  projectId: string,
  options?: CacheOptions,
): SessionCandidatePointer | null {
  const entry = entryFor(options)
  const raw = parseJson(readRaw(entry, buildKey(['candidate', projectId])).value)
  if (!isRecord(raw) || raw.version !== 1) return null
  return normalizePointer(raw, (ref) => ref.kind === 'global' || ref.kind === 'source')
}

export function writeCandidatePointer(
  projectId: string,
  ref: ResearchSessionRef,
  savedAt: string,
  options?: CacheOptions,
): SessionCacheWriteResult {
  const key = buildKey(['candidate', projectId])
  const payload: SessionCandidatePointer = { version: 1, ref, savedAt }
  return writeResult(writeRaw(entryFor(options), key, JSON.stringify(payload)))
}

// ---------------------------------------------------------------------------
// global/source/display 指针
// ---------------------------------------------------------------------------

function pointerKey(
  scope: SessionCacheScope,
  surface: 'global' | 'source',
  sourceId?: string,
): string {
  const base = [surface, scope.viewerUserId, scope.projectId]
  if (surface === 'source') {
    if (!sourceId) throw new Error('source pointer requires sourceId')
    base.push(sourceId)
  }
  return buildKey(base)
}

function displayKey(scope: SessionCacheScope): string {
  return buildKey(['display', scope.viewerUserId, scope.projectId])
}

function isSessionRefShape(value: unknown): value is ResearchSessionRef {
  if (!isRecord(value)) return false
  if (value.domain !== 'research') return false
  if (value.kind !== 'global' && value.kind !== 'source') return false
  if (typeof value.projectId !== 'string' || value.projectId.length === 0) return false
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return false
  const sourceId = value.sourceId
  if (value.kind === 'global') return sourceId === null
  return typeof sourceId === 'string' && sourceId.length > 0
}

function normalizePointer(
  raw: Record<string, unknown>,
  accept: (ref: ResearchSessionRef) => boolean,
): SessionPointerRecord | null {
  if (!isSessionRefShape(raw.ref)) return null
  if (!accept(raw.ref)) return null
  return {
    version: 1,
    ref: raw.ref,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
  }
}

/** 读 surface 指针；越权/旧代/未认证一律返回 null（不抛错）。 */
export function readPointer(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  surface: 'global' | 'source',
  sourceId: string | null,
  options?: CacheOptions,
): SessionPointerRecord | null {
  if (!isViewerScopedCacheReadable(scope, authority)) return null
  let key: string
  try {
    key = pointerKey(scope, surface, sourceId ?? undefined)
  } catch {
    return null
  }
  const raw = parseJson(readRaw(entryFor(options), key).value)
  if (!isRecord(raw) || raw.version !== 1) return null
  return normalizePointer(
    raw,
    (ref) => ref.kind === surface && ref.projectId === scope.projectId && (surface === 'global' ? ref.sourceId === null : ref.sourceId === sourceId),
  )
}

/**
 * 读「最近保存的 source 指针」：刷新恢复时 source surface 需要独立于 display
 * 指针从自己的键恢复（DESIGN §4.5），但本机不知道当前 source，只能按键前缀
 * 取最近写入的一条。越权/旧代/未认证一律返回 null。
 */
export function readLatestSourcePointer(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  options?: CacheOptions,
): SessionPointerRecord | null {
  if (!isViewerScopedCacheReadable(scope, authority)) return null
  const entry = entryFor(options)
  const prefix = `${buildKey(['source', scope.viewerUserId, scope.projectId])}.`
  let latest: SessionPointerRecord | null = null
  for (const key of listStorageKeys(entry, prefix)) {
    const raw = parseJson(readRaw(entry, key).value)
    if (!isRecord(raw) || raw.version !== 1) continue
    const pointer = normalizePointer(
      raw,
      (ref) => ref.kind === 'source' && ref.projectId === scope.projectId && ref.sourceId !== null,
    )
    if (pointer === null) continue
    if (latest === null || pointer.savedAt > latest.savedAt) latest = pointer
  }
  return latest
}

/** 写 surface 指针；`ref=null` 表示清除该 surface 指针。 */
export function writePointer(
  scope: SessionCacheScope,
  surface: 'global' | 'source',
  sourceId: string | null,
  ref: ResearchSessionRef | null,
  savedAt: string,
  options?: CacheOptions,
): SessionCacheWriteResult {
  let key: string
  try {
    key = pointerKey(scope, surface, sourceId ?? undefined)
  } catch {
    return { ok: false, persisted: false, degraded: true, reason: 'unavailable' }
  }
  const entry = entryFor(options)
  if (ref === null) {
    removeRaw(entry, key)
    return { ok: true, persisted: true, degraded: false, reason: null }
  }
  const payload: SessionPointerRecord = { version: 1, ref, savedAt }
  return writeResult(writeRaw(entry, key, JSON.stringify(payload)))
}

export function readDisplayPointer(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  options?: CacheOptions,
): SessionDisplayPointer | null {
  if (!isViewerScopedCacheReadable(scope, authority)) return null
  const raw = parseJson(readRaw(entryFor(options), displayKey(scope)).value)
  if (!isRecord(raw) || raw.version !== 1) return null
  if (raw.surface !== 'global' && raw.surface !== 'source') return null
  if (raw.surface === 'global') {
    return {
      version: 1,
      surface: 'global',
      ref: isSessionRefShape(raw.ref) && raw.ref.kind === 'global' ? raw.ref : null,
    }
  }
  if (typeof raw.sourceId !== 'string' || raw.sourceId.length === 0) return null
  const ref = isSessionRefShape(raw.ref) && raw.ref.kind === 'source' ? raw.ref : null
  return { version: 1, surface: 'source', sourceId: raw.sourceId, ref }
}

export function writeDisplayPointer(
  scope: SessionCacheScope,
  display: SessionDisplayPointer,
  options?: CacheOptions,
): SessionCacheWriteResult {
  return writeResult(writeRaw(entryFor(options), displayKey(scope), JSON.stringify(display)))
}

// ---------------------------------------------------------------------------
// 草稿 writer 分支
// ---------------------------------------------------------------------------

function draftPrefix(scope: SessionCacheScope, ref: ResearchSessionRef): string {
  return buildKey([
    'draft',
    scope.viewerUserId,
    scope.projectId,
    ref.kind,
    ref.sourceId ?? '',
    ref.sessionId,
  ])
}

function draftKey(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  writerId: string,
): string {
  return `${draftPrefix(scope, ref)}.${sessionCacheSegment(writerId)}`
}

function isDraftRecord(value: unknown): value is SessionDraftRecord {
  if (!isRecord(value) || value.version !== SESSION_DRAFT_VERSION) return false
  if (typeof value.text !== 'string' || typeof value.token !== 'string') return false
  if (typeof value.localVersion !== 'number' || !Number.isInteger(value.localVersion) || value.localVersion < 0) return false
  if (typeof value.baseRevision !== 'number' || !Number.isInteger(value.baseRevision) || value.baseRevision < 0) return false
  if (typeof value.savedAt !== 'string' || typeof value.dirty !== 'boolean') return false
  if (value.singleSourceId !== null && typeof value.singleSourceId !== 'string') return false
  if (!Array.isArray(value.noteIds) || !value.noteIds.every((entry) => typeof entry === 'string')) return false
  if (value.baseScope !== null) {
    if (!isRecord(value.baseScope)) return false
    const mode = value.baseScope.mode
    if (mode !== 'all' && mode !== 'selected') return false
    if (!Array.isArray(value.baseScope.sourceIds) || !value.baseScope.sourceIds.every((entry) => typeof entry === 'string')) {
      return false
    }
    if (value.baseScope.singleSourceId !== null) return false
  }
  return true
}

export function writeDraft(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  writerId: string,
  record: SessionDraftRecord,
  options?: CacheOptions,
): SessionCacheWriteResult {
  if (writerId.length === 0) return { ok: false, persisted: false, degraded: true, reason: 'unavailable' }
  return writeResult(writeRaw(entryFor(options), draftKey(scope, ref, writerId), JSON.stringify(record)))
}

export function readDraft(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  ref: ResearchSessionRef,
  writerId: string,
  options?: CacheOptions,
): SessionDraftRecord | null {
  if (!isViewerScopedCacheReadable(scope, authority)) return null
  if (writerId.length === 0) return null
  const raw = parseJson(readRaw(entryFor(options), draftKey(scope, ref, writerId)).value)
  return isDraftRecord(raw) ? raw : null
}

/** 列出同一会话的全部 writer 分支（旧分支作恢复候选，不自动删除）。 */
export function listDraftBranches(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  ref: ResearchSessionRef,
  options?: CacheOptions,
): readonly SessionDraftBranch[] {
  if (!isViewerScopedCacheReadable(scope, authority)) return []
  const entry = entryFor(options)
  const prefix = `${draftPrefix(scope, ref)}.`
  const branches: SessionDraftBranch[] = []
  for (const key of listStorageKeys(entry, prefix)) {
    const writerSegment = key.slice(prefix.length)
    const writerId = decodeURIComponent(writerSegment)
    const raw = parseJson(readRaw(entry, key).value)
    if (!isDraftRecord(raw)) continue
    branches.push({ writerId, record: raw })
  }
  return branches.sort((left, right) => (left.record.savedAt < right.record.savedAt ? -1 : left.record.savedAt > right.record.savedAt ? 1 : 0))
}

/** 删除指定 writer 分支（用于显式放弃/清理，不用于 ACK）。 */
export function removeDraft(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  writerId: string,
  options?: CacheOptions,
): boolean {
  if (writerId.length === 0) return false
  const entry = entryFor(options)
  const key = draftKey(scope, ref, writerId)
  if (readRaw(entry, key).value === null) return false
  removeRaw(entry, key)
  return true
}

/**
 * ACK 后按“本 writer + 本地版本 + token”条件删除草稿分支：
 * 只清已完成且版本对应的分支；旧分支/其他 writer 保留。
 */
export function removeDraftIfVersion(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  writerId: string,
  expected: { readonly localVersion: number; readonly token: string },
  options?: CacheOptions,
): boolean {
  if (writerId.length === 0) return false
  const entry = entryFor(options)
  const key = draftKey(scope, ref, writerId)
  const raw = parseJson(readRaw(entry, key).value)
  if (!isDraftRecord(raw)) return false
  if (raw.localVersion !== expected.localVersion || raw.token !== expected.token) return false
  removeRaw(entry, key)
  return true
}

// ---------------------------------------------------------------------------
// 提交标记 / active-submission
// ---------------------------------------------------------------------------

function submissionPrefix(scope: SessionCacheScope, ref: ResearchSessionRef): string {
  return buildKey([
    'submission',
    scope.viewerUserId,
    scope.projectId,
    ref.kind,
    ref.sourceId ?? '',
    ref.sessionId,
  ])
}

function submissionKey(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  draftToken: string,
): string {
  return `${submissionPrefix(scope, ref)}.${sessionCacheSegment(draftToken)}`
}

function activeSubmissionKey(scope: SessionCacheScope, ref: ResearchSessionRef): string {
  return buildKey([
    'active-submission',
    scope.viewerUserId,
    scope.projectId,
    ref.kind,
    ref.sourceId ?? '',
    ref.sessionId,
  ])
}

/**
 * 规整请求头白名单：只保留两个协议头与幂等键；Authorization/Cookie
 * 等认证凭据永远不进入本机缓存。
 */
export function persistableSubmissionHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  const allowed = new Set(SESSION_PERSISTABLE_HEADERS)
  for (const [name, value] of Object.entries(headers)) {
    const match = SESSION_PERSISTABLE_HEADERS.find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    if (match && allowed.has(match) && typeof value === 'string') {
      result[match] = value
    }
  }
  return result
}

/**
 * 写入提交标记；超过未结算预算时拒绝新增（调用方停止新增执行并提供逐项
 * 查回/放弃入口，不得静默丢标记）。
 */
export function writeSubmissionMarker(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  marker: SessionSubmissionMarker,
  options?: CacheOptions,
): SessionCacheWriteResult {
  const sanitized = sanitizeSubmissionMarker(marker, ref, scope)
  if (sanitized === null) {
    return { ok: false, persisted: false, degraded: true, reason: null }
  }
  const markerToWrite = sanitized
  const entry = entryFor(options)
  const key = submissionKey(scope, ref, marker.draftToken)
  const existing = readRaw(entry, key).value
  if (existing === null) {
    const markers = listStorageKeys(entry, `${submissionPrefix(scope, ref)}.`)
    let unsettled = 0
    for (const candidate of markers) {
      const raw = parseJson(readRaw(entry, candidate).value)
      if (!isRecord(raw)) continue
      if (raw.acceptanceState !== 'terminal') unsettled += 1
    }
    if (unsettled >= SESSION_SUBMISSION_MARKER_BUDGET) {
      return { ok: false, persisted: false, degraded: true, reason: null }
    }
  }
  return writeResult(writeRaw(entry, key, JSON.stringify(markerToWrite)))
}

/**
 * 持久化边界校验：请求头只保留白名单（Authorization/Cookie 永不落盘），
 * body 必须是可 JSON 往返的普通对象；`exactRequestAvailable` 不得脱离
 * 完整快照成立。不满足时拒绝写入而非静默截断。
 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 执行端点校验（DESIGN §6.2）：提交请求不是查回端点——
 * global 为 `/v1/research/projects/{project}/chat`，
 * source 为 `/v1/research/projects/{project}/sources/{source_id}/chat`。
 * 允许原始或百分号编码的段；不得余留查询串/额外段。
 */
function expectedSubmissionPaths(ref: ResearchSessionRef): string[] {
  const projects = [ref.projectId, encodeURIComponent(ref.projectId)]
  if (ref.kind === 'global') {
    return projects.map((project) => `/v1/research/projects/${project}/chat`)
  }
  const sourceId = ref.sourceId
  if (!sourceId) return []
  const sources = [sourceId, encodeURIComponent(sourceId)]
  const paths: string[] = []
  for (const project of projects) {
    for (const source of sources) {
      paths.push(`/v1/research/projects/${project}/sources/${source}/chat`)
    }
  }
  return paths
}

function pathMatchesSessionRef(path: string, ref: ResearchSessionRef): boolean {
  return expectedSubmissionPaths(ref).includes(path)
}

/** 请求体必须是无损可 JSON 往返的普通对象（不接受 undefined/NaN/Map 等）。 */
function isLosslessJsonBody(value: unknown): value is Record<string, unknown> {
  if (!isPlainJsonObject(value)) return false
  let serialized: string
  try {
    serialized = canonicalJson(value as CanonicalJsonValue)
  } catch {
    return false
  }
  try {
    const roundTrip: unknown = JSON.parse(serialized)
    return JSON.stringify(roundTrip) === serialized
  } catch {
    return false
  }
}

const SUBMISSION_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const SUBMISSION_HASH_PATTERN = /^[a-f0-9]{64}$/
const CONTEXT_LEVELS = new Set(['focused', 'document', 'workspace'])
const RESPONSE_LANGUAGES = new Set(['zh', 'en'])
const SCOPE_MODES = new Set(['all', 'selected', 'single'])
const SUBMISSION_BASE_KEYS = new Set([
  'session_id',
  'editor_revision',
  'draft_token',
  'editor_intent_hash',
  'query',
  'model_id',
  'context_level',
  'response_language',
])
const GLOBAL_ONLY_KEYS = new Set(['source_scope', 'note_ids'])

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function isStringArray(value: unknown, maxItems: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false
  const seen = new Set<string>()
  for (const item of value) {
    if (!isBoundedString(item, 1, 256)) return false
    if (seen.has(item)) return false
    seen.add(item)
  }
  return true
}

/** §5.3 执行范围：mode 与 source_ids/single_source_id 的互斥约束。 */
function isExecutionContextScope(value: unknown): boolean {
  if (!isPlainJsonObject(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => !['mode', 'source_ids', 'single_source_id'].includes(key))) return false
  if (typeof value.mode !== 'string' || !SCOPE_MODES.has(value.mode)) return false
  if (!isStringArray(value.source_ids, 1000)) return false
  const single = value.single_source_id
  if (single !== null && !isBoundedString(single, 1, 256)) return false
  if (value.mode === 'all') return value.source_ids.length === 0 && single === null
  if (value.mode === 'single') return value.source_ids.length === 0 && isBoundedString(single, 1, 256)
  return single === null
}

function allowedSubmissionKeys(kind: ResearchSessionRef['kind']): Set<string> {
  return kind === 'global'
    ? new Set([...SUBMISSION_BASE_KEYS, ...GLOBAL_ONLY_KEYS])
    : new Set(SUBMISSION_BASE_KEYS)
}

/**
 * 按第一批冻结 schema 校验原始请求体：必填字段、类型/长度/枚举、kind 专属
 * 字段与 unknown 字段全部核对（additionalProperties:false）；保留
 * response_language 的省略/null 语义，不做规范化。
 */
function isCompleteSubmissionBody(
  body: Readonly<Record<string, unknown>>,
  marker: SessionSubmissionMarker,
  ref: ResearchSessionRef,
): boolean {
  const allowed = allowedSubmissionKeys(ref.kind)
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return false
  }
  if (!isBoundedString(body.session_id, 1, 128) || !SUBMISSION_SESSION_ID_PATTERN.test(body.session_id)) {
    return false
  }
  if (body.session_id !== ref.sessionId) return false
  if (body.draft_token !== marker.draftToken) return false
  if (!isBoundedString(body.draft_token, 1, 128) || !SUBMISSION_SESSION_ID_PATTERN.test(body.draft_token)) {
    return false
  }
  if (
    typeof body.editor_revision !== 'number' ||
    !Number.isInteger(body.editor_revision) ||
    body.editor_revision < 0 ||
    body.editor_revision > 2147483647
  ) {
    return false
  }
  if (!isBoundedString(body.editor_intent_hash, 64, 64) || !SUBMISSION_HASH_PATTERN.test(body.editor_intent_hash)) {
    return false
  }
  if (!isBoundedString(body.query, 1, Number.MAX_SAFE_INTEGER)) return false
  if (!isBoundedString(body.model_id, 1, 256)) return false
  if (typeof body.context_level !== 'string' || !CONTEXT_LEVELS.has(body.context_level)) return false
  if (
    'response_language' in body &&
    body.response_language !== null &&
    (typeof body.response_language !== 'string' || !RESPONSE_LANGUAGES.has(body.response_language))
  ) {
    return false
  }
  if (ref.kind === 'global') {
    if (!isExecutionContextScope(body.source_scope)) return false
    if (!isStringArray(body.note_ids, 1000)) return false
  }
  return true
}

function isPersistableOwnerUserId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value)
}

/**
 * 幂等键必须与 scope/ref/token 一致（DESIGN §6.2）：键里编码 project、
 * owner、kind、source、session、draft_token；不能只信请求头字符串。
 * owner 非安全正整数时无法建立稳定提交身份 → 拒绝完整快照。
 */
function expectedSubmissionKey(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  draftToken: string,
): string | null {
  if (!isPersistableOwnerUserId(scope.viewerUserId)) return null
  const ownerUserId = Number(scope.viewerUserId)
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) return null
  try {
    return buildSubmissionKey({
      projectId: ref.projectId,
      ownerUserId,
      kind: ref.kind,
      sourceId: ref.sourceId,
      sessionId: ref.sessionId,
      draftToken,
    })
  } catch {
    return null
  }
}

/** 协议头必须是该 kind 的冻结组合，且幂等键头与标记键一致。 */
function submissionHeadersMatch(
  headers: Readonly<Record<string, string>>,
  marker: SessionSubmissionMarker,
  ref: ResearchSessionRef,
): boolean {
  const contract = ref.kind === 'global' ? 'c05-v1' : 'v1'
  return (
    headers['X-Research-Session-Contract'] === SESSION_CONTRACT_VERSION &&
    headers['X-Research-Contract'] === contract &&
    headers['Idempotency-Key'] === marker.idempotencyKey
  )
}

/**
 * 持久化边界校验（review F10/R1/R2）：请求必须可无损重放——
 * 方法/执行端点/token/幂等身份/协议头/完整 wire body 均与 ref 一致，
 * body 无损 JSON，头只留白名单。不满足时拒绝写入，而不是静默截断或
 * 保留 `exactRequestAvailable:true`。
 */
function sanitizeSubmissionMarker(
  marker: SessionSubmissionMarker,
  ref: ResearchSessionRef,
  scope: SessionCacheScope,
): SessionSubmissionMarker | null {
  if (marker.request === null) {
    return marker.exactRequestAvailable ? null : marker
  }
  if (!marker.exactRequestAvailable) return null
  const expectedKey = expectedSubmissionKey(scope, ref, marker.draftToken)
  if (expectedKey === null || marker.idempotencyKey !== expectedKey) return null
  const request = marker.request
  if (request.method !== 'POST') return null
  if (typeof request.path !== 'string' || !pathMatchesSessionRef(request.path, ref)) return null
  if (!isLosslessJsonBody(request.body)) return null
  if (!isCompleteSubmissionBody(request.body, marker, ref)) return null
  const headers = persistableSubmissionHeaders(request.headers)
  if (!submissionHeadersMatch(headers, marker, ref)) return null
  return {
    ...marker,
    request: {
      method: 'POST',
      path: request.path,
      headers,
      body: request.body,
    },
  }
}

export function readSubmissionMarker(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  ref: ResearchSessionRef,
  draftToken: string,
  options?: CacheOptions,
): SessionSubmissionMarker | null {
  if (!isViewerScopedCacheReadable(scope, authority)) return null
  const raw = parseJson(readRaw(entryFor(options), submissionKey(scope, ref, draftToken)).value)
  return isSubmissionMarker(raw) ? raw : null
}

function isSubmissionMarker(value: unknown): value is SessionSubmissionMarker {
  if (!isRecord(value) || value.version !== SESSION_SUBMISSION_MARKER_VERSION) return false
  if (typeof value.draftToken !== 'string' || typeof value.idempotencyKey !== 'string') return false
  if (typeof value.acceptanceState !== 'string') return false
  if (typeof value.exactRequestAvailable !== 'boolean') return false
  if (value.request !== null) {
    if (!isRecord(value.request)) return false
    if (value.request.method !== 'POST' || typeof value.request.path !== 'string') return false
    if (!isRecord(value.request.headers)) return false
    const headers = stringRecord(value.request.headers)
    if (!headers) return false
    const persisted = persistableSubmissionHeaders(headers)
    if (Object.keys(persisted).length !== Object.keys(headers).length) return false
  }
  return true
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null
    result[key] = entry
  }
  return result
}

/** 写入 active-submission 指针（开流前）。 */
export function writeActiveSubmission(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  draftToken: string,
  options?: CacheOptions,
): SessionCacheWriteResult {
  return writeResult(
    writeRaw(entryFor(options), activeSubmissionKey(scope, ref), JSON.stringify({ version: 1, draftToken })),
  )
}

export function readActiveSubmission(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  ref: ResearchSessionRef,
  options?: CacheOptions,
): string | null {
  if (!isViewerScopedCacheReadable(scope, authority)) return null
  const raw = parseJson(readRaw(entryFor(options), activeSubmissionKey(scope, ref)).value)
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.draftToken !== 'string') return null
  return raw.draftToken
}

export function clearActiveSubmission(
  scope: SessionCacheScope,
  ref: ResearchSessionRef,
  options?: CacheOptions,
): void {
  removeRaw(entryFor(options), activeSubmissionKey(scope, ref))
}

/** 列出该会话全部提交标记（查回顺序：active token → 当前 editor token → 其余）。 */
export function listSubmissionMarkers(
  scope: SessionCacheScope,
  authority: SessionCacheAuthority,
  ref: ResearchSessionRef,
  options?: CacheOptions,
): readonly SessionSubmissionMarker[] {
  if (!isViewerScopedCacheReadable(scope, authority)) return []
  const entry = entryFor(options)
  const prefix = `${submissionPrefix(scope, ref)}.`
  const markers: SessionSubmissionMarker[] = []
  for (const key of listStorageKeys(entry, prefix)) {
    const raw = parseJson(readRaw(entry, key).value)
    if (isSubmissionMarker(raw)) markers.push(raw)
  }
  return markers
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

function listStorageKeys(entry: CacheEntry, prefix: string): string[] {
  const keys = new Set<string>()
  for (const key of entry.fallback.keys()) {
    if (key.startsWith(prefix)) keys.add(key)
  }
  if (entry.storage) {
    try {
      const total = entry.storage.length
      for (let index = 0; index < total; index += 1) {
        const key = entry.storage.key(index)
        if (key !== null && key.startsWith(prefix)) keys.add(key)
      }
    } catch {
      // 列出失败时只依赖内存兜底
    }
  }
  return [...keys]
}

/** `purgeViewer` 的保留决策（审计/测试用）。 */
export interface PurgeViewerDecision {
  readonly key: string
  readonly action: 'removed' | 'retained'
  readonly reason: 'other-viewer' | 'kept-viewer' | 'candidate-pointer'
}

export interface PurgeViewerResult {
  readonly removed: number
  readonly retainedViewerUserId: string
  readonly decisions: readonly PurgeViewerDecision[]
}

/**
 * 清除除已确认当前 viewer 之外的一切 viewer 分区（DESIGN §3.5）。
 * candidate pointer 不含 viewer/正文，保留。
 */
export function purgeViewer(
  keepViewerUserId: string,
  options?: CacheOptions,
): PurgeViewerResult {
  const entry = entryFor(options)
  const decisions: PurgeViewerDecision[] = []
  let removed = 0
  for (const key of listStorageKeys(entry, `${SESSION_CACHE_PREFIX}.`)) {
    const segments = key.slice(SESSION_CACHE_PREFIX.length + 1).split('.')
    const partition = segments[0]
    if (partition === 'candidate') {
      decisions.push({ key, action: 'retained', reason: 'candidate-pointer' })
      continue
    }
    const viewer = segments[1]
    if (viewer === sessionCacheSegment(keepViewerUserId)) {
      decisions.push({ key, action: 'retained', reason: 'kept-viewer' })
      continue
    }
    decisions.push({ key, action: 'removed', reason: 'other-viewer' })
    removeRaw(entry, key)
    removed += 1
  }
  return { removed, retainedViewerUserId: keepViewerUserId, decisions }
}

/**
 * 清除指定 viewer + 项目的全部分区（登出/destroy 语义，DESIGN §3.5）。
 * 项目内其他 viewer 的分区不受影响。
 */
export function purgeViewerScope(
  scope: SessionCacheScope,
  options?: CacheOptions,
): number {
  const entry = entryFor(options)
  let removed = 0
  for (const key of listStorageKeys(entry, `${SESSION_CACHE_PREFIX}.`)) {
    const segments = key.slice(SESSION_CACHE_PREFIX.length + 1).split('.')
    if (segments[0] === 'candidate') continue
    if (segments[1] !== sessionCacheSegment(scope.viewerUserId)) continue
    if (segments[2] !== sessionCacheSegment(scope.projectId)) continue
    removeRaw(entry, key)
    removed += 1
  }
  return removed
}

/** 测试用：清空内存兜底（不接触真实 localStorage）。 */
export function clearSessionCacheMemoryFallback(): void {
  memoryFallback.clear()
  removedKeys.clear()
}
