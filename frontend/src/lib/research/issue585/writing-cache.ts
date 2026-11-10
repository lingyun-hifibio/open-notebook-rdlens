/**
 * Issue #1048 PR7（D2-B4）：写作选择的独立版本化缓存（方案 §6.1.2）。
 *
 * 权威依据：方案 v4 §6.1.2「独立 Note 缓存可保存 writing 选择的
 * note_id/revision/hash/范围、session_id、history_mode、model、原始请求身份
 * 和 query；**不缓存**历史正文、授权凭证或模型候选；这是独立版本化缓存
 * 字段，不塞进 #602 七键 editor_state」。
 *
 * 设计要点：
 * - 命名空间 `rdlens.research.writing.v1`，键由 owner/project/note/tab 四段
 *   组成（逐段单射转义，沿用 #602/#1046 既有安全转义，避免 `a.b` 串读）；
 * - 只接受 `WritingCacheRecord` **闭合键集**（额外键视为污染，拒绝写入/读取），
 *   从结构上保证不会把 Bearer/历史正文/候选结果写进缓存；
 * - 恢复「未发送」选择前必须重新检查 Note 版本与权限：读取授权要求已认证
 *   owner + 同项目 + 同 authGeneration + 调用方已用服务端确认当前文档可见；
 *   版本不匹配时调用方判定选择失效（不得静默生成新 token 或重取当前正文）；
 * - quota/SecurityError → 内存降级（不丢当前选择，明确提示恢复能力下降）。
 */

import type { ResearchSessionKind } from '@/lib/research/session-contract'
import type {
  WritingDocumentContext,
  WritingHistoryMode,
} from './writing-types'
import { isValidWritingSelection } from './writing-intent'

/** 缓存命名空间（独立于 #602 会话缓存与 #1046 Note 草稿缓存）。 */
export const WRITING_CACHE_NAMESPACE = 'rdlens.research.writing.v1' as const

/** 单条缓存序列化字节预算（query 上限 128 KiB + 选择/身份字段；不存正文）。 */
export const WRITING_CACHE_MAX_SERIALIZED_BYTES = 512 * 1024

/** sessionStorage 中的标签页标识键（同一标签刷新保持，新标签隔离）。 */
export const WRITING_CACHE_TAB_STORAGE_KEY = `${WRITING_CACHE_NAMESPACE}.tab`

/** localStorage 不可用时的进程内兜底（按完整键记录，不跨标签）。 */
const memoryFallback = new Map<string, string>()

/** 删除持久值失败时的墓碑：后续读取返回 null，防止旧值“复活”。 */
const removedKeys = new Set<string>()

let memoryFallbackTabId: string | null = null

/** 最小 Storage 形状（便于测试注入 quota/隐私失败实现）。 */
export interface WritingCacheStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type WritingCacheWriteReason =
  | 'quota'
  | 'security'
  | 'unavailable'
  | 'oversize'
  | 'invalid'
  | null

export interface WritingCacheWriteResult {
  readonly ok: boolean
  readonly persisted: boolean
  readonly degraded: boolean
  readonly reason: WritingCacheWriteReason
}

/** 缓存键作用域（owner/project/note/tab 四段）。 */
export interface WritingCacheScope {
  readonly ownerId: string
  readonly projectId: string
  readonly noteId: string
  readonly tabId: string
}

/**
 * 读取授权（方案 §6.1.2/§4.2）。
 *
 * `notePermission` 只能来自本会话对服务端 Note 的成功读取（`visible`）；
 * `restricted`/`unknown` 时不得恢复正文或选择。缓存本身不是授权凭据。
 */
export interface WritingCacheAuthority {
  readonly authenticatedOwnerId: string | null
  readonly currentProjectId: string
  readonly authGeneration: number
  readonly currentAuthGeneration: number
  readonly notePermission: 'visible' | 'restricted' | 'unknown'
}

/** 已确认但尚未发送的选择快照（Note 版本/范围 + 会话/历史/模型 + query）。 */
export interface WritingCachedChoice {
  /** Note 身份 + 版本/范围（恢复前必须与当前 Note 重新比对）。 */
  readonly documentSelection: WritingDocumentContext
  readonly historyMode: WritingHistoryMode
  readonly sessionChoice: 'current' | 'new'
  readonly sessionKind: ResearchSessionKind
  readonly sourceId: string | null
  /** `sessionChoice='current'` 时的会话 id；无当前会话为 null。 */
  readonly currentSessionId: string | null
  readonly query: string
  readonly modelId: string
}

/** 未决的新会话创建（客户端预生成 session_id；失败同 id 重试，禁止重复创建）。 */
export interface WritingPendingSessionCreate {
  /** 写作尝试标识：同一尝试的重试复用 session_id，新尝试才生成新 id。 */
  readonly attemptId: string
  readonly sessionId: string
  readonly sessionKind: ResearchSessionKind
  readonly sourceId: string | null
  readonly createdAt: string
}

/**
 * 已提交请求的原始身份（结果未知/已冻结时用原 intent 定位恢复）。
 *
 * 只存请求身份字段；不存服务端回执正文/授权凭证。恢复时原样重放同一请求
 * （服务端按同 token/同 intent 复用原 input/Generation），不生成新 token、
 * 不重新读取当前正文。
 */
export interface WritingCachedSubmission {
  readonly sessionId: string
  readonly sessionKind: ResearchSessionKind
  readonly sourceId: string | null
  readonly writingIntentHash: string
  readonly editorRevision: number
  readonly editorIntentHash: string
  readonly draftToken: string
  readonly query: string
  readonly modelId: string
  readonly responseLanguage: string | null
  readonly documentContext: WritingDocumentContext
  readonly historyMode: WritingHistoryMode
  readonly createdAt: string
}

/** 缓存记录（闭合键集；不得加入令牌/历史正文/候选结果）。 */
export interface WritingCacheRecord {
  readonly v: 1
  readonly ownerId: string
  readonly projectId: string
  readonly noteId: string
  readonly tabId: string
  readonly updatedAt: string
  readonly choice: WritingCachedChoice | null
  readonly pendingSessionCreate: WritingPendingSessionCreate | null
  readonly lastSubmission: WritingCachedSubmission | null
}

interface CacheOptions {
  readonly storage?: WritingCacheStorage | null
}

interface CacheEntry {
  readonly storage: WritingCacheStorage | null
  readonly fallback: Map<string, string>
}

// ── Storage 解析与原始读写 ──

/** 解析默认 Storage：SSR / 隐私模式抛错时返回 null（调用方退回内存）。 */
export function resolveWritingCacheStorage(): WritingCacheStorage | null {
  if (typeof window === 'undefined') return null
  try {
    const storage = window.localStorage
    if (!storage) return null
    // 触发一次读取以暴露 SecurityError（隐私模式）。
    storage.getItem(WRITING_CACHE_NAMESPACE)
    return storage
  } catch {
    return null
  }
}

function entryFor(options?: CacheOptions): CacheEntry {
  if (options && 'storage' in options) {
    return { storage: options.storage ?? null, fallback: memoryFallback }
  }
  return { storage: resolveWritingCacheStorage(), fallback: memoryFallback }
}

function classifyStorageError(error: unknown): WritingCacheWriteReason {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota'
  if (name === 'SecurityError') return 'security'
  return 'unavailable'
}

function readRaw(entry: CacheEntry, key: string): string | null {
  if (removedKeys.has(key)) return null
  if (entry.storage !== null) {
    try {
      const raw = entry.storage.getItem(key)
      if (typeof raw === 'string') return raw
    } catch {
      // 读失败：退回内存兜底（不视为“无草稿”，但也不丢当前内存值）。
    }
  }
  return entry.fallback.get(key) ?? null
}

function writeRaw(entry: CacheEntry, key: string, value: string): { persisted: boolean; reason: WritingCacheWriteReason } {
  entry.fallback.set(key, value)
  if (entry.storage === null) return { persisted: false, reason: 'unavailable' }
  try {
    entry.storage.setItem(key, value)
    removedKeys.delete(key)
    return { persisted: true, reason: null }
  } catch (error) {
    return { persisted: false, reason: classifyStorageError(error) }
  }
}

function removeRaw(entry: CacheEntry, key: string): void {
  entry.fallback.delete(key)
  removedKeys.add(key)
  if (entry.storage === null) return
  try {
    entry.storage.removeItem(key)
  } catch {
    // 删除失败：保留墓碑（后续读取返回 null），不复活旧值。
  }
}

// ── 键构造 ──

/** 逐段单射转义（`encodeURIComponent` + 转义 `.`）。 */
export function writingCacheSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isWritingCacheScopeUsable(scope: WritingCacheScope): boolean {
  return (
    isNonEmptyString(scope.ownerId) &&
    isNonEmptyString(scope.projectId) &&
    isNonEmptyString(scope.noteId) &&
    isNonEmptyString(scope.tabId)
  )
}

/** 缓存键：`<namespace>.<owner>.<project>.<note>.<tab>`（逐段转义）。 */
export function writingCacheKey(scope: WritingCacheScope): string {
  return [
    WRITING_CACHE_NAMESPACE,
    writingCacheSegment(scope.ownerId),
    writingCacheSegment(scope.projectId),
    writingCacheSegment(scope.noteId),
    writingCacheSegment(scope.tabId),
  ].join('.')
}

function notePrefix(ownerId: string, projectId: string, noteId: string): string {
  return [
    WRITING_CACHE_NAMESPACE,
    writingCacheSegment(ownerId),
    writingCacheSegment(projectId),
    writingCacheSegment(noteId),
  ].join('.')
}

function randomTabId(): string {
  const cryptoObject =
    typeof globalThis === 'object' ? (globalThis as { crypto?: Crypto }).crypto : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `wtab_${cryptoObject.randomUUID().replace(/-/g, '')}`
  }
  return `wtab_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * 读取/生成本标签页的写作缓存 tabId。
 *
 * 同一标签刷新必须复用（sessionStorage），否则刷新后恢复不到自己的未发送
 * 选择；新标签隔离（不同草稿分支）。sessionStorage 不可用时进程内稳定。
 */
export function readOrCreateWritingCacheTabId(
  options: { readonly sessionStorage?: WritingCacheStorage | null } = {},
): string {
  if (memoryFallbackTabId !== null) return memoryFallbackTabId
  let storage: WritingCacheStorage | null | undefined
  if ('sessionStorage' in options) {
    storage = options.sessionStorage ?? null
  } else if (typeof window === 'undefined') {
    storage = null
  } else {
    try {
      storage = window.sessionStorage
    } catch {
      storage = null
    }
  }
  if (storage !== null && storage !== undefined) {
    try {
      const existing = storage.getItem(WRITING_CACHE_TAB_STORAGE_KEY)
      if (isNonEmptyString(existing)) {
        memoryFallbackTabId = existing
        return existing
      }
      const created = randomTabId()
      storage.setItem(WRITING_CACHE_TAB_STORAGE_KEY, created)
      memoryFallbackTabId = created
      return created
    } catch {
      // 隐私模式：退回进程内稳定 id。
    }
  }
  memoryFallbackTabId = randomTabId()
  return memoryFallbackTabId
}

/** 测试/身份切换清理进程内 tabId（新身份不得继承旧标签分支）。 */
export function resetWritingCacheTabId(): void {
  memoryFallbackTabId = null
}

// ── 记录校验（闭合键集） ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasClosedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => key in value)
}

function isRevision(value: unknown, minimum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= 2 ** 31 - 1
  )
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isDraftToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

const SESSION_KINDS: readonly ResearchSessionKind[] = ['global', 'source']
const HISTORY_MODES: readonly WritingHistoryMode[] = ['none', 'current']

function isValidDocumentContext(value: unknown): value is WritingDocumentContext {
  if (!isRecord(value)) return false
  if (!hasClosedKeys(value, ['note_id', 'revision', 'snapshot_hash', 'selection'])) return false
  return (
    typeof value.note_id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.note_id) &&
    isRevision(value.revision, 1) &&
    isHex64(value.snapshot_hash) &&
    isValidWritingSelection(value.selection)
  )
}

function isValidChoice(value: unknown): value is WritingCachedChoice {
  if (!isRecord(value)) return false
  return (
    hasClosedKeys(value, [
      'documentSelection',
      'historyMode',
      'sessionChoice',
      'sessionKind',
      'sourceId',
      'currentSessionId',
      'query',
      'modelId',
    ]) &&
    isValidDocumentContext(value.documentSelection) &&
    HISTORY_MODES.includes(value.historyMode as WritingHistoryMode) &&
    (value.sessionChoice === 'current' || value.sessionChoice === 'new') &&
    SESSION_KINDS.includes(value.sessionKind as ResearchSessionKind) &&
    (value.sourceId === null || isNonEmptyString(value.sourceId)) &&
    (value.sessionKind === 'source' ? isNonEmptyString(value.sourceId) : value.sourceId === null) &&
    (value.currentSessionId === null || isNonEmptyString(value.currentSessionId)) &&
    typeof value.query === 'string' &&
    typeof value.modelId === 'string'
  )
}

function isValidPendingCreate(value: unknown): value is WritingPendingSessionCreate {
  if (!isRecord(value)) return false
  return (
    hasClosedKeys(value, [
      'attemptId',
      'sessionId',
      'sessionKind',
      'sourceId',
      'createdAt',
    ]) &&
    isNonEmptyString(value.attemptId) &&
    typeof value.sessionId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId) &&
    SESSION_KINDS.includes(value.sessionKind as ResearchSessionKind) &&
    (value.sourceId === null || isNonEmptyString(value.sourceId)) &&
    isNonEmptyString(value.createdAt)
  )
}

function isValidSubmission(value: unknown): value is WritingCachedSubmission {
  if (!isRecord(value)) return false
  return (
    hasClosedKeys(value, [
      'sessionId',
      'sessionKind',
      'sourceId',
      'writingIntentHash',
      'editorRevision',
      'editorIntentHash',
      'draftToken',
      'query',
      'modelId',
      'responseLanguage',
      'documentContext',
      'historyMode',
      'createdAt',
    ]) &&
    typeof value.sessionId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId) &&
    SESSION_KINDS.includes(value.sessionKind as ResearchSessionKind) &&
    (value.sourceId === null || isNonEmptyString(value.sourceId)) &&
    isHex64(value.writingIntentHash) &&
    isRevision(value.editorRevision, 0) &&
    isHex64(value.editorIntentHash) &&
    isDraftToken(value.draftToken) &&
    typeof value.query === 'string' &&
    isNonEmptyString(value.modelId) &&
    (value.responseLanguage === null || typeof value.responseLanguage === 'string') &&
    isValidDocumentContext(value.documentContext) &&
    HISTORY_MODES.includes(value.historyMode as WritingHistoryMode) &&
    isNonEmptyString(value.createdAt)
  )
}

/** 记录是否合法（闭合键集 + 字段形状；拒绝任意附加键）。 */
export function isValidWritingCacheRecord(value: unknown): value is WritingCacheRecord {
  if (!isRecord(value)) return false
  return (
    hasClosedKeys(value, [
      'v',
      'ownerId',
      'projectId',
      'noteId',
      'tabId',
      'updatedAt',
      'choice',
      'pendingSessionCreate',
      'lastSubmission',
    ]) &&
    value.v === 1 &&
    isNonEmptyString(value.ownerId) &&
    isNonEmptyString(value.projectId) &&
    isNonEmptyString(value.noteId) &&
    isNonEmptyString(value.tabId) &&
    isNonEmptyString(value.updatedAt) &&
    (value.choice === null || isValidChoice(value.choice)) &&
    (value.pendingSessionCreate === null || isValidPendingCreate(value.pendingSessionCreate)) &&
    (value.lastSubmission === null || isValidSubmission(value.lastSubmission))
  )
}

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function measureBytes(value: string): number {
  return new TextEncoder().encode(value).length
}

// ── 读写授权 ──

/** 读取授权：已认证 owner + 同项目 + 同 authGeneration + Note 可见。 */
export function canReadWritingCache(
  scope: WritingCacheScope,
  authority: WritingCacheAuthority,
): boolean {
  if (!isWritingCacheScopeUsable(scope)) return false
  if (authority.authenticatedOwnerId === null) return false
  if (authority.authenticatedOwnerId !== scope.ownerId) return false
  if (authority.currentProjectId !== scope.projectId) return false
  if (authority.authGeneration !== authority.currentAuthGeneration) return false
  return authority.notePermission === 'visible'
}

/** 读取缓存记录；形状非法/授权不通过返回 null（fail-closed）。 */
export function readWritingCacheRecord(
  scope: WritingCacheScope,
  options: CacheOptions & { readonly authority?: WritingCacheAuthority } = {},
): WritingCacheRecord | null {
  if (!isWritingCacheScopeUsable(scope)) return null
  if (options.authority !== undefined && !canReadWritingCache(scope, options.authority)) {
    return null
  }
  const entry = entryFor(options)
  const raw = readRaw(entry, writingCacheKey(scope))
  const parsed = parseJson(raw)
  if (!isValidWritingCacheRecord(parsed)) return null
  if (
    parsed.ownerId !== scope.ownerId ||
    parsed.projectId !== scope.projectId ||
    parsed.noteId !== scope.noteId ||
    parsed.tabId !== scope.tabId
  ) {
    return null
  }
  return parsed
}

function invalidWrite(reason: WritingCacheWriteReason): WritingCacheWriteResult {
  return { ok: false, persisted: false, degraded: false, reason }
}

/** 写入缓存记录（形状非法直接拒绝；quota/隐私失败降级内存）。 */
export function writeWritingCacheRecord(
  scope: WritingCacheScope,
  record: WritingCacheRecord,
  options: CacheOptions = {},
): WritingCacheWriteResult {
  if (!isWritingCacheScopeUsable(scope)) return invalidWrite('invalid')
  if (!isValidWritingCacheRecord(record)) return invalidWrite('invalid')
  if (
    record.ownerId !== scope.ownerId ||
    record.projectId !== scope.projectId ||
    record.noteId !== scope.noteId ||
    record.tabId !== scope.tabId
  ) {
    return invalidWrite('invalid')
  }
  const serialized = JSON.stringify(record)
  if (measureBytes(serialized) > WRITING_CACHE_MAX_SERIALIZED_BYTES) {
    return invalidWrite('oversize')
  }
  const entry = entryFor(options)
  const written = writeRaw(entry, writingCacheKey(scope), serialized)
  return {
    ok: true,
    persisted: written.persisted,
    degraded: !written.persisted,
    reason: written.reason,
  }
}

/** 删除当前标签页的缓存记录（同步墓碑，防止旧值复活）。 */
export function removeWritingCacheRecord(
  scope: WritingCacheScope,
  options: CacheOptions = {},
): boolean {
  if (!isWritingCacheScopeUsable(scope)) return false
  removeRaw(entryFor(options), writingCacheKey(scope))
  return true
}

/** 权限受限/身份撤销：清理该 Note 在本标签页外的全部分支（含旧标签页）。 */
export function removeWritingCacheForNote(
  input: { readonly ownerId: string; readonly projectId: string; readonly noteId: string },
  options: CacheOptions = {},
): number {
  if (
    !isNonEmptyString(input.ownerId) ||
    !isNonEmptyString(input.projectId) ||
    !isNonEmptyString(input.noteId)
  ) {
    return 0
  }
  const entry = entryFor(options)
  const prefix = `${notePrefix(input.ownerId, input.projectId, input.noteId)}.`
  const keys = new Set<string>()
  if (entry.storage !== null) {
    try {
      for (let index = 0; index < entry.storage.length; index += 1) {
        const key = entry.storage.key(index)
        if (key !== null && key.startsWith(prefix)) keys.add(key)
      }
    } catch {
      // 枚举失败：仍清理内存兜底与当前 key 前缀（best effort）。
    }
  }
  for (const key of entry.fallback.keys()) {
    if (key.startsWith(prefix)) keys.add(key)
  }
  for (const key of keys) removeRaw(entry, key)
  return keys.size
}

/** 测试清理进程内存兜底与墓碑。 */
export function clearWritingCacheMemoryFallback(): void {
  memoryFallback.clear()
  removedKeys.clear()
}

/** 构造空记录（首次写入）。 */
export function createWritingCacheRecord(input: {
  readonly scope: WritingCacheScope
  readonly now: string
}): WritingCacheRecord {
  return {
    v: 1,
    ownerId: input.scope.ownerId,
    projectId: input.scope.projectId,
    noteId: input.scope.noteId,
    tabId: input.scope.tabId,
    updatedAt: input.now,
    choice: null,
    pendingSessionCreate: null,
    lastSubmission: null,
  }
}
