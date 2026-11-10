/**
 * Issue #1046 PR4（D2-B2）：Note 独立版本化草稿缓存。
 *
 * 权威依据：契约 §4.2（`rdlens.research.note.v1` 命名空间、键含
 * owner/project/note/tab、只存编辑所需字段、不存令牌/对话/写作候选）、
 * 方案 v4 §4.2（额度/隐私失败降级内存、权限受限清理、离线不恢复）、
 * §4.4（pagehide 同步持久化）。
 *
 * 设计要点：
 * - 键逐段单射：`encodeURIComponent(v).replace(/\./g, '%2E')`（沿用 #602
 *   session-cache 的既有安全转义），否则 `a.b` 与 `a`/`b` 会串读；
 * - 读取授权：已认证 owner + 同项目 + 当前 authGeneration + 调用方已用
 *   服务端确认当前文档权限（离线/403/404 不得恢复正文）；
 * - 只接受 `NoteDraftCacheRecord` 闭合键集（额外键视为污染，拒绝写入/读取），
 *   从结构上保证不会把 Bearer/对话/写作候选写进缓存；
 * - quota/SecurityError/单条超预算 → 内存降级（`memory_only`），不丢文本，
 *   不显示虚假已保存；
 * - 权限受限（403）→ 清理该 Note 的全部持久草稿（含旧标签页分支）。
 */

import {
  NOTE_DRAFT_STORAGE_NAMESPACE,
  type NoteDraftCacheRecord,
  type PendingNoteMutation,
} from './types'

/** 缓存命名空间（契约 §4.2 冻结值）。 */
export const NOTE_DRAFT_CACHE_PREFIX = NOTE_DRAFT_STORAGE_NAMESPACE

/** 每条草稿序列化后的字节预算（与写入输入上限 1 MiB 同口径）。 */
export const NOTE_DRAFT_MAX_SERIALIZED_BYTES = 1024 * 1024

/** sessionStorage 中的标签页标识键（同一标签刷新保持，新标签隔离）。 */
export const NOTE_DRAFT_TAB_STORAGE_KEY = `${NOTE_DRAFT_STORAGE_NAMESPACE}.tab`

/** localStorage 不可用时进程内兜底（按完整键记录，不跨标签）。 */
const memoryFallback = new Map<string, string>()

/**
 * sessionStorage 不可用（隐私模式/策略禁用）时的进程内稳定 tabId。
 *
 * 必须稳定：草稿写入（machine）与恢复入口（NotesPanel）分别调用
 * `readOrCreateNoteDraftTabId`，若每次返回新 id 会落到不同草稿分支 ⇒ 恢复入口
 * 永远为空（Issue #1136 审查 MEDIUM-3）。同一 JS 进程/页面生命周期内复用。
 */
let memoryFallbackTabId: string | null = null

/**
 * 删除持久值失败时的墓碑：后续读取返回 null，防止旧持久值在清理后“复活”。
 */
const removedKeys = new Set<string>()

/** 最小 Storage 形状（便于测试注入 quota/隐私失败实现）。 */
export interface NoteDraftCacheStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 写入降级原因。 */
export type NoteDraftWriteReason =
  | 'quota'
  | 'security'
  | 'unavailable'
  | 'oversize'
  | 'invalid'
  | null

export interface NoteDraftWriteResult {
  /** 记录是否被接受（false = 形状/作用域非法，未写入任何层）。 */
  readonly ok: boolean
  /** true = 已写入持久存储。 */
  readonly persisted: boolean
  /** true = 只写进内存（本机恢复能力下降，但当前会话不丢文本）。 */
  readonly degraded: boolean
  readonly reason: NoteDraftWriteReason
}

/** 草稿键作用域（owner/project/note/tab 四段；契约 §4.2）。 */
export interface NoteDraftScope {
  readonly ownerId: string
  readonly projectId: string
  readonly noteId: string
  readonly tabId: string
}

/**
 * 读取授权（契约 §4.2 / 方案 §4.4）。
 *
 * `permissionConfirmed` 只能来自本会话对服务端 `GET /notes/{id}` 的成功读取；
 * 离线、403、404、能力故障时一律 false → 不恢复正文。
 */
export interface NoteDraftAuthority {
  readonly authenticatedOwnerId: string | null
  readonly currentProjectId: string
  readonly authGeneration: number
  readonly currentAuthGeneration: number
  readonly permissionConfirmed: boolean
}

interface CacheOptions {
  readonly storage?: NoteDraftCacheStorage | null
}

interface CacheEntry {
  readonly storage: NoteDraftCacheStorage | null
  readonly fallback: Map<string, string>
}

// ── Storage 解析与原始读写 ──

/** 解析默认 Storage：SSR / 隐私模式抛错时返回 null（调用方退回内存）。 */
export function resolveNoteDraftStorage(): NoteDraftCacheStorage | null {
  if (typeof window === 'undefined') return null
  try {
    const storage = window.localStorage
    if (!storage) return null
    // 触发一次读取以暴露 SecurityError（隐私模式）
    storage.getItem(NOTE_DRAFT_CACHE_PREFIX)
    return storage
  } catch {
    return null
  }
}

function entryFor(options?: CacheOptions): CacheEntry {
  if (options && 'storage' in options) {
    return { storage: options.storage ?? null, fallback: memoryFallback }
  }
  return { storage: resolveNoteDraftStorage(), fallback: memoryFallback }
}

function classifyStorageError(error: unknown): NoteDraftWriteReason {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota'
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'security'
  return 'unavailable'
}

function readRaw(
  entry: CacheEntry,
  key: string,
): { value: string | null; reason: NoteDraftWriteReason } {
  // 删除失败的墓碑优先：旧持久值不得复活。
  if (removedKeys.has(key)) return { value: null, reason: null }
  // 内存兜底代表本进程最近一次写入（持久化失败时的降级副本），优先于可能
  // 已过期的持久值返回。
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
): { persisted: boolean; reason: NoteDraftWriteReason } {
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
    // 删除失败不阻断清理流程，但必须留墓碑（内存兜底已删除、旧持久值不得复活）。
    removedKeys.add(key)
  }
}

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

// ── 键编码 ──

/** 单段编码（`encodeURIComponent` + 转义 `.`，保证键分段单射）。 */
export function noteDraftCacheSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** 作用域是否可用（空段会产生歧义键，直接拒绝而非静默降级）。 */
export function isNoteDraftScopeUsable(scope: NoteDraftScope): boolean {
  return (
    isNonEmptyString(scope.ownerId) &&
    isNonEmptyString(scope.projectId) &&
    isNonEmptyString(scope.noteId) &&
    isNonEmptyString(scope.tabId)
  )
}

export function noteDraftKey(scope: NoteDraftScope): string {
  return [
    NOTE_DRAFT_CACHE_PREFIX,
    noteDraftCacheSegment(scope.ownerId),
    noteDraftCacheSegment(scope.projectId),
    noteDraftCacheSegment(scope.noteId),
    noteDraftCacheSegment(scope.tabId),
  ].join('.')
}

function noteDraftPrefix(ownerId: string, projectId: string, noteId: string): string {
  return [
    NOTE_DRAFT_CACHE_PREFIX,
    noteDraftCacheSegment(ownerId),
    noteDraftCacheSegment(projectId),
    noteDraftCacheSegment(noteId),
  ].join('.')
}

// ── 标签页标识 ──

function randomTabId(): string {
  const cryptoObject =
    typeof globalThis === 'object' ? (globalThis as { crypto?: Crypto }).crypto : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `t${cryptoObject.randomUUID().replace(/-/g, '')}`
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

/**
 * 读取或创建本标签页的草稿 tabId（sessionStorage：同标签刷新保持，复制标签
 * 得到新 id，避免两个标签互相覆盖同一草稿分支）。
 */
export function readOrCreateNoteDraftTabId(
  storage?: Pick<NoteDraftCacheStorage, 'getItem' | 'setItem'> | null,
): string {
  const target =
    storage ??
    (typeof window !== 'undefined'
      ? (() => {
          try {
            return window.sessionStorage
          } catch {
            return null
          }
        })()
      : null)
  if (target) {
    try {
      const existing = target.getItem(NOTE_DRAFT_TAB_STORAGE_KEY)
      if (isNonEmptyString(existing)) return existing
      const created = randomTabId()
      target.setItem(NOTE_DRAFT_TAB_STORAGE_KEY, created)
      return created
    } catch {
      // 隐私模式/配额：退回进程内稳定 id（本次会话仍可恢复；跨刷新不可恢复）
    }
  }
  if (memoryFallbackTabId === null) memoryFallbackTabId = createNoteDraftTabId()
  return memoryFallbackTabId
}

/** 新 tabId（测试/显式新实例用）。 */
export function createNoteDraftTabId(): string {
  return randomTabId()
}

// ── 记录校验（闭合键集：结构上禁止令牌/对话进入缓存） ──

const NOTE_DRAFT_RECORD_KEYS: ReadonlySet<string> = new Set([
  'v',
  'ownerId',
  'projectId',
  'noteId',
  'title',
  'content',
  'baseRevision',
  'baseSnapshotHash',
  'localSeq',
  'pendingMutation',
  'savedAt',
])

const PENDING_MUTATION_KEYS: ReadonlySet<string> = new Set([
  'mutationId',
  'kind',
  'noteId',
  'expectedRevision',
  'title',
  'content',
  'createdAt',
  // 加性（PR4 core）：copy 未知结果重放所需的源基线 hash。
  'sourceSnapshotHash',
])

const PENDING_MUTATION_KINDS: ReadonlySet<string> = new Set(['save', 'create', 'copy'])

function hasClosedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false
  }
  return true
}

function isValidRevision(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 2147483647
}

export function isValidPendingNoteMutation(value: unknown): value is PendingNoteMutation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!hasClosedKeys(record, PENDING_MUTATION_KEYS)) return false
  if (!isNonEmptyString(record.mutationId)) return false
  if (typeof record.kind !== 'string' || !PENDING_MUTATION_KINDS.has(record.kind)) return false
  if (record.noteId !== null && !isNonEmptyString(record.noteId)) return false
  if (record.expectedRevision !== null && !isValidRevision(record.expectedRevision, 1)) {
    return false
  }
  if (typeof record.title !== 'string' || typeof record.content !== 'string') return false
  if (typeof record.createdAt !== 'string') return false
  // 加性字段：仅 copy 重放需要；存在时必须是 hex64（或 null）。
  const sourceSnapshotHash = record.sourceSnapshotHash
  if (
    sourceSnapshotHash !== undefined &&
    sourceSnapshotHash !== null &&
    (typeof sourceSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(sourceSnapshotHash))
  ) {
    return false
  }
  return true
}

/**
 * 记录形状校验 + 作用域一致性校验：键里编码的 owner/project/note 必须与记录
 * 内部字段一致，否则读取/写入都拒绝（防止跨分区误读）。
 */
export function isValidNoteDraftCacheRecord(
  value: unknown,
  scope?: NoteDraftScope,
): value is NoteDraftCacheRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (!hasClosedKeys(record, NOTE_DRAFT_RECORD_KEYS)) return false
  if (record.v !== 1) return false
  if (!isNonEmptyString(record.ownerId)) return false
  if (!isNonEmptyString(record.projectId)) return false
  if (!isNonEmptyString(record.noteId)) return false
  if (typeof record.title !== 'string' || typeof record.content !== 'string') return false
  if (!isValidRevision(record.baseRevision, 1)) return false
  if (typeof record.baseSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.baseSnapshotHash)) {
    return false
  }
  if (!isValidRevision(record.localSeq, 0)) return false
  if (record.pendingMutation !== null && !isValidPendingNoteMutation(record.pendingMutation)) {
    return false
  }
  if (typeof record.savedAt !== 'string') return false
  if (scope) {
    if (record.ownerId !== scope.ownerId) return false
    if (record.projectId !== scope.projectId) return false
    if (record.noteId !== scope.noteId) return false
  }
  return true
}

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function measureBytes(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).byteLength
  }
  return value.length
}

function invalidWrite(): NoteDraftWriteResult {
  return { ok: false, persisted: false, degraded: true, reason: 'invalid' }
}

// ── 授权 ──

/**
 * 恢复前提：已认证 owner（可能与当前 viewer 不同 → 不读）、同项目、当前
 * authGeneration、且调用方已确认当前文档权限。`authGeneration=0` 表示尚未
 * 认证，一律不可读。
 */
export function canReadNoteDraft(scope: NoteDraftScope, authority: NoteDraftAuthority): boolean {
  return (
    authority.permissionConfirmed &&
    authority.authGeneration > 0 &&
    authority.authGeneration === authority.currentAuthGeneration &&
    authority.authenticatedOwnerId !== null &&
    authority.authenticatedOwnerId === scope.ownerId &&
    authority.currentProjectId === scope.projectId
  )
}

// ── 公共 API ──

/** 写入草稿（每次编辑同步调用；quota/SecurityError → 内存降级）。 */
export function writeNoteDraft(
  scope: NoteDraftScope,
  record: NoteDraftCacheRecord,
  options?: CacheOptions,
): NoteDraftWriteResult {
  if (!isNoteDraftScopeUsable(scope)) return invalidWrite()
  if (!isValidNoteDraftCacheRecord(record, scope)) return invalidWrite()
  const serialized = JSON.stringify(record)
  if (measureBytes(serialized) > NOTE_DRAFT_MAX_SERIALIZED_BYTES) {
    // 超预算：仍在内存保留文本（不清空用户草稿），但明确不可持久恢复。
    const entry = entryFor(options)
    entry.fallback.set(noteDraftKey(scope), serialized)
    return { ok: true, persisted: false, degraded: true, reason: 'oversize' }
  }
  const outcome = writeRaw(entryFor(options), noteDraftKey(scope), serialized)
  return {
    ok: true,
    persisted: outcome.persisted,
    degraded: !outcome.persisted,
    reason: outcome.reason,
  }
}

/** 读取可恢复草稿（权限未确认/身份或代际不匹配/旧标签 → null，不抛错）。 */
export function readNoteDraft(
  scope: NoteDraftScope,
  authority: NoteDraftAuthority,
  options?: CacheOptions,
): NoteDraftCacheRecord | null {
  if (!isNoteDraftScopeUsable(scope) || !canReadNoteDraft(scope, authority)) return null
  const raw = parseJson(readRaw(entryFor(options), noteDraftKey(scope)).value)
  return isValidNoteDraftCacheRecord(raw, scope) ? raw : null
}

/**
 * 取回本地草稿（删除/服务端不可用后的用户取回入口）：只要求身份/项目/代际
 * 匹配，**不要求**当前文档权限（服务端已明确 404 时，本地文本仍可由用户
 * 复制/下载；绝不据此恢复可编辑状态或自动新建）。
 */
export function readNoteDraftForRetrieval(
  scope: NoteDraftScope,
  authority: NoteDraftAuthority,
  options?: CacheOptions,
): NoteDraftCacheRecord | null {
  if (!isNoteDraftScopeUsable(scope)) return null
  if (authority.authGeneration <= 0) return null
  if (authority.authGeneration !== authority.currentAuthGeneration) return null
  if (authority.authenticatedOwnerId === null) return null
  if (authority.authenticatedOwnerId !== scope.ownerId) return null
  if (authority.currentProjectId !== scope.projectId) return null
  const raw = parseJson(readRaw(entryFor(options), noteDraftKey(scope)).value)
  return isValidNoteDraftCacheRecord(raw, scope) ? raw : null
}

/**
 * 可恢复草稿摘要（父级导航离开后的恢复入口列表项，Issue #1136）。
 *
 * 只含恢复入口所需的本地元数据，**不含正文**：正文恢复仍必须经
 * `openNote`（服务端 `GET /notes/{id}` 权限确认）后再由 `readNoteDraft`
 * 恢复，离线/403 不恢复正文（方案 §4.2/§4.4）。
 */
export interface RecoverableNoteDraftSummary {
  readonly noteId: string
  readonly title: string
  readonly savedAt: string
}

/**
 * 列出本标签页在指定 owner/project 下仍待恢复的草稿（Issue #1136：
 * 工作台父级导航采用「自动保存＋可恢复」——导航不阻断，恢复入口显式可见）。
 *
 * 与 `readNoteDraftForRetrieval` 相同的身份作者权：要求已认证 owner、同项目、
 * 当前 authGeneration 匹配；**不要求**当前文档权限，因为这里只报告“本浏览器
 * 存在未保存草稿”，不恢复正文、不代表可编辑（权限受限的草稿在打开时清理）。
 * 返回的 `title` 是用户自己写入本机缓存的元数据；UI 对目录中已标记
 * `access_state='restricted'` 的笔记必须脱敏标题（见 NoteRecoveryInbox），
 * 正文恢复/取回仍必须经 `openNote` 的服务端权限确认（方案 §4.2）。
 * 只列出当前标签页分支（多标签各自独立草稿，互不覆盖，沿用契约 §4.2）。
 */
export function listRecoverableNoteDrafts(
  ownerId: string,
  projectId: string,
  tabId: string,
  authority: NoteDraftAuthority,
  options?: CacheOptions,
): RecoverableNoteDraftSummary[] {
  if (!isNonEmptyString(ownerId) || !isNonEmptyString(projectId) || !isNonEmptyString(tabId)) {
    return []
  }
  if (authority.authGeneration <= 0) return []
  if (authority.authGeneration !== authority.currentAuthGeneration) return []
  if (authority.authenticatedOwnerId === null) return []
  if (authority.authenticatedOwnerId !== ownerId) return []
  if (authority.currentProjectId !== projectId) return []

  const entry = entryFor(options)
  const prefix = `${NOTE_DRAFT_CACHE_PREFIX}.${noteDraftCacheSegment(ownerId)}.${noteDraftCacheSegment(projectId)}.`
  const tabSegment = noteDraftCacheSegment(tabId)
  const results: RecoverableNoteDraftSummary[] = []
  for (const key of listStorageKeys(entry, prefix)) {
    const segments = key.slice(prefix.length).split('.')
    // 键尾部固定为 <encoded noteId>.<encoded tabId>（段内 `.` 已转义，分隔安全）。
    if (segments.length !== 2 || segments[1] !== tabSegment) continue
    let noteId: string
    try {
      noteId = decodeURIComponent(segments[0])
    } catch {
      continue
    }
    const scope: NoteDraftScope = { ownerId, projectId, noteId, tabId }
    const raw = parseJson(readRaw(entry, key).value)
    if (!isValidNoteDraftCacheRecord(raw, scope)) continue
    results.push({ noteId, title: raw.title, savedAt: raw.savedAt })
  }
  // 最近编辑的草稿优先；同时间按 noteId 稳定排序（不依赖 Storage 枚举顺序）。
  results.sort((a, b) => {
    if (a.savedAt === b.savedAt) return a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0
    return a.savedAt < b.savedAt ? 1 : -1
  })
  return results
}

/** 删除单条草稿（ACK 清稿/显式放弃）。 */
export function removeNoteDraft(scope: NoteDraftScope, options?: CacheOptions): boolean {
  if (!isNoteDraftScopeUsable(scope)) return false
  const entry = entryFor(options)
  const key = noteDraftKey(scope)
  if (readRaw(entry, key).value === null) return false
  removeRaw(entry, key)
  return true
}

/**
 * 权限受限清理：删除该 Note 在本浏览器内的**全部**标签页草稿分支
 * （方案 §4.2「权限受限后停止展示并清理对应持久缓存」）。
 */
export function removeNoteDraftsForNote(
  ownerId: string,
  projectId: string,
  noteId: string,
  options?: CacheOptions,
): number {
  if (!isNonEmptyString(ownerId) || !isNonEmptyString(projectId) || !isNonEmptyString(noteId)) {
    return 0
  }
  const entry = entryFor(options)
  const prefix = `${noteDraftPrefix(ownerId, projectId, noteId)}.`
  let removed = 0
  for (const key of listStorageKeys(entry, prefix)) {
    removeRaw(entry, key)
    removed += 1
  }
  return removed
}

/** 测试用：清空内存兜底（不接触真实 localStorage）。 */
export function clearNoteDraftMemoryFallback(): void {
  memoryFallback.clear()
  removedKeys.clear()
  memoryFallbackTabId = null
}
