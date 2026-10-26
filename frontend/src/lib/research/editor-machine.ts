/**
 * 编辑器状态机与 CAS 保存队列（RDLens #602 第三批 PR-3，3C-1）。
 *
 * 规范来源：
 * - `dev_docs/设计方案/Research/issue602_batch3/01_DESIGN.md`
 *   §3.2（认证代际与 PUT 接管）、§3.5（草稿 writer 分支）、
 *   §5.1–§5.6、§5.8（状态转移）、§9.2（EditorHandle）
 * - `02_INTERFACE_FREEZE.md` §3–§6（editor_state、PUT、错误码）
 * - `cards/PR-3.md`（实施合约；冲突时以 01_DESIGN 为准）
 *
 * 职责边界：
 * - 本模块是**纯状态机 + 纯决策函数 + 显式依赖注入的控制器**，不 import
 *   React / api / session-runtime 的值（仅 type-only import），不持有
 *   QueryClient；副作用（传输、本机缓存、认证快照、写入失效守卫）全部经
 *   `EditorDeps` 注入。
 * - 草稿本机缓存的键与预算由 `session-cache.ts` draft 段（PR-1）负责，本模块
 *   只组装/读取 `SessionDraftRecord`。
 * - 提交（submission）/SSE 接线归 PR-5a；本模块提供 DESIGN §5.6 1–7 的可调用
 *   API 形态（hold/release/flush/clearAfterSubmission/markTokenConsumed）。
 *
 * 证据级别：本 PR 的自动化验证为 `simulated`（fake timers + 契约 mock），
 * 不表示真实后端/真实多标签/真实浏览器刷新已验证。
 */

import {
  parseEditorResponse,
  parseSaveResponse,
  sessionKey,
  type ResearchEditorResponseProjection,
  type ResearchSessionRef,
  type WireChatAnchor,
  type WireEditorBaseScope,
  type WireReaderAnchor,
} from './session-contract'
import {
  listDraftBranches,
  readDraft,
  removeDraftIfVersion,
  writeDraft,
  type SessionCacheAuthority,
  type SessionCacheScope,
  type SessionCacheStorage,
  type SessionDraftBranch,
  type SessionDraftRecord,
} from './session-cache'
import type {
  CreateMutationRecordInput,
  MutationRecord,
  SessionWriteGuard,
  TransportAttempt,
} from './session-runtime'
import type {
  AcceptedReceipt,
  ClearOutcome,
  EditorFlushReason,
  EditorHold,
  EditorPhase,
  EditorRestoreCandidate,
  EditorSaveFailure,
  EditorSaveRequestWire,
  EditorSnapshot,
  EditorStateWire,
  SaveOutcome,
  ScopeEdit,
} from './types'

// ── 时序与预算常量（DESIGN §5.4/§5.5） ──

/** 文本变更后保存延迟（DESIGN §5.5：500ms）。 */
export const EDITOR_TEXT_DEBOUNCE_MS = 500
/** 位置类变化空闲延迟（DESIGN §5.5：1000ms）。 */
export const EDITOR_POSITION_IDLE_MS = 1000
/** 本机草稿写入去抖（DESIGN §5.5：100ms）。 */
export const EDITOR_LOCAL_MERGE_MS = 100
/** 草稿文本上限（DESIGN §5.4：256KiB）。 */
export const EDITOR_TEXT_MAX_BYTES = 256 * 1024
/** 序列化 editor_state 上限（DESIGN §5.4：512KiB）。 */
export const EDITOR_JSON_MAX_BYTES = 512 * 1024
/** 503/网络失败自动重试次数（PR-3 取 3，design 未固化次数）。 */
export const EDITOR_MAX_SAVE_ATTEMPTS = 3
/** 自动重试退避（ms）。 */
export const EDITOR_RETRY_DELAYS_MS: readonly number[] = [1000, 2000]

const DRAFT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

// ── 小工具 ──

/** 生成 `^[A-Za-z0-9_-]{1,128}$` 形状的随机标识（浏览器/测试均可）。 */
function randomId(prefix: string): string {
  const cryptoObject = typeof globalThis === 'object'
    ? (globalThis as { crypto?: Crypto }).crypto
    : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `${prefix}${cryptoObject.randomUUID().replace(/-/g, '')}`
  }
  const bytes = new Uint8Array(12)
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return `${prefix}${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`
}

/** 新草稿 token（文本/范围变化时生成；ACK 后才采用）。 */
export function createDraftToken(): string {
  return randomId('t')
}

/** 新 mutation_id（每次新 mutation 生成；ACK 丢失/跨代际重放必须复用）。 */
export function createMutationId(): string {
  return randomId('m')
}

/** 文本是否含孤立 UTF-16 代理项（JSON 无法安全序列化，DESIGN §5.4）。 */
export function hasUnpairedSurrogate(text: string): boolean {
  return LONE_SURROGATE_PATTERN.test(text)
}

/** 草稿文本字节数（TextEncoder UTF-8）。 */
export function measureDraftBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** `editor_state` 序列化字节数（UTF-8）。 */
export function measureEditorStateBytes(state: EditorSnapshot): number {
  return measureDraftBytes(JSON.stringify(editorStateToWire(state)))
}

/** 编辑器依赖的最小认证/运行时视图（session-runtime 快照的子集）。 */
export interface EditorRuntimeView {
  readonly authGeneration: number
  readonly projectId: string
  readonly viewerUserId: string | null
  readonly phase:
    | 'locked'
    | 'masked'
    | 'bootstrapping'
    | 'ready'
    | 'viewer_changed'
    | 'unauthorized'
    | 'error'
  readonly ready: boolean
  /** 服务端 editor 能力（capabilities.editor_ready）；缺省视为可用。 */
  readonly editorReady?: boolean
  readonly disposed: boolean
  readonly viewerChanged: boolean
}

/** transport 只暴露编辑器两个端点；返回原始 JSON（解析在本模块）。 */
export interface EditorTransport {
  getEditorState(): Promise<unknown>
  putEditorState(body: EditorSaveRequestWire): Promise<unknown>
}

/** 传输尝试工厂入参（不含 attemptId，由 session-runtime 包装生成）。 */
export interface EditorTransportAttemptInput {
  readonly mutationId: string
  readonly scope: {
    readonly authGeneration: number
    readonly projectId: string
    readonly viewerUserId: string | null
  }
  readonly sessionKey: string
  readonly createdAt: string
}

/** 复用 session-runtime 的 mutation/attempt 工厂（PR-1 既有实现）。 */
export interface EditorMutationFactories {
  readonly createMutationRecord: (input: CreateMutationRecordInput) => MutationRecord
  readonly createTransportAttempt: (input: EditorTransportAttemptInput) => TransportAttempt
  readonly markTransportAttemptDispatched: (attempt: TransportAttempt) => TransportAttempt
  readonly transportAttemptMatches: (
    attempt: TransportAttempt,
    scope: {
      readonly authGeneration: number
      readonly projectId: string
      readonly viewerUserId: string | null
    },
  ) => boolean
}

/** 控制器注入依赖（测试用 fake，生产由 session-runtime/use-research-editor 提供）。 */
export interface EditorDeps {
  readonly ref: ResearchSessionRef
  /** 文档实例 writerId；缺省随机生成（刷新/复制标签必须传新值，不继承）。 */
  readonly writerId?: string
  readonly transport: EditorTransport | null
  readonly getRuntimeView: () => EditorRuntimeView
  readonly subscribeRuntime: (listener: () => void) => () => void
  readonly createWriteGuard: (label: string) => SessionWriteGuard
  readonly mutations: EditorMutationFactories
  readonly getCacheScope: () => SessionCacheScope | null
  readonly getCacheAuthority: () => SessionCacheAuthority | null
  readonly storage?: SessionCacheStorage | null
  readonly now?: () => string
  readonly nextMutationId?: () => string
  readonly nextDraftToken?: () => string
}

// ── 纯状态构造与归约 ──

/** 纯状态机的初始输入。 */
export interface EditorInitialInput {
  readonly ref: ResearchSessionRef
  readonly writerId: string
  readonly transportAvailable: boolean
  readonly draftToken?: string
}

/** 编辑器事件（归约函数公开以做纯单测）。 */
export type EditorEvent =
  | { readonly type: 'load/start' }
  | { readonly type: 'load/ready'; readonly projection: ResearchEditorResponseProjection }
  | { readonly type: 'load/unreadable'; readonly warnings: readonly string[]; readonly revision: number }
  | { readonly type: 'load/failure'; readonly failure: EditorSaveFailure }
  | { readonly type: 'draft/text'; readonly text: string; readonly token: string; readonly oversize: boolean }
  | {
      readonly type: 'draft/scope'
      readonly baseScope: WireEditorBaseScope | null
      readonly singleSourceId: string | null
      readonly noteIds: readonly string[]
    }
  | {
      readonly type: 'draft/anchor'
      readonly chatAnchor: WireChatAnchor | null
      readonly readerAnchor: WireReaderAnchor | null
    }
  | { readonly type: 'draft/positionUnavailable' }
  | { readonly type: 'draft/readback'; readonly record: SessionDraftRecord }
  | { readonly type: 'save/dispatched' }
  | {
      readonly type: 'save/success'
      readonly revision: number
      readonly intentHash: string
      readonly savedAt: string
      readonly localVersion: number
    }
  | { readonly type: 'save/superseded'; readonly revision: number; readonly intentHash: string }
  | { readonly type: 'save/conflict'; readonly kind: 'revision' | 'mutation'; readonly failure: EditorSaveFailure }
  | { readonly type: 'save/blocked'; readonly failure: EditorSaveFailure }
  | { readonly type: 'save/readonly'; readonly failure: EditorSaveFailure }
  | { readonly type: 'save/unsynced'; readonly failure: EditorSaveFailure }
  | { readonly type: 'save/unconfirmed'; readonly failure: EditorSaveFailure }
  | { readonly type: 'clear/applied'; readonly revision: number; readonly intentHash: string; readonly savedAt: string; readonly token: string }
  | { readonly type: 'token/consumed'; readonly token: string }
  | { readonly type: 'holds/update'; readonly holds: readonly EditorHold[] }
  | { readonly type: 'restore/candidates'; readonly candidates: readonly EditorRestoreCandidate[] }
  | { readonly type: 'conflict/adoptServer'; readonly projection: ResearchEditorResponseProjection }
  | { readonly type: 'conflict/clear' }
  | {
      readonly type: 'conflict/refreshRevision'
      readonly revision: number
      readonly intentHash: string | null
      readonly warnings: readonly string[]
    }
  | { readonly type: 'invalidate' }

/** `dirty` 的统一推导：本地版本领先于已确认版本。 */
const isDirty = (state: EditorSnapshot): boolean => state.localVersion > state.confirmedLocalVersion

/** 创建初始纯状态（不触达任何存储/网络）。 */
export function createEditorState(initial: EditorInitialInput): EditorSnapshot {
  const isGlobal = initial.ref.kind === 'global'
  return {
    ref: initial.ref,
    phase: 'idle',
    loading: false,
    revision: 0,
    intentHash: null,
    draftText: '',
    draftToken: initial.draftToken ?? createDraftToken(),
    consumedToken: null,
    baseScope: isGlobal ? { mode: 'all', sourceIds: [], singleSourceId: null } : null,
    singleSourceId: null,
    noteIds: [],
    chatAnchor: null,
    readerAnchor: null,
    dirty: false,
    saving: false,
    readOnly: false,
    blocked: false,
    unreadable: false,
    warnings: [],
    conflict: null,
    saveFailure: null,
    unsynced: false,
    localVersion: 0,
    confirmedLocalVersion: 0,
    writerId: initial.writerId,
    lastSavedAt: null,
    pendingMutations: 0,
    restoreCandidates: [],
    holds: [],
    transportAvailable: initial.transportAvailable,
    positionUnavailable: false,
    invalidated: false,
    oversize: false,
  }
}

/** 完整采用服务端投影（conflict 的“采用服务端”与 clean 加载共用）。 */
const adoptServer = (state: EditorSnapshot, projection: ResearchEditorResponseProjection): EditorSnapshot => {
  const wire = projection.editorState
  if (wire === null) {
    // 理论上调用方不会对 unreadable 采用；降级为只读，避免把空状态写回。
    return {
      ...state,
      phase: 'readonly',
      loading: false,
      saving: false,
      readOnly: true,
      unreadable: true,
      blocked: true,
      revision: projection.editorRevision,
      intentHash: null,
      warnings: projection.stateWarnings,
      conflict: null,
    }
  }
  return {
    ...state,
    phase: 'ready',
    loading: false,
    saving: false,
    revision: projection.editorRevision,
    intentHash: projection.editorIntentHash,
    draftText: wire.draft.text,
    draftToken: wire.draft.token,
    baseScope: wire.baseScope,
    singleSourceId: wire.singleSourceId,
    noteIds: wire.noteIds,
    chatAnchor: wire.chatAnchor,
    readerAnchor: wire.readerAnchor,
    readOnly: false,
    unreadable: false,
    blocked: false,
    warnings: projection.stateWarnings,
    conflict: null,
    saveFailure: null,
    unsynced: false,
    localVersion: state.localVersion,
    confirmedLocalVersion: state.localVersion,
    dirty: false,
    positionUnavailable:
      state.positionUnavailable || projection.stateWarnings.includes('position_unavailable'),
  }
}

/**
 * 纯归约函数：全部状态转移集中于此，控制器只负责调度与 I/O。
 * 不变量：ACK 只推进 revision/intent_hash（与它确认的 localVersion），绝不覆盖较新
 * 的 T2 可见 shadow。
 */
export function reduceEditor(state: EditorSnapshot, event: EditorEvent): EditorSnapshot {
  switch (event.type) {
    case 'load/start':
      return { ...state, phase: 'loading', loading: true, saveFailure: null }
    case 'load/ready': {
      if (state.saving) {
        // 保存未结算前 GET 不得覆盖 shadow（DESIGN §5.5）。
        return { ...state, loading: false }
      }
      if (isDirty(state) && event.projection.editorRevision !== state.revision) {
        // GET 与本地未同步稿竞态：不自动覆盖本机（DESIGN §5.5）。
        return {
          ...state,
          phase: 'conflict',
          loading: false,
          conflict: { kind: 'revision' },
          warnings: event.projection.stateWarnings,
        }
      }
      if (isDirty(state)) {
        // 同 revision：只采纳服务端已确认元数据，保留本机 shadow 继续 autosave。
        return {
          ...state,
          phase: 'ready',
          loading: false,
          revision: event.projection.editorRevision,
          intentHash: event.projection.editorIntentHash,
          warnings: event.projection.stateWarnings,
          conflict: null,
          saveFailure: null,
          blocked: false,
          positionUnavailable:
            state.positionUnavailable || event.projection.stateWarnings.includes('position_unavailable'),
        }
      }
      return adoptServer(state, event.projection)
    }
    case 'load/unreadable':
      // editor_state_unreadable：只读展示/本机稿可读，不把默认范围写回、不启用 autosave。
      return {
        ...state,
        phase: 'readonly',
        loading: false,
        saving: false,
        readOnly: true,
        unreadable: true,
        blocked: true,
        revision: event.revision,
        intentHash: null,
        warnings: event.warnings,
        conflict: null,
      }
    case 'load/failure':
      return {
        ...state,
        phase: event.failure.retryable ? 'error' : 'blocked',
        loading: false,
        saving: false,
        saveFailure: event.failure,
        blocked: !event.failure.retryable,
      }
    case 'draft/text': {
      if (event.text === state.draftText) return state
      const next: EditorSnapshot = {
        ...state,
        draftText: event.text,
        draftToken: event.token,
        localVersion: state.localVersion + 1,
        blocked: false,
        oversize: event.oversize,
        saveFailure: null,
        positionUnavailable: state.positionUnavailable,
      }
      return { ...next, dirty: isDirty(next), phase: state.saving ? 'saving' : 'ready' }
    }
    case 'draft/scope': {
      const next: EditorSnapshot = {
        ...state,
        baseScope: event.baseScope,
        singleSourceId: event.singleSourceId,
        noteIds: event.noteIds,
        localVersion: state.localVersion + 1,
        blocked: false,
      }
      return { ...next, dirty: isDirty(next), phase: state.saving ? 'saving' : 'ready' }
    }
    case 'draft/anchor': {
      if (
        sameAnchor(state.chatAnchor, event.chatAnchor) &&
        sameReaderAnchor(state.readerAnchor, event.readerAnchor)
      ) {
        return state
      }
      const next: EditorSnapshot = {
        ...state,
        chatAnchor: event.chatAnchor,
        readerAnchor: event.readerAnchor,
        localVersion: state.localVersion + 1,
      }
      // 位置变化不生成新 intent（token 不变），但本机仍是 dirty。
      return { ...next, dirty: isDirty(next), phase: state.saving ? 'saving' : 'ready' }
    }
    case 'draft/positionUnavailable':
      return {
        ...state,
        positionUnavailable: true,
        warnings: state.warnings.includes('position_unavailable')
          ? state.warnings
          : [...state.warnings, 'position_unavailable'],
        chatAnchor: null,
        readerAnchor: null,
      }
    case 'draft/readback': {
      const localVersion = Math.max(state.localVersion, event.record.localVersion)
      const next: EditorSnapshot = {
        ...state,
        draftText: event.record.text,
        draftToken: event.record.token,
        baseScope: event.record.baseScope,
        singleSourceId: event.record.singleSourceId,
        noteIds: event.record.noteIds,
        localVersion,
        oversize: measureDraftBytes(event.record.text) > EDITOR_TEXT_MAX_BYTES,
      }
      return { ...next, dirty: isDirty(next) }
    }
    case 'save/dispatched':
      return { ...state, saving: true, pendingMutations: state.pendingMutations + 1, phase: 'saving' }
    case 'save/success': {
      const confirmedLocalVersion = event.localVersion
      const next: EditorSnapshot = {
        ...state,
        revision: event.revision,
        intentHash: event.intentHash,
        lastSavedAt: event.savedAt,
        saving: false,
        pendingMutations: Math.max(0, state.pendingMutations - 1),
        conflict: null,
        saveFailure: null,
        unsynced: false,
        confirmedLocalVersion,
        phase: 'ready',
      }
      return { ...next, dirty: isDirty(next) }
    }
    case 'save/superseded':
      // 清稿 ACK 晚于新输入：只推进 revision/hash，不覆盖当前 shadow/token。
      return {
        ...state,
        revision: event.revision,
        intentHash: event.intentHash,
        saving: false,
        pendingMutations: Math.max(0, state.pendingMutations - 1),
        phase: 'ready',
        dirty: isDirty(state),
      }
    case 'clear/applied':
      return {
        ...state,
        draftText: '',
        draftToken: event.token,
        localVersion: state.localVersion,
        confirmedLocalVersion: state.localVersion,
        dirty: false,
        revision: event.revision,
        intentHash: event.intentHash,
        lastSavedAt: event.savedAt,
        saving: false,
        pendingMutations: Math.max(0, state.pendingMutations - 1),
        phase: 'ready',
      }
    case 'save/conflict':
      return {
        ...state,
        phase: 'conflict',
        saving: false,
        pendingMutations: Math.max(0, state.pendingMutations - 1),
        conflict: { kind: event.kind },
        saveFailure: event.failure,
        dirty: isDirty(state),
      }
    case 'save/blocked':
      return {
        ...state,
        phase: 'blocked',
        saving: false,
        pendingMutations: Math.max(0, state.pendingMutations - 1),
        blocked: true,
        saveFailure: event.failure,
      }
    case 'save/readonly':
      return {
        ...state,
        phase: 'readonly',
        saving: false,
        pendingMutations: Math.max(0, state.pendingMutations - 1),
        readOnly: true,
        saveFailure: event.failure,
      }
    case 'save/unsynced':
      return {
        ...state,
        phase: 'ready',
        saving: false,
        pendingMutations: Math.max(0, state.pendingMutations - 1),
        unsynced: true,
        saveFailure: event.failure,
        dirty: isDirty(state),
      }
    case 'save/unconfirmed':
      // 已派发但结果未知：保留 active 以原 body 重放，计入未决 mutation。
      return {
        ...state,
        phase: 'error',
        saving: false,
        unsynced: true,
        saveFailure: event.failure,
        dirty: isDirty(state),
      }
    case 'token/consumed':
      return { ...state, consumedToken: event.token }
    case 'holds/update':
      return { ...state, holds: event.holds }
    case 'restore/candidates':
      return { ...state, restoreCandidates: event.candidates }
    case 'conflict/adoptServer': {
      const adopted = adoptServer(state, event.projection)
      return { ...adopted, conflict: null, saveFailure: null, dirty: false }
    }
    case 'conflict/clear':
      return { ...state, conflict: null, phase: state.readOnly ? 'readonly' : 'ready' }
    case 'conflict/refreshRevision':
      // 冲突恢复前先受守卫读取最新 revision；不覆盖本机 shadow（review P2 #10）。
      return {
        ...state,
        revision: event.revision,
        intentHash: event.intentHash,
        warnings: event.warnings,
      }
    case 'invalidate':
      // 认证失效后不得继续暴露本机私有草稿（review P1 #11）：清空敏感内存，
      // 只保留 ref/代际相关元数据供上层判断。
      return {
        ...state,
        invalidated: true,
        phase: 'readonly',
        readOnly: true,
        blocked: true,
        saving: false,
        loading: false,
        draftText: '',
        draftToken: '',
        consumedToken: null,
        baseScope: null,
        singleSourceId: null,
        noteIds: [],
        chatAnchor: null,
        readerAnchor: null,
        dirty: false,
        oversize: false,
        conflict: null,
        saveFailure: null,
        unsynced: false,
        restoreCandidates: [],
        holds: [],
        pendingMutations: 0,
      }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function sameAnchor(left: WireChatAnchor | null, right: WireChatAnchor | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return (
    left.messageId === right.messageId &&
    left.offsetPx === right.offsetPx &&
    left.followTail === right.followTail
  )
}

function sameReaderAnchor(left: WireReaderAnchor | null, right: WireReaderAnchor | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return (
    left.sourceId === right.sourceId &&
    left.documentId === right.documentId &&
    left.documentVersion === right.documentVersion &&
    left.chunkId === right.chunkId &&
    left.chunkOrdinal === right.chunkOrdinal &&
    left.contentHash === right.contentHash &&
    left.pageIdx === right.pageIdx &&
    left.offsetPx === right.offsetPx
  )
}

// ── wire 转换 ──

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/** 冻结请求体快照：重试只读冻结记录，调用方数组后续变化不得影响重放（review P1 #3）。 */
export function freezeEditorSaveRequest(body: EditorSaveRequestWire): EditorSaveRequestWire {
  return deepFreeze(body)
}

/** 本地快照 → `editor_state` wire JSON（02 §4，snake_case 原样；数组为独立拷贝）。 */
export function editorStateToWire(state: EditorSnapshot): EditorStateWire {
  return {
    schema_version: 1,
    base_scope:
      state.baseScope === null
        ? null
        : {
            mode: state.baseScope.mode,
            source_ids: [...state.baseScope.sourceIds],
            single_source_id: null,
          },
    single_source_id: state.singleSourceId,
    note_ids: [...state.noteIds],
    draft: { text: state.draftText, token: state.draftToken },
    chat_anchor:
      state.chatAnchor === null
        ? null
        : {
            message_id: state.chatAnchor.messageId,
            offset_px: state.chatAnchor.offsetPx,
            follow_tail: state.chatAnchor.followTail,
          },
    reader_anchor:
      state.readerAnchor === null
        ? null
        : {
            source_id: state.readerAnchor.sourceId,
            document_id: state.readerAnchor.documentId,
            document_version: state.readerAnchor.documentVersion,
            format: state.readerAnchor.format,
            chunk_id: state.readerAnchor.chunkId,
            chunk_ordinal: state.readerAnchor.chunkOrdinal,
            content_hash: state.readerAnchor.contentHash,
            page_idx: state.readerAnchor.pageIdx,
            offset_px: state.readerAnchor.offsetPx,
          },
  }
}

/** 构造 `editor_save_request`（expected_revision 只取服务端已确认 revision）。 */
export function buildSaveRequestWire(state: EditorSnapshot, mutationId: string): EditorSaveRequestWire {
  return freezeEditorSaveRequest({
    expected_revision: state.revision,
    mutation_id: mutationId,
    editor_state: editorStateToWire(state),
  })
}

/** 清稿请求体：新 token 在**首次构造清稿 PUT** 时生成，body 冻结后重试复用。 */
export function buildClearRequestWire(
  state: EditorSnapshot,
  mutationId: string,
  token: string,
): EditorSaveRequestWire {
  return freezeEditorSaveRequest({
    expected_revision: state.revision,
    mutation_id: mutationId,
    editor_state: { ...editorStateToWire(state), draft: { text: '', token } },
  })
}

// ── 范围编辑与提交投影（PR-5a 复用） ──

export interface DraftScopeState {
  readonly baseScope: WireEditorBaseScope | null
  readonly singleSourceId: string | null
  readonly noteIds: readonly string[]
}

/** 应用本地范围编辑（DESIGN §5.3；wire 编码唯一入口是 editorStateToWire）。 */
export function applyScopeEdit(current: DraftScopeState, edit: ScopeEdit): DraftScopeState {
  switch (edit.mode) {
    case 'all':
      return {
        baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
        singleSourceId: null,
        noteIds: current.noteIds,
      }
    case 'selected':
      return {
        baseScope: {
          mode: 'selected',
          sourceIds: [...edit.sourceIds],
          singleSourceId: null,
        },
        singleSourceId: null,
        noteIds: edit.noteIds ?? current.noteIds,
      }
    case 'single':
      return { ...current, singleSourceId: edit.sourceId }
    case 'note':
      return { ...current, noteIds: [...edit.noteIds] }
    default: {
      const exhaustive: never = edit
      return exhaustive
    }
  }
}

/** 提交执行范围投影（§5.3：all/selected + 临时单篇；PR-5a 组提交用）。 */
export function projectExecutionScope(state: EditorSnapshot): {
  readonly mode: 'all' | 'selected'
  readonly sourceIds: readonly string[]
  readonly singleSourceId: string | null
} {
  const baseMode = state.baseScope?.mode ?? 'all'
  const baseSourceIds = state.baseScope?.sourceIds ?? []
  return {
    mode: baseMode,
    sourceIds: state.singleSourceId === null ? baseSourceIds : [state.singleSourceId],
    singleSourceId: state.singleSourceId,
  }
}

// ── 失败分类（DESIGN §5.5、02 §7） ──

interface AxiosLikeError {
  readonly response?: { readonly status?: number; readonly data?: unknown }
}

/** 分类结果：处理路径 + 是否可自动重试。 */
export interface EditorFailureClassification extends EditorSaveFailure {
  readonly handling: 'retry' | 'conflict' | 'readonly' | 'blocked' | 'error'
}

/** 把传输异常映射为稳定失败投影（不依赖文案）。 */
export function classifySaveFailure(error: unknown): EditorFailureClassification {
  const status = readStatus(error)
  const code = readErrorCode(error)
  if (code === 'editor_revision_conflict') {
    return { code, retryable: false, handling: 'conflict' }
  }
  if (code === 'editor_mutation_conflict') {
    return { code, retryable: false, handling: 'conflict' }
  }
  if (code === 'editor_revision_exhausted' || code === 'editor_state_unreadable') {
    return { code, retryable: false, handling: 'readonly' }
  }
  if (
    code === 'editor_state_too_large' ||
    code === 'editor_state_invalid' ||
    code === 'session_context_changed' ||
    code === 'session_contract_unsupported'
  ) {
    return { code, retryable: false, handling: 'blocked' }
  }
  if (
    code === 'session_not_found' ||
    code === 'chat_owner_required' ||
    code === 'history_egress_not_authorized'
  ) {
    return { code, retryable: false, handling: 'error' }
  }
  if (status === 401 || status === 403) {
    return { code: code ?? 'unauthenticated', retryable: false, handling: 'error' }
  }
  if (status === 409) {
    return { code: code ?? 'editor_revision_conflict', retryable: false, handling: 'conflict' }
  }
  if (status === 413) {
    return { code: 'editor_state_too_large', retryable: false, handling: 'blocked' }
  }
  if (status === 422) {
    return { code: code ?? 'editor_state_invalid', retryable: false, handling: 'blocked' }
  }
  if (status === undefined || status >= 500) {
    return { code: code ?? 'session_store_unavailable', retryable: true, handling: 'retry' }
  }
  // 其余 4xx：不自动重试，保留本机稿等待显式操作。
  return { code: code ?? `http_${status}`, retryable: false, handling: 'blocked' }
}

function readStatus(error: unknown): number | undefined {
  const candidate = error as AxiosLikeError | null
  const status = candidate?.response?.status
  return typeof status === 'number' ? status : undefined
}

function readErrorCode(error: unknown): string | null {
  const candidate = error as AxiosLikeError | null
  const data = candidate?.response?.data
  if (data !== null && typeof data === 'object' && data !== undefined && 'detail' in data) {
    const detail = (data as { detail?: unknown }).detail
    if (detail !== null && typeof detail === 'object' && detail !== undefined && 'code' in detail) {
      const code = (detail as { code?: unknown }).code
      if (typeof code === 'string' && code.length > 0 && code.length <= 256) return code
    }
  }
  return null
}

// ── 控制器 ──

/** 提交/清稿可用性判定（PR-5a 发送前闸门；避免已消费 token 被静默复用）。 */
export interface SubmissionReadiness {
  readonly allowed: boolean
  readonly reason:
    | 'not_loaded'
    | 'dirty'
    | 'saving'
    | 'blocked'
    | 'conflict'
    | 'readonly'
    | 'invalidated'
    | 'no_transport'
    | 'consumed'
    | 'not_ready'
    | null
}

/** 控制器对外 API（EditorHandle + PR-3 生命周期方法）。 */
export interface EditorController {
  getSnapshot(): EditorSnapshot
  subscribe(listener: () => void): () => void
  load(): Promise<void>
  setDraftText(text: string): void
  setScope(edit: ScopeEdit): void
  setChatAnchor(anchor: WireChatAnchor | null): void
  setReaderAnchor(anchor: WireReaderAnchor | null): void
  flush(reason: EditorFlushReason): Promise<SaveOutcome>
  hold(reason: EditorHold['reason'], operationId: string): void
  release(operationId: string): void
  retrySave(): Promise<SaveOutcome>
  adoptServerVersion(): Promise<SaveOutcome>
  saveLocalOverServer(): Promise<SaveOutcome>
  clearAfterSubmission(receipt: AcceptedReceipt, operationId: string): Promise<ClearOutcome>
  markTokenConsumed(token: string): void
  canSubmit(): SubmissionReadiness
  restoreDraft(writerId: string): void
  refreshDraftCandidates(): void
  /** 认证代际/viewer 失效：停止一切写入并作废本地状态。 */
  invalidate(reason: 'logout' | 'viewer-change'): void
  /** 是否仍有未结算的 mutation（在途保存/排队保存）；供 runtime 决定是否移交新消费者（review3 N5）。 */
  hasPendingWork(): boolean
  /** 文档实例卸载/切换：尽力写本机草稿后停止（不写服务端、不发 cancel）。 */
  releaseDocument(): void
  /** 页面隐藏/离开前同步写本机草稿（不写服务端，review P2 #12）。 */
  persistLocal(): void
}

type AnyOutcome = SaveOutcome | ClearOutcome

interface ActiveMutation {
  readonly record: MutationRecord
  readonly body: EditorSaveRequestWire
  attempt: TransportAttempt
  readonly localVersion: number
  readonly kind: 'save' | 'clear'
  readonly operationId: string | null
  readonly clearToken: string | null
  readonly explicit: boolean
  readonly resolve: (outcome: AnyOutcome) => void
  retries: number
  /** 已派发但结果未知（保留以便原 body 重放）。 */
  unconfirmed: boolean
  /** 当前 attempt 已发出 PUT、尚未结算；手动 retry 不得在此时再发一个并发 PUT。 */
  inFlight: boolean
}

interface QueuedRequest {
  readonly kind: 'save' | 'clear'
  readonly operationId: string | null
  readonly explicit: boolean
  /** 清稿取消规则：首次派发前若本机版本前进则取消（从未派发）。 */
  readonly capturedLocalVersion: number
  /** 显式 flush 在入队时捕获的不可变提交快照（review P1 #6）。 */
  readonly frozenEditorState: EditorStateWire | null
  /** 入队时的本地版本：结算必须用它，不能用结算时的可见版本（二次 review P1）。 */
  readonly localVersion: number
  readonly resolve: (outcome: AnyOutcome) => void
}

const isTokenShaped = (value: string): boolean => DRAFT_TOKEN_PATTERN.test(value)

/** 创建编辑器控制器（全部副作用经 deps 注入，便于 fake timers 测试）。 */
export function createEditorController(deps: EditorDeps): EditorController {
  const writerId = deps.writerId ?? randomId('w')
  const now = deps.now ?? (() => new Date().toISOString())
  const nextMutationId = deps.nextMutationId ?? createMutationId
  const nextDraftToken = deps.nextDraftToken ?? createDraftToken
  const guard = deps.createWriteGuard('editor')
  const listeners = new Set<() => void>()

  let state: EditorSnapshot = createEditorState({
    ref: deps.ref,
    writerId,
    transportAvailable: deps.transport !== null,
  })
  let active: ActiveMutation | null = null
  let queued: QueuedRequest | null = null
  let pendingAutoText = false
  let pendingAutoPosition = false
  let pendingLoad = false
  let loading = false
  let loaded = false
  let released = false
  let replaying = false
  let replayPending = false
  let lastSeenGeneration = deps.getRuntimeView().authGeneration
  let lastSeenViewer = deps.getRuntimeView().viewerUserId
  let lastSeenProject = deps.getRuntimeView().projectId
  let loadingGeneration: number | null = null
  let textTimer: ReturnType<typeof setTimeout> | null = null
  let positionTimer: ReturnType<typeof setTimeout> | null = null
  let localTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 退避定时器已到点、但因 runtime 暂不可用（masked/未 ready）而暂停的自动重试（review4 F1）。 */
  let retryPaused = false
  let manualReplayRequested = false
  const unsubscribeRuntime = deps.subscribeRuntime(() => onRuntimeChange())

  // ── 快照/事件 ──

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const reduce = (event: EditorEvent): void => {
    state = reduceEditor(state, event)
    emit()
  }

  // ── 本机草稿 ──

  const cacheOptions = (): { storage: SessionCacheStorage | null } | undefined =>
    deps.storage !== undefined ? { storage: deps.storage } : undefined

  const writeLocalDraft = (): void => {
    if (state.invalidated || released) return
    const scope = deps.getCacheScope()
    const authority = deps.getCacheAuthority()
    if (scope === null || authority === null) return
    const record: SessionDraftRecord = {
      version: 1,
      text: state.draftText,
      token: state.draftToken,
      baseScope: state.baseScope,
      singleSourceId: state.singleSourceId,
      noteIds: state.noteIds,
      localVersion: state.localVersion,
      baseRevision: state.revision,
      savedAt: now(),
      dirty: isDirty(state),
    }
    writeDraft(scope, state.ref, writerId, record, cacheOptions())
  }

  const removeOwnDraftIfClean = (): void => {
    if (isDirty(state)) {
      writeLocalDraft()
      return
    }
    const scope = deps.getCacheScope()
    if (scope === null) return
    removeDraftIfVersion(
      scope,
      state.ref,
      writerId,
      { localVersion: state.localVersion, token: state.draftToken },
      cacheOptions(),
    )
  }

  const readOwnDraft = (): SessionDraftRecord | null => {
    const scope = deps.getCacheScope()
    const authority = deps.getCacheAuthority()
    if (scope === null || authority === null) return null
    return readDraft(scope, authority, state.ref, writerId, cacheOptions())
  }

  /** GET 失败/不可解析时仍读回本 writer 草稿并刷新恢复候选（§5.2；不删指针）。 */
  const recoverLocalDraft = (): void => {
    const record = readOwnDraft()
    if (record !== null) reduce({ type: 'draft/readback', record })
    refreshDraftCandidates()
  }

  const scheduleLocalDraft = (): void => {
    if (localTimer !== null) clearTimeout(localTimer)
    localTimer = setTimeout(() => {
      localTimer = null
      writeLocalDraft()
    }, EDITOR_LOCAL_MERGE_MS)
  }

  const refreshDraftCandidates = (): void => {
    const scope = deps.getCacheScope()
    const authority = deps.getCacheAuthority()
    if (scope === null || authority === null) return
    const branches: readonly SessionDraftBranch[] = listDraftBranches(
      scope,
      authority,
      state.ref,
      cacheOptions(),
    )
    const candidates: EditorRestoreCandidate[] = branches
      .filter((branch) => branch.writerId !== writerId)
      .map((branch) => ({
        writerId: branch.writerId,
        localVersion: branch.record.localVersion,
        baseRevision: branch.record.baseRevision,
        savedAt: branch.record.savedAt,
        dirty: branch.record.dirty,
      }))
    reduce({ type: 'restore/candidates', candidates })
  }

  // ── 定时器 ──

  const clearSaveTimers = (): void => {
    if (textTimer !== null) clearTimeout(textTimer)
    if (positionTimer !== null) clearTimeout(positionTimer)
    textTimer = null
    positionTimer = null
  }

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
  }

  const scheduleTextSave = (): void => {
    if (textTimer !== null) clearTimeout(textTimer)
    textTimer = setTimeout(() => {
      textTimer = null
      if (state.invalidated || released) return
      pendingAutoText = true
      dispatchAutoIfPossible()
    }, EDITOR_TEXT_DEBOUNCE_MS)
  }

  const schedulePositionSave = (): void => {
    if (state.positionUnavailable) return
    if (positionTimer !== null) clearTimeout(positionTimer)
    positionTimer = setTimeout(() => {
      positionTimer = null
      if (state.invalidated || released) return
      pendingAutoPosition = true
      dispatchAutoIfPossible()
    }, EDITOR_POSITION_IDLE_MS)
  }

  // ── 闸门/工具 ──

  const runtimeView = (): EditorRuntimeView => deps.getRuntimeView()

  const transportTarget = (): {
    authGeneration: number
    projectId: string
    viewerUserId: string | null
  } => {
    const runtime = runtimeView()
    return {
      authGeneration: runtime.authGeneration,
      projectId: runtime.projectId,
      viewerUserId: runtime.viewerUserId,
    }
  }

  const canWrite = (): boolean => {
    const runtime = runtimeView()
    return (
      !state.invalidated &&
      !released &&
      !guard.isInvalidated() &&
      deps.transport !== null &&
      runtime.ready &&
      runtime.editorReady !== false &&
      !state.readOnly &&
      !state.blocked &&
      state.conflict === null
    )
  }

  const hasSubmitHold = (): boolean => state.holds.some((hold) => hold.reason === 'submit')
  const hasConflictHold = (): boolean => state.holds.some((hold) => hold.reason === 'conflict')

  const autoDispatchAllowed = (): boolean =>
    canWrite() && loaded && !hasSubmitHold() && !hasConflictHold() && !state.saving && !state.oversize

  const makeResolver = (): {
    promise: Promise<AnyOutcome>
    resolve: (outcome: AnyOutcome) => void
  } => {
    let resolveFn: (outcome: AnyOutcome) => void = () => {}
    const promise = new Promise<AnyOutcome>((resolve) => {
      resolveFn = resolve
    })
    return { promise, resolve: resolveFn }
  }

  const sameGeneration = (attempt: TransportAttempt): boolean =>
    runtimeView().ready && deps.mutations.transportAttemptMatches(attempt, transportTarget())

  // ── 派发与结算 ──

  /** 手动 retry 遇到在途 attempt 时先记账，等该 attempt 结算后原样重放，禁止并发 PUT（review3 P1）。 */
  const maybeManualReplay = (current: ActiveMutation): void => {
    if (!manualReplayRequested) return
    if (active === null) {
      // 已在途请求成功结算：手动重放意图由后续 dirty autosave 承接。
      manualReplayRequested = false
      return
    }
    if (active !== current || !active.unconfirmed || active.inFlight || replaying) return
    manualReplayRequested = false
    clearRetryTimer()
    replayActive(active)
  }

  const performPut = async (current: ActiveMutation, attempt: TransportAttempt): Promise<void> => {
    if (state.invalidated || released || guard.isInvalidated() || deps.transport === null) return
    current.inFlight = true
    try {
      let raw: unknown
      try {
        const result = await guard.run(() => deps.transport!.putEditorState(current.body))
        if (result.status === 'stale') return
        raw = await result.value
      } catch (error) {
        if (active !== current) return
        if (attempt !== current.attempt) return
        if (!sameGeneration(attempt)) {
          // 旧代/旧 viewer 的迟到失败：不得把旧错误写进新代状态，保留未确认等待重放。
          current.unconfirmed = true
          return
        }
        handleFailure(current, classifySaveFailure(error))
        return
      }
      if (active !== current) return
      if (attempt !== current.attempt) return
      if (!sameGeneration(attempt)) {
        // 旧代/旧 viewer 的迟到 ACK：丢弃；replay/ready 事件负责用原 mutation 原 body 重放。
        current.unconfirmed = true
        return
      }
      const runtime = runtimeView()
      if (runtime.disposed || runtime.viewerChanged) {
        invalidateIntent('viewer-change')
        return
      }
      if (current.kind === 'clear') {
        handleClearResponse(current, raw)
        return
      }
      handleSaveResponse(current, raw)
    } finally {
      if (attempt === current.attempt) current.inFlight = false
      maybeManualReplay(current)
    }
  }

  const settleInFlight = (current: ActiveMutation, attempt: TransportAttempt): void => {
    if (current.attempt === attempt) current.inFlight = false
    maybeManualReplay(current)
  }

  const handleSaveResponse = (current: ActiveMutation, raw: unknown): void => {
    if (!sameGeneration(current.attempt)) {
      // 旧代/旧 viewer 的迟到 ACK：丢弃，保留 mutation 待代际就绪后原样重放。
      current.unconfirmed = true
      // 代际已就绪时立即重放（同 viewer refresh 场景）；未就绪则等 ready 事件。
      replayActive(current)
      return
    }
    const parsed = parseSaveResponse(raw)
    if (!parsed.ok || sessionKey(parsed.value.ref) !== sessionKey(state.ref) || parsed.value.mutationId !== current.record.mutationId) {
      // ACK 缺 mutation_id 回声/字段非法：协议错误，必须保留 dirty 与未决 mutation。
      current.unconfirmed = true
      reduce({ type: 'save/unconfirmed', failure: { code: 'invalid_response', retryable: false } })
      current.resolve('invalid')
      return
    }
    if (parsed.value.editorRevision < state.revision) {
      // ACK 回退 revision：旧/乱序回执，按协议错误保留 dirty 与未决记录（review P2 #13）。
      current.unconfirmed = true
      reduce({ type: 'save/unconfirmed', failure: { code: 'invalid_response', retryable: false } })
      current.resolve('invalid')
      return
    }
    active = null
    const projection = parsed.value
    // 重放/首次保存的成功 ACK 已证明当前代际的 revision 权威，后续 autosave 不得
    // 因跨代 loaded=false 而静默停摆（同 viewer refresh 的接管路径）。
    loaded = true
    reduce({
      type: 'save/success',
      revision: projection.editorRevision,
      intentHash: projection.editorIntentHash,
      savedAt: projection.savedAt,
      localVersion: current.localVersion,
    })
    removeOwnDraftIfClean()
    current.resolve('saved')
    afterSettle()
  }

  const handleClearResponse = (current: ActiveMutation, raw: unknown): void => {
    if (!sameGeneration(current.attempt)) {
      current.unconfirmed = true
      replayActive(current)
      return
    }
    const parsed = parseSaveResponse(raw)
    if (!parsed.ok || sessionKey(parsed.value.ref) !== sessionKey(state.ref) || parsed.value.mutationId !== current.record.mutationId) {
      current.unconfirmed = true
      reduce({ type: 'save/unconfirmed', failure: { code: 'invalid_response', retryable: false } })
      if (current.operationId !== null) releaseHold(current.operationId)
      current.resolve('invalid')
      return
    }
    if (parsed.value.editorRevision < state.revision) {
      current.unconfirmed = true
      reduce({ type: 'save/unconfirmed', failure: { code: 'invalid_response', retryable: false } })
      if (current.operationId !== null) releaseHold(current.operationId)
      current.resolve('invalid')
      return
    }
    const projection = parsed.value
    const stillSameDraft = state.localVersion === current.localVersion
    active = null
    loaded = true
    if (stillSameDraft) {
      const previousToken = state.draftToken
      const previousLocalVersion = state.localVersion
      reduce({
        type: 'clear/applied',
        revision: projection.editorRevision,
        intentHash: projection.editorIntentHash,
        savedAt: projection.savedAt,
        token: current.clearToken ?? current.body.editor_state.draft.token,
      })
      // 清稿 ACK 后按“派发前旧 token + 旧版本”删除本 writer 分支，
      // 用新 token 条件删除会因磁盘仍是旧 token 而失败（二次 review N11）。
      const clearScope = deps.getCacheScope()
      if (clearScope !== null) {
        removeDraftIfVersion(
          clearScope,
          state.ref,
          writerId,
          { localVersion: previousLocalVersion, token: previousToken },
          cacheOptions(),
        )
      }
      if (isDirty(state)) writeLocalDraft()
    } else {
      reduce({
        type: 'save/superseded',
        revision: projection.editorRevision,
        intentHash: projection.editorIntentHash,
      })
      writeLocalDraft()
    }
    if (current.operationId !== null) releaseHold(current.operationId)
    current.resolve(stillSameDraft ? 'cleared' : 'superseded')
    afterSettle()
  }

  const handleFailure = (current: ActiveMutation, failure: EditorFailureClassification): void => {
    if (failure.handling === 'retry' && current.retries < EDITOR_MAX_SAVE_ATTEMPTS) {
      current.retries += 1
      current.unconfirmed = true
      const delay = EDITOR_RETRY_DELAYS_MS[Math.min(current.retries - 1, EDITOR_RETRY_DELAYS_MS.length - 1)]
      clearRetryTimer()
      retryPaused = false
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (active !== current || state.invalidated || released) return
        const timerRuntime = runtimeView()
        if (!timerRuntime.ready || timerRuntime.editorReady === false || timerRuntime.disposed || timerRuntime.viewerChanged) {
          // 退避期间认证/能力已变化：暂停自动重试，等待 runtime 恢复后续跑一次（N9/R6/F1）。
          current.unconfirmed = true
          retryPaused = true
          return
        }
        current.attempt = newAttempt(current.record.mutationId)
        void performPut(current, current.attempt)
      }, delay)
      return
    }
    if (failure.handling === 'retry') {
      // 重试耗尽：结果仍无法确认；不自动覆盖本机，保留 active 供显式重放。
      current.unconfirmed = true
      reduce({ type: 'save/unsynced', failure })
      current.resolve('unsynced')
      if (current.kind === 'clear' && current.operationId !== null) releaseHold(current.operationId)
      return
    }
    active = null
    if (failure.handling === 'conflict') {
      reduce({
        type: 'save/conflict',
        kind: failure.code === 'editor_mutation_conflict' ? 'mutation' : 'revision',
        failure,
      })
      current.resolve('conflict')
    } else if (failure.handling === 'readonly') {
      reduce({ type: 'save/readonly', failure })
      current.resolve('readonly')
    } else if (failure.handling === 'blocked') {
      reduce({ type: 'save/blocked', failure })
      current.resolve('blocked')
    } else {
      reduce({ type: 'save/blocked', failure })
      current.resolve('invalid')
    }
    if (current.kind === 'clear' && current.operationId !== null) releaseHold(current.operationId)
    afterSettle()
  }

  const newAttempt = (mutationId: string): TransportAttempt =>
    deps.mutations.createTransportAttempt({
      mutationId,
      scope: transportTarget(),
      sessionKey: sessionKey(state.ref),
      createdAt: now(),
    })

  const dispatchSave = (pending: QueuedRequest): void => {
    if (!canWrite()) {
      pending.resolve('blocked')
      return
    }
    if (state.oversize) {
      // 超限后停止所有保存（含显式 submit/位置保存），但不改写、不截断本机文本。
      reduce({ type: 'save/blocked', failure: { code: 'editor_state_too_large', retryable: false } })
      pending.resolve('blocked')
      return
    }
    if (!isDirty(state) && active === null) {
      pending.resolve('skipped')
      return
    }
    const editorState =
      pending.frozenEditorState !== null ? pending.frozenEditorState : editorStateToWire(state)
    if (measureDraftBytes(JSON.stringify(editorState)) > EDITOR_JSON_MAX_BYTES) {
      // 512KiB 上限：超限禁用保存但不截断本机输入（review P1 #9）。
      reduce({ type: 'save/blocked', failure: { code: 'editor_state_too_large', retryable: false } })
      pending.resolve('blocked')
      return
    }
    const body = freezeEditorSaveRequest({
      expected_revision: state.revision,
      mutation_id: nextMutationId(),
      editor_state: editorState,
    })
    const record = deps.mutations.createMutationRecord({
      mutationId: body.mutation_id,
      kind: 'save',
      ref: state.ref,
      requestBody: body as unknown as Readonly<Record<string, unknown>>,
      baseRevision: state.revision,
      draftToken: state.draftToken,
      idempotencyKey: null,
      createdAt: now(),
    })
    const current: ActiveMutation = {
      record,
      body,
      attempt: newAttempt(record.mutationId),
      // 普通排队 flush 的 body 在派发时按最新快照生成，ACK 也必须按最新 localVersion 结算；
      // 只有显式 submit 使用入队时冻结的版本（N1）。
      localVersion: pending.frozenEditorState !== null ? pending.localVersion : state.localVersion,
      kind: 'save',
      operationId: pending.operationId,
      clearToken: null,
      explicit: pending.explicit,
      resolve: pending.resolve,
      retries: 0,
      unconfirmed: false,
      inFlight: false,
    }
    active = current
    reduce({ type: 'save/dispatched' })
    void performPut(current, current.attempt)
  }

  const dispatchClear = (pending: QueuedRequest): void => {
    if (pending.capturedLocalVersion !== state.localVersion) {
      // 首次派发前有新输入：取消排队中的清稿（未发任何请求、不删 mutation）。
      pending.resolve('cancelled')
      if (pending.operationId !== null) releaseHold(pending.operationId)
      afterSettle()
      return
    }
    if (!canWrite()) {
      pending.resolve('blocked')
      if (pending.operationId !== null) releaseHold(pending.operationId)
      return
    }
    const clearToken = nextDraftToken()
    const body = buildClearRequestWire(state, nextMutationId(), clearToken)
    if (measureDraftBytes(JSON.stringify(body)) > EDITOR_JSON_MAX_BYTES) {
      // R7：512KiB 上限按实际清稿请求体判定（draft.text 已清空），不能用含全文的旧快照误判。
      reduce({ type: 'save/blocked', failure: { code: 'editor_state_too_large', retryable: false } })
      pending.resolve('blocked')
      if (pending.operationId !== null) releaseHold(pending.operationId)
      return
    }
    const record = deps.mutations.createMutationRecord({
      mutationId: body.mutation_id,
      kind: 'save',
      ref: state.ref,
      requestBody: body as unknown as Readonly<Record<string, unknown>>,
      baseRevision: state.revision,
      draftToken: clearToken,
      idempotencyKey: null,
      createdAt: now(),
    })
    const current: ActiveMutation = {
      record,
      body,
      attempt: newAttempt(record.mutationId),
      localVersion: state.localVersion,
      kind: 'clear',
      operationId: pending.operationId,
      clearToken,
      explicit: pending.explicit,
      resolve: pending.resolve,
      retries: 0,
      unconfirmed: false,
      inFlight: false,
    }
    active = current
    reduce({ type: 'save/dispatched' })
    void performPut(current, current.attempt)
  }

  /** 队列替换统一入口（review4 F2）：未派发的 clear 被新请求替换时按取消结算并释放自身 hold。 */
  const replaceQueued = (): void => {
    if (queued === null) return
    const previous = queued
    queued = null
    if (previous.kind === 'clear') {
      if (previous.operationId !== null) releaseHold(previous.operationId)
      previous.resolve('cancelled')
      return
    }
    previous.resolve('queued')
  }

  const dispatchQueued = (): void => {
    if (queued === null || active !== null || state.invalidated) return
    const pending = queued
    queued = null
    if (pending.kind === 'clear') {
      dispatchClear(pending)
      return
    }
    if ((hasSubmitHold() || hasConflictHold()) && !pending.explicit) {
      // 普通 flush 的排队请求同样受 hold 约束（二次 review N7）。
      queued = pending
      return
    }
    dispatchSave(pending)
  }

  const dispatchAutoIfPossible = (): void => {
    if (active !== null || queued !== null) return
    if (!autoDispatchAllowed()) return
    if (!pendingAutoText && !pendingAutoPosition) return
    pendingAutoText = false
    pendingAutoPosition = false
    dispatchSave({
      kind: 'save',
      operationId: null,
      explicit: false,
      frozenEditorState: null,
      capturedLocalVersion: state.localVersion,
      localVersion: state.localVersion,
      resolve: () => {},
    })
  }

  const afterSettle = (): void => {
    if (state.invalidated || released) return
    if (active === null) {
      retryPaused = false
      if (manualReplayRequested) manualReplayRequested = false
    }
    if (active !== null) return
    if (queued !== null) {
      dispatchQueued()
      return
    }
    if (pendingLoad) {
      pendingLoad = false
      void loadInternal()
      return
    }
    if (pendingAutoText || pendingAutoPosition) dispatchAutoIfPossible()
  }

  const replayActive = (current: ActiveMutation): void => {
    const replayRuntime = runtimeView()
    if (state.invalidated || released || !replayRuntime.ready || replayRuntime.editorReady === false) return
    const sameAttemptGeneration =
      replaying &&
      current.attempt.authGeneration === replayRuntime.authGeneration &&
      current.attempt.viewerUserId === replayRuntime.viewerUserId &&
      current.attempt.projectId === replayRuntime.projectId
    if (sameAttemptGeneration) {
      // 同代 replay 仍在途：只记待重放，避免同代重复派发。
      replayPending = true
      return
    }
    // R2：即使是新的代际（或旧 replay promise 永不 settle），也立即用新 attempt 派发
    // 原 mutation/原 body；旧 attempt 结算因 attempt 身份不匹配被丢弃，不阻塞新代。
    replaying = true
    retryPaused = false
    current.attempt = newAttempt(current.record.mutationId)
    current.unconfirmed = false
    void performPut(current, current.attempt).finally(() => {
      replaying = false
      if (replayPending) {
        replayPending = false
        if (active !== null && active.unconfirmed && !active.inFlight) {
          replayActive(active)
        }
      }
    })
  }

  // ── 认证代际桥（DESIGN §3.2/§5.5） ──

  const onRuntimeChange = (): void => {
    if (state.invalidated || released) return
    const runtime = runtimeView()
    if (runtime.disposed || runtime.viewerChanged) {
      invalidateIntent('viewer-change')
      return
    }
    const identityChanged =
      runtime.authGeneration !== lastSeenGeneration ||
      runtime.viewerUserId !== lastSeenViewer ||
      runtime.projectId !== lastSeenProject
    if (identityChanged) {
      lastSeenGeneration = runtime.authGeneration
      lastSeenViewer = runtime.viewerUserId
      lastSeenProject = runtime.projectId
      loaded = false
      clearRetryTimer()
      if (active !== null) {
        // refresh 后已派发但 ACK 未知的 M 立即标记未确认并等待同 viewer 重放
        // （DESIGN §3.2/§5.5；不再等旧请求失败/返回）。
        active.unconfirmed = true
      }
    }
    if (!runtime.ready) return
    if (runtime.editorReady === false) {
      if (!state.readOnly) {
        reduce({
          type: 'save/readonly',
          failure: { code: 'editor_capability_unavailable', retryable: false },
        })
      }
      return
    }
    if (active !== null) {
      if (active.unconfirmed && !sameGeneration(active.attempt)) {
        replayActive(active)
      } else if (retryPaused && retryTimer === null && !active.inFlight && !replaying) {
        // R6/F1：只恢复“确实因 runtime 不可用而暂停的退避重试”；耗尽/非重试失败不得被
        // 无关 runtime 通知重启，且恢复一次后清标记、保持原重试预算。
        retryPaused = false
        active.attempt = newAttempt(active.record.mutationId)
        void performPut(active, active.attempt)
      }
      return
    }
    if (!loaded) void loadInternal()
  }

  const loadInternal = async (): Promise<void> => {
    if (state.invalidated || released || loaded) return
    if (!runtimeView().ready) {
      pendingLoad = true
      return
    }
    if (loadingGeneration !== null) {
      // 同代际的重复 load 复用同一在途 GET；旧代际 GET 结束后会续跑本代加载
      // （review P1 #5：旧 GET 晚到不得永久卡 loading）。
      return
    }
    const generation = runtimeView().authGeneration
    loadingGeneration = generation
    let stale = false
    try {
      stale = await loadInternalUnlocked(generation)
    } finally {
      loadingGeneration = null
    }
    if (stale && !state.invalidated && !released && !loaded && runtimeView().ready) {
      void loadInternal()
    }
  }

  const loadInternalUnlocked = async (generation: number): Promise<boolean> => {
    if (state.invalidated || released || loaded) return false
    if (active !== null) {
      pendingLoad = true
      return false
    }
    if (deps.transport === null) {
      recoverLocalDraft()
      reduce({ type: 'load/failure', failure: { code: 'editor_transport_unavailable', retryable: false } })
      return false
    }
    const runtime = runtimeView()
    if (!runtime.ready) {
      pendingLoad = true
      return false
    }
    const attemptGeneration = runtime.authGeneration
    const attemptViewer = runtime.viewerUserId
    const attemptProject = runtime.projectId
    reduce({ type: 'load/start' })
    let raw: unknown
    try {
      const result = await guard.run(() => deps.transport!.getEditorState())
      if (result.status === 'stale') return false
      raw = await result.value
    } catch (error) {
      const currentRuntime = runtimeView()
      if (
        currentRuntime.disposed ||
        currentRuntime.viewerChanged ||
        currentRuntime.authGeneration !== attemptGeneration ||
        currentRuntime.viewerUserId !== attemptViewer ||
        currentRuntime.projectId !== attemptProject
      ) {
        // 旧代际 GET 失败晚到：丢弃，不污染新代状态；由续跑逻辑重新加载。
        loaded = false
        return true
      }
      const failure = classifySaveFailure(error)
      recoverLocalDraft()
      reduce({ type: 'load/failure', failure })
      return false
    }
    const currentRuntime = runtimeView()
    if (
      currentRuntime.disposed ||
      currentRuntime.viewerChanged ||
      currentRuntime.authGeneration !== attemptGeneration ||
      currentRuntime.viewerUserId !== attemptViewer ||
      currentRuntime.projectId !== attemptProject ||
      generation !== attemptGeneration
    ) {
      // 旧代际 GET 一律丢弃（F03）：续跑当前代加载。
      loaded = false
      return true
    }
    if (active !== null) {
      pendingLoad = true
      return false
    }
    const parsed = parseEditorResponse(raw)
    if (
      !parsed.ok ||
      sessionKey(parsed.value.ref) !== sessionKey(state.ref) ||
      String(parsed.value.viewerUserId) !== String(currentRuntime.viewerUserId)
    ) {
      recoverLocalDraft()
      reduce({ type: 'load/failure', failure: { code: 'invalid_response', retryable: false } })
      return false
    }
    loaded = true
    // 服务端不可读（editor_state_unreadable）优先于本机 dirty：只读展示、不写回
    // 默认范围/空稿，也不允许 PUT 覆盖服务端状态（二次 review N8）。
    if (parsed.value.editorState === null) {
      reduce({
        type: 'load/unreadable',
        warnings: parsed.value.stateWarnings,
        revision: parsed.value.editorRevision,
      })
      const unreadableRecord = readOwnDraft()
      if (unreadableRecord !== null) reduce({ type: 'draft/readback', record: unreadableRecord })
      refreshDraftCandidates()
      return false
    }
    // GET 与本地未同步文本的竞态（review P1 #6）：不用服务端快照覆盖本机 dirty。
    if (isDirty(state)) {
      if (parsed.value.editorRevision !== state.revision) {
        // revision 已变化：服务端已有新数据，停在本机文本并进入冲突态，不自动覆盖。
        reduce({
          type: 'save/conflict',
          kind: 'revision',
          failure: { code: 'editor_revision_conflict', retryable: false },
        })
        refreshDraftCandidates()
        return false
      }
      // 同一 revision：保留本机文本，继续 autosave；仍须归约 load/ready，
      // 否则 loading 永不清除、canSubmit 永远 not_loaded（二次 review P1）。
      reduce({ type: 'load/ready', projection: parsed.value })
      if (!state.oversize) scheduleTextSave()
      refreshDraftCandidates()
      return false
    }
    if (parsed.value.stateWarnings.includes('position_unavailable')) {
      reduce({ type: 'draft/positionUnavailable' })
    }
    const localRecord = readOwnDraft()
    if (
      localRecord !== null &&
      localRecord.dirty &&
      localRecord.baseRevision !== parsed.value.editorRevision &&
      (localRecord.text !== parsed.value.editorState.draft.text ||
        localRecord.token !== parsed.value.editorState.draft.token)
    ) {
      // 本机有未同步稿且服务端 revision 已前进：读回本机文本并进入冲突态，
      // 不得用服务端快照覆盖（DESIGN §5.5 GET 竞态 / F03）。
      reduce({ type: 'draft/readback', record: localRecord })
      reduce({
        type: 'save/conflict',
        kind: 'revision',
        failure: { code: 'editor_revision_conflict', retryable: false },
      })
      refreshDraftCandidates()
      return false
    }
    reduce({ type: 'load/ready', projection: parsed.value })
    // 同一 revision 下本机未同步稿优先（F02 切回保留本机文本，§5.5）。
    const record = readOwnDraft()
    if (
      record !== null &&
      record.dirty &&
      record.baseRevision === parsed.value.editorRevision &&
      (record.text !== parsed.value.editorState.draft.text ||
        record.token !== parsed.value.editorState.draft.token)
    ) {
      reduce({ type: 'draft/readback', record })
      if (!state.oversize) scheduleTextSave()
    } else {
      removeOwnDraftIfClean()
    }
    refreshDraftCandidates()
    if (runtimeView().editorReady === false) {
      // editor 能力不可用：即使读回快照也保持只读（不得因 load/ready 清除 readonly）。
      reduce({
        type: 'save/readonly',
        failure: { code: 'editor_capability_unavailable', retryable: false },
      })
    }
    return false
  }

  // ── 失效/卸载 ──

  const releaseHold = (operationId: string): void => {
    const holds = state.holds.filter((hold) => hold.operationId !== operationId)
    if (holds.length === state.holds.length) return
    reduce({ type: 'holds/update', holds })
    if (!hasSubmitHold()) {
      // release 只释放本 operationId；若期间积累了自动保存意图，应立即续跑，
      // 不能等下一次输入（DESIGN §5.6 hold/release ownership）。
      if (queued !== null) dispatchQueued()
      else dispatchAutoIfPossible()
    }
  }

  const invalidateIntent = (reason: 'logout' | 'viewer-change'): void => {
    manualReplayRequested = false
    retryPaused = false
    if (state.invalidated) return
    void reason
    loaded = false
    pendingLoad = false
    clearSaveTimers()
    clearRetryTimer()
    if (localTimer !== null) clearTimeout(localTimer)
    localTimer = null
    guard.invalidate()
    if (active !== null) {
      active.resolve('skipped')
      active = null
    }
    if (queued !== null) {
      queued.resolve('skipped')
      queued = null
    }
    reduce({ type: 'invalidate' })
  }

  // ── 对外 API ──

  const controller: EditorController = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load: async () => {
      if (state.invalidated || released || loaded) return
      if (!runtimeView().ready) {
        // bootstrap/遮蔽未完成前不得发 editor GET（review P1 #8）。
        pendingLoad = true
        return
      }
      await loadInternal()
    },
    setDraftText: (text) => {
      if (state.invalidated || released || state.readOnly) return
      if (text === state.draftText) return
      // 文本必须原样保留（不归一化、不截断 lone surrogate）；超限只禁用保存/提交。
      const oversize = measureDraftBytes(text) > EDITOR_TEXT_MAX_BYTES
      reduce({ type: 'draft/text', text, token: nextDraftToken(), oversize })
      scheduleLocalDraft()
      if (!oversize) scheduleTextSave()
    },
    setScope: (edit) => {
      if (state.invalidated || released || state.readOnly) return
      const next = applyScopeEdit(
        { baseScope: state.baseScope, singleSourceId: state.singleSourceId, noteIds: state.noteIds },
        edit,
      )
      reduce({
        type: 'draft/scope',
        baseScope: next.baseScope,
        singleSourceId: next.singleSourceId,
        noteIds: next.noteIds,
      })
      scheduleLocalDraft()
      scheduleTextSave()
    },
    setChatAnchor: (anchor) => {
      if (state.invalidated || released || state.readOnly || state.positionUnavailable) return
      reduce({ type: 'draft/anchor', chatAnchor: anchor, readerAnchor: state.readerAnchor })
      scheduleLocalDraft()
      schedulePositionSave()
    },
    setReaderAnchor: (anchor) => {
      if (state.invalidated || released || state.readOnly || state.positionUnavailable) return
      reduce({ type: 'draft/anchor', chatAnchor: state.chatAnchor, readerAnchor: anchor })
      scheduleLocalDraft()
      schedulePositionSave()
    },
    flush: async (reason) => {
      clearSaveTimers()
      pendingAutoText = false
      pendingAutoPosition = false
      writeLocalDraft()
      if (state.invalidated) return 'skipped'
      if (state.readOnly) return 'readonly'
      if (state.blocked) return 'blocked'
      if (state.conflict !== null) return 'conflict'
      if (deps.transport === null) return 'blocked'
      const explicit = reason === 'submit'
      if (!isDirty(state) && active === null && queued === null) return 'skipped'
      // 普通 flush（text/position/switch）不得穿透 hold；只有 submit 拥有准备权限。
      // 被 hold 挡下的 dirty 意图必须留给 release 后续跑（Lead 附加要求 4）。
      if (!explicit && (hasSubmitHold() || hasConflictHold())) {
        pendingAutoText = isDirty(state)
        pendingAutoPosition = state.chatAnchor !== null || state.readerAnchor !== null
        return 'blocked'
      }
      if (state.oversize) {
        reduce({ type: 'save/blocked', failure: { code: 'editor_state_too_large', retryable: false } })
        return 'blocked'
      }
      // 只有 submit 拥有"准备并提交"权限；text/position/switch 属普通 flush，
      // 不得穿透 submit/conflict hold（review P1 #6 / Lead 附加要求 1）。
      if (active !== null) {
        const { promise, resolve } = makeResolver()
        replaceQueued()
        queued = {
          kind: 'save',
          operationId: null,
          explicit,
          frozenEditorState: explicit ? editorStateToWire(state) : null,
          capturedLocalVersion: state.localVersion,
          localVersion: state.localVersion,
          resolve,
        }
        return (await promise) as SaveOutcome
      }
      const { promise, resolve } = makeResolver()
      dispatchSave({
        kind: 'save',
        operationId: null,
        explicit,
        frozenEditorState: explicit ? editorStateToWire(state) : null,
        capturedLocalVersion: state.localVersion,
        localVersion: state.localVersion,
        resolve,
      })
      return (await promise) as SaveOutcome
    },
    hold: (reason, operationId) => {
      if (state.holds.some((hold) => hold.operationId === operationId)) return
      reduce({ type: 'holds/update', holds: [...state.holds, { reason, operationId }] })
    },
    release: (operationId) => releaseHold(operationId),
    retrySave: async () => {
      if (state.invalidated || released) return 'skipped'
      if (state.conflict !== null) return 'conflict'
      // 手动重试必须取消在途退避定时器，否则旧定时器会再发一次 PUT（二次 review P1）。
      clearRetryTimer()
      if (active !== null) {
        // 在途请求未结算时重试必须复用同一 attempt，禁止并发 PUT（review P1 #2）。
        if (!active.unconfirmed) return 'queued'
        if (active.inFlight || replaying) {
          // 退避定时器发起的 attempt 仍在途：记下手动重放，结算后再发，保证同刻只有一个 PUT。
          manualReplayRequested = true
          return 'queued'
        }
        replayActive(active)
        return 'queued'
      }
      if (queued !== null) return 'queued'
      return controller.flush('submit')
    },
    adoptServerVersion: async () => {
      if (state.invalidated || released) return 'skipped'
      if (state.conflict === null) return 'skipped'
      if (deps.transport === null) return 'blocked'
      const runtime = runtimeView()
      if (!runtime.ready || runtime.editorReady === false) return 'blocked'
      const attemptGeneration = runtime.authGeneration
      const attemptViewer = runtime.viewerUserId
      let raw: unknown
      try {
        const result = await guard.run(() => deps.transport!.getEditorState())
        if (result.status === 'stale') return 'skipped'
        raw = await result.value
      } catch (error) {
        return 'blocked'
      }
      const currentRuntime = runtimeView()
      if (
        currentRuntime.authGeneration !== attemptGeneration ||
        currentRuntime.viewerUserId !== attemptViewer ||
        currentRuntime.disposed
      ) {
        return 'skipped'
      }
      const parsed = parseEditorResponse(raw)
      if (
        !parsed.ok ||
        sessionKey(parsed.value.ref) !== sessionKey(state.ref) ||
        String(parsed.value.viewerUserId) !== String(currentRuntime.viewerUserId)
      ) {
        // 采用服务端前必须校验响应身份（review P2 #10）。
        reduce({ type: 'save/unconfirmed', failure: { code: 'invalid_response', retryable: false } })
        return 'invalid'
      }
      if (parsed.value.editorState === null) {
        // 服务端不可读状态不可被“采用”，保持冲突/只读（二次 review N8）。
        reduce({
          type: 'save/blocked',
          failure: { code: 'editor_state_unreadable', retryable: false },
        })
        return 'blocked'
      }
      reduce({ type: 'conflict/adoptServer', projection: parsed.value })
      loaded = true
      removeOwnDraftIfClean()
      afterSettle()
      return 'saved'
    },
    saveLocalOverServer: async () => {
      if (state.invalidated || released) return 'skipped'
      if (state.conflict === null) return controller.flush('submit')
      if (deps.transport === null) return 'blocked'
      const runtime = runtimeView()
      if (!runtime.ready || runtime.editorReady === false) return 'blocked'
      const attemptGeneration = runtime.authGeneration
      const attemptViewer = runtime.viewerUserId
      let raw: unknown
      try {
        const result = await guard.run(() => deps.transport!.getEditorState())
        if (result.status === 'stale') return 'skipped'
        raw = await result.value
      } catch {
        return 'blocked'
      }
      const currentRuntime = runtimeView()
      if (
        currentRuntime.authGeneration !== attemptGeneration ||
        currentRuntime.viewerUserId !== attemptViewer ||
        currentRuntime.disposed ||
        currentRuntime.viewerChanged
      ) {
        return 'skipped'
      }
      const parsed = parseEditorResponse(raw)
      if (
        !parsed.ok ||
        sessionKey(parsed.value.ref) !== sessionKey(state.ref) ||
        String(parsed.value.viewerUserId) !== String(currentRuntime.viewerUserId)
      ) {
        return 'invalid'
      }
      if (parsed.value.editorState === null) {
        // 服务端当前不可读：不得用本机 shadow 覆盖（二次 review N8）。
        reduce({
          type: 'save/blocked',
          failure: { code: 'editor_state_unreadable', retryable: false },
        })
        return 'blocked'
      }
      // 以服务端最新 revision 作为 expected_revision，再显式保存本机 shadow。
      reduce({
        type: 'conflict/refreshRevision',
        revision: parsed.value.editorRevision,
        intentHash: parsed.value.editorIntentHash,
        warnings: parsed.value.stateWarnings,
      })
      reduce({ type: 'conflict/clear' })
      return controller.flush('submit')
    },
    clearAfterSubmission: async (receipt, operationId) => {
      if (state.invalidated || released) return 'invalid'
      if (sessionKey(receipt.sessionRef) !== sessionKey(state.ref)) return 'invalid'
      // 迟到回执不得清掉已存在的新输入：token 与提交文本必须仍与当前 shadow 一致
      // （DESIGN §5.6 步骤 1 / §9.2；review P1 #7）。
      if (receipt.draftToken !== state.draftToken || receipt.text !== state.draftText) return 'invalid'
      controller.markTokenConsumed(receipt.draftToken)
      if (!state.holds.some((hold) => hold.operationId === operationId)) {
        controller.hold('submit', operationId)
      }
      if (state.readOnly || state.blocked || deps.transport === null) {
        releaseHold(operationId)
        return 'invalid'
      }
      clearSaveTimers()
      pendingAutoText = false
      pendingAutoPosition = false
      writeLocalDraft()
      const capturedLocalVersion = state.localVersion
      const { promise, resolve } = makeResolver()
      if (active !== null) {
        // 已派发但 ACK 未知的 mutation 不取消/不删除；排队，结算后按原 body 重放。
        replaceQueued()
        queued = {
          kind: 'clear',
          operationId,
          explicit: true,
          frozenEditorState: null,
          capturedLocalVersion,
          localVersion: state.localVersion,
          resolve,
        }
        return (await promise) as ClearOutcome
      }
      dispatchClear({
        kind: 'clear',
        operationId,
        explicit: true,
        frozenEditorState: null,
        capturedLocalVersion,
        localVersion: state.localVersion,
        resolve,
      })
      return (await promise) as ClearOutcome
    },
    markTokenConsumed: (token) => {
      if (!isTokenShaped(token)) return
      reduce({ type: 'token/consumed', token })
    },
    canSubmit: () => {
      if (state.invalidated) return { allowed: false, reason: 'invalidated' }
      const submitRuntime = runtimeView()
      if (!submitRuntime.ready || submitRuntime.editorReady === false || submitRuntime.disposed) {
        // 认证未就绪/masked/能力关闭时不得提交（N9）。
        return { allowed: false, reason: 'not_ready' }
      }
      if (state.readOnly) return { allowed: false, reason: 'readonly' }
      if (state.phase === 'idle' || state.loading) return { allowed: false, reason: 'not_loaded' }
      if (state.conflict !== null) return { allowed: false, reason: 'conflict' }
      if (state.blocked) return { allowed: false, reason: 'blocked' }
      if (state.saving || active !== null || state.pendingMutations > 0) {
        return { allowed: false, reason: 'saving' }
      }
      if (isDirty(state)) return { allowed: false, reason: 'dirty' }
      if (state.consumedToken !== null && state.draftToken === state.consumedToken) {
        return { allowed: false, reason: 'consumed' }
      }
      if (deps.transport === null) return { allowed: false, reason: 'no_transport' }
      return { allowed: true, reason: null }
    },
    restoreDraft: (otherWriterId) => {
      if (state.invalidated || released || otherWriterId === writerId) return
      const scope = deps.getCacheScope()
      const authority = deps.getCacheAuthority()
      if (scope === null || authority === null) return
      const record = readDraft(scope, authority, state.ref, otherWriterId, cacheOptions())
      if (record === null) return
      // 只复制到当前分支，不删除来源分支（DESIGN §3.5）。
      const oversize = measureDraftBytes(record.text) > EDITOR_TEXT_MAX_BYTES
      state = {
        ...state,
        draftText: record.text,
        draftToken: nextDraftToken(),
        baseScope: record.baseScope,
        singleSourceId: record.singleSourceId,
        noteIds: record.noteIds,
        localVersion: state.localVersion + 1,
        oversize,
        phase: state.readOnly ? 'readonly' : 'ready',
      }
      state = { ...state, dirty: isDirty(state) }
      emit()
      scheduleLocalDraft()
      if (!oversize) scheduleTextSave()
    },
    refreshDraftCandidates: () => refreshDraftCandidates(),
    invalidate: (reason) => invalidateIntent(reason),
    hasPendingWork: () => active !== null || queued !== null,
    releaseDocument: () => {
      if (released) return
      clearSaveTimers()
      clearRetryTimer()
      if (localTimer !== null) clearTimeout(localTimer)
      localTimer = null
      writeLocalDraft()
      unsubscribeRuntime()
      released = true
    },
    persistLocal: () => {
      writeLocalDraft()
    },
  }

  if (deps.transport !== null && runtimeView().ready) {
    const initialRuntime = runtimeView()
    lastSeenGeneration = initialRuntime.authGeneration
    lastSeenViewer = initialRuntime.viewerUserId
    lastSeenProject = initialRuntime.projectId
    if (initialRuntime.editorReady === false) {
      reduce({
        type: 'save/readonly',
        failure: { code: 'editor_capability_unavailable', retryable: false },
      })
    } else {
      void loadInternal()
    }
  }

  return controller
}

/** mutation_id 形状校验（供 PR-5a/测试复用）。 */
export function isMutationIdShaped(value: string): boolean {
  return MUTATION_ID_PATTERN.test(value)
}

/** 编辑器阶段类型重导出（PR-4 组件层可能直接引用）。 */
export type { EditorPhase }
