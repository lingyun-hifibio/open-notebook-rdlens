/**
 * Issue #1046 PR4（D2-B2）：单文档 Note 编辑器状态机。
 *
 * 权威依据：方案 v4 §4.1–§4.4（编辑状态机 / 独立缓存 / 编辑保护 / 离开保护）、
 * 契约 §3/§4/§8（revision CAS、回执、稳定错误码）、`./types.ts` 冻结接口。
 *
 * 不变量（全部由本模块强制）：
 * - 每份打开文档维护 serverRevision/serverSnapshotHash/localSeq/ackedSeq/
 *   inFlight/authGeneration；普通输入 debounce 800ms；同一文档最多一个在途写；
 * - 每次请求捕获完整快照 + localSeq；ACK 只更新其发送快照对应的保存状态，
 *   绝不覆盖发送后更新的编辑区；过期回调（note/project/authGeneration 不匹配）
 *   一律丢弃；
 * - IME composition 期间只写本地草稿、不发服务端保存；离开前先结束 composition；
 * - ACK 不清空 undo 历史；撤销恢复本地正文并以**当前** revision 走同一自动保存；
 * - 未知结果保留同一 mutation_id（同请求重放确认），确认前禁止新写入与静默导航；
 * - 冲突暂停自动保存、保留本地快照，只提供 复制 / 受保护另存 / 加载最新版，
 *   禁止自动合并与强制覆盖；
 * - 权限受限清理持久草稿；删除（404）明确失败但保留可取回本地文本，不自动新建；
 * - 能力故障/关闭时不退回无 revision 旧表单（fail-closed 阻断态）。
 *
 * 本模块不 import React，副作用（传输/缓存/剪贴板/下载）全部经依赖注入，
 * 可用 fake timers + fake client 做纯单测。
 */

import {
  normalizeNoteApiError,
  newNoteMutationId,
  noteApiClient,
  type NoteApiClient,
  type NoteD2CopyRequest,
  type NoteD2SaveRequest,
} from './note-client'
import {
  readNoteDraft,
  readNoteDraftForRetrieval,
  readOrCreateNoteDraftTabId,
  removeNoteDraft,
  removeNoteDraftsForNote,
  writeNoteDraft,
  type NoteDraftAuthority,
  type NoteDraftCacheStorage,
  type NoteDraftScope,
} from './note-draft-cache'
import { downloadLocalDraftMarkdown, type NoteLocalDraftInput } from './note-download'
import { computeInsertedRange, splitsSurrogatePair } from './excerpt'
import { NoteUndoStack } from './note-undo'
import {
  type EditorTextSelectionSnapshot,
  type NoteApiError,
  type NoteCapabilities,
  type NoteDraftCacheRecord,
  type NoteEditorActions,
  type NoteEditorConflict,
  type NoteEditorPositionRestoreRequest,
  type NoteEditorSelectionRequest,
  type NoteEditorState,
  type NoteInsertFragmentInput,
  type NoteInsertFragmentResult,
  type NoteLeaveBlockReason,
  type NoteReceipt,
  type NoteSaveStatus,
  type PendingNoteMutation,
  type ResearchNoteD2,
} from './types'

/** 普通输入自动保存 debounce（方案 §4.1：800 ms）。 */
export const NOTE_SAVE_DEBOUNCE_MS = 800

/** d2-v1 受保护 Note 的 edit_schema 冻结值。 */
export const NOTE_EDIT_SCHEMA_D2_V1 = 'd2-v1'

/** 视为「存在未完成保存」的显式状态（beforeunload 提示条件）。 */
export function isUnfinishedSaveStatus(status: NoteSaveStatus): boolean {
  return (
    status === 'pending' ||
    status === 'saving' ||
    status === 'unknown' ||
    status === 'failed' ||
    status === 'conflict'
  )
}

// ── 依赖注入形状 ──

export interface NoteEditorMachineOptions {
  projectId: string
  /** 当前已认证 owner 的字符串 id；'' = 身份未确认（禁用持久草稿）。 */
  viewerUserId: string
  isAdminReadonly: boolean
  authGeneration: number
  capabilities: NoteCapabilities | null
  client?: NoteApiClient
  /** 显式存储注入（测试）；缺省用 window.localStorage（不可用则内存降级）。 */
  storage?: NoteDraftCacheStorage | null
  /** 草稿 tabId（缺省从 sessionStorage 读取/创建）。 */
  tabId?: string
  now?: () => Date
  nextMutationId?: () => string
  writeClipboard?: (text: string) => Promise<void>
  downloadMarkdown?: (input: NoteLocalDraftInput) => void
  debounceMs?: number
}

export interface NoteEditorIdentity {
  projectId: string
  viewerUserId: string
  authGeneration: number
  isAdminReadonly: boolean
}

export interface NoteEditorMachine {
  getState(): NoteEditorState
  subscribe(listener: () => void): () => void
  getActions(): NoteEditorActions
  /** hook 在身份/项目/代际/权限变化时调用。 */
  setIdentity(identity: NoteEditorIdentity): void
  updateCapabilities(capabilities: NoteCapabilities | null): void
  /** pagehide 同步持久化（不写服务端）。 */
  persistLocalDraft(): void
  /** 是否存在未完成保存（beforeunload 提示条件）。 */
  hasUnfinishedWork(): boolean
  /**
   * 非永久停止（StrictMode 安全）：只清除已排定的定时器，不销毁状态机。
   * 组件 effect 的 cleanup（含 StrictMode 的 setup→cleanup→setup 双调用）
   * 必须调用本方法而不是 `dispose()`；重挂载后同一 machine 继续可用。
   */
  stop(): void
  /** 是否已永久销毁（仅供测试/诊断；destroy 后一切动作 no-op）。 */
  isDisposed(): boolean
  /**
   * 永久销毁：仅用于身份/项目真正替换（旧 machine 不再复用）。销毁后
   * 所有动作 no-op、监听器清空、挂起 Promise resolve；不可重挂载复用。
   */
  dispose(): void
}

// ── 内部状态 ──

interface InFlightWrite {
  readonly kind: 'save' | 'create' | 'copy' | 'fragment'
  readonly mutationId: string
  readonly noteId: string | null
  readonly capturedSeq: number
  readonly capturedTitle: string
  readonly capturedContent: string
  readonly expectedRevision: number | null
  readonly generation: number
  readonly projectId: string
  readonly openToken: number
  /** 加性（PR5/B3）：片段插入请求（同 mutation 重放）与发起时选区。 */
  readonly fragment?: NoteInsertFragmentInput
  readonly editorSelection?: EditorTextSelectionSnapshot | null
}

interface MachineState {
  status: NoteEditorState['status']
  note: ResearchNoteD2 | null
  noteId: string | null
  title: string
  content: string
  saveStatus: NoteSaveStatus
  conflict: NoteEditorConflict | null
  pendingMutation: PendingNoteMutation | null
  pendingMutationId: string | null
  cacheStatus: NoteEditorState['cacheStatus']
  restoredFromCache: boolean
  canUndo: boolean
  blockReason: string | null
  error: NoteApiError | null
  leaveBlockReason: NoteLeaveBlockReason | null
  serverRevision: number | null
  serverSnapshotHash: string | null
  /** 最近一次服务端确认（或加载）的标题/正文（放弃本地编辑/取回基线）。 */
  baseTitle: string
  baseContent: string
  localSeq: number
  ackedSeq: number
  inFlight: InFlightWrite | null
  composing: boolean
  /** 服务端已确认正文所在 revision/hash 是否被本地编辑推进（localSeq > ackedSeq）。 */
  dirty: boolean
  /** PR5/B3：片段插入进行中（正文编辑暂停，方案 §4.3）。 */
  inserting: boolean
  /** PR5/B3：界面需应用的选区/滚动恢复指令（seq 递增触发）。 */
  selectionRequest: NoteEditorSelectionRequest | null
  selectionSeq: number
}

function createInitialState(): MachineState {
  return {
    status: 'idle',
    note: null,
    noteId: null,
    title: '',
    content: '',
    saveStatus: 'idle',
    conflict: null,
    pendingMutation: null,
    pendingMutationId: null,
    cacheStatus: 'unavailable',
    restoredFromCache: false,
    canUndo: false,
    blockReason: null,
    error: null,
    leaveBlockReason: null,
    serverRevision: null,
    serverSnapshotHash: null,
    baseTitle: '',
    baseContent: '',
    localSeq: 0,
    ackedSeq: 0,
    inFlight: null,
    composing: false,
    dirty: false,
    inserting: false,
    selectionRequest: null,
    selectionSeq: 0,
  }
}

function stateError(
  code: NoteApiError['code'],
  message: string,
  retryable: boolean,
  status = 0,
): NoteApiError {
  return { code, message, retryable, status }
}

function isCapabilityBlock(reason: string | null): boolean {
  return (
    reason === 'capability_unknown' ||
    reason === 'note_store_unavailable' ||
    reason === 'disabled_by_flag' ||
    reason === 'not_ready'
  )
}

/** 当前浏览器剪贴板（不可用时静默 resolve——用户仍可下载本地 Markdown 取回）。 */
async function defaultWriteClipboard(text: string): Promise<void> {
  const clipboard = (
    typeof navigator === 'object' && navigator !== null
      ? (navigator as Navigator & { clipboard?: { writeText?: (text: string) => Promise<void> } })
          .clipboard
      : undefined
  )
  if (clipboard && typeof clipboard.writeText === 'function') {
    await clipboard.writeText(text)
  }
}

// ── 机器实现 ──

export function createNoteEditorMachine(
  options: NoteEditorMachineOptions,
): NoteEditorMachine {
  const client: NoteApiClient = options.client ?? noteApiClient
  const now = options.now ?? (() => new Date())
  const nextMutationId = options.nextMutationId ?? newNoteMutationId
  const debounceMs = options.debounceMs ?? NOTE_SAVE_DEBOUNCE_MS
  const undoStack = new NoteUndoStack({ now: () => now().getTime() })
  const tabId = options.tabId ?? readOrCreateNoteDraftTabId()
  const listeners = new Set<() => void>()

  let currentProjectId = options.projectId
  let currentViewerUserId = options.viewerUserId
  let currentGeneration = options.authGeneration
  let isAdminReadonly = options.isAdminReadonly
  let capabilities = options.capabilities

  let disposed = false
  let openToken = 0
  let debounceHandle: ReturnType<typeof setTimeout> | null = null
  let settleWaiters: Array<() => void> = []
  let state: MachineState = createInitialState()
  let publicState: NoteEditorState = buildPublicState()
  /** 最近一次成功写入草稿缓存的时间（下载标记用）。 */
  let lastCacheSavedAt: string | null = null
  /** 成功的受保护另存已把本地正文保存到新 Note（允许丢弃本地编辑并安全离开）。 */
  let localContentPreserved = false
  /** 在途写结算后再执行放弃本地编辑。 */
  let discardAfterFlight = false
  /** ACK 后有待发送的下一次保存。 */
  let queuedAfterFlight = false
  /** 加载时是否因能力故障被阻断（能力恢复后允许补恢复草稿）。 */
  let capabilityBlockedAtLoad = false

  // ── 缓存/授权辅助 ──

  function cacheOptions(): { storage?: NoteDraftCacheStorage | null } | undefined {
    return options.storage !== undefined ? { storage: options.storage } : undefined
  }

  function cacheScope(): NoteDraftScope | null {
    if (currentViewerUserId.length === 0) return null
    const noteId = state.noteId
    if (noteId === null) return null
    return {
      ownerId: currentViewerUserId,
      projectId: currentProjectId,
      noteId,
      tabId,
    }
  }

  function draftAuthority(permissionConfirmed: boolean): NoteDraftAuthority {
    return {
      authenticatedOwnerId: currentViewerUserId.length > 0 ? currentViewerUserId : null,
      currentProjectId,
      authGeneration: currentGeneration,
      currentAuthGeneration: currentGeneration,
      permissionConfirmed,
    }
  }

  function bumpCacheStatusFromRead(record: NoteDraftCacheRecord | null): void {
    if (currentViewerUserId.length === 0) {
      state.cacheStatus = 'unavailable'
      return
    }
    if (record === null) return
    // 读得到记录说明本机存储可用（内存降级副本也算 memory_only：保守）。
    if (state.cacheStatus !== 'memory_only') state.cacheStatus = 'ok'
  }

  /**
   * ACK 结算后同步 state.note 的服务端投影（revision/snapshot_hash/updated_at 与
   * 已确认标题/正文）。否则 NoteEditorView 头部的“Revision N”会停留在保存前值
   * （真实浏览器 S2：服务端 r4、头部显示 r3）。
   */
  function syncNoteFromReceipt(
    receipt: NoteReceipt,
    confirmedTitle: string,
    confirmedContent: string,
  ): void {
    if (state.note === null) return
    state.note = {
      ...state.note,
      title: confirmedTitle,
      content: confirmedContent,
      revision: receipt.applied_revision,
      snapshot_hash: receipt.snapshot_hash ?? state.note.snapshot_hash,
      updated_at: receipt.saved_at,
    }
  }

  /** 同步写本地草稿（每次编辑/ACK/未知结果后调用；不触网）。 */
  function writeCache(): void {
    const scope = cacheScope()
    if (currentViewerUserId.length === 0) {
      state.cacheStatus = 'unavailable'
      return
    }
    if (scope === null || state.serverRevision === null || state.serverSnapshotHash === null) {
      return
    }
    const shouldKeep =
      state.dirty || state.pendingMutation !== null || state.inFlight !== null
    if (!shouldKeep) {
      removeNoteDraft(scope, cacheOptions())
      state.cacheStatus = 'ok'
      return
    }
    const savedAt = now().toISOString()
    const record: NoteDraftCacheRecord = {
      v: 1,
      ownerId: scope.ownerId,
      projectId: scope.projectId,
      noteId: scope.noteId,
      title: state.title,
      content: state.content,
      baseRevision: state.serverRevision,
      baseSnapshotHash: state.serverSnapshotHash,
      localSeq: state.localSeq,
      pendingMutation: state.pendingMutation,
      savedAt,
    }
    const result = writeNoteDraft(scope, record, cacheOptions())
    if (!result.ok) {
      state.cacheStatus = 'unavailable'
      return
    }
    state.cacheStatus = result.persisted ? 'ok' : 'memory_only'
    if (result.persisted) lastCacheSavedAt = savedAt
  }

  function readDraftForCurrentNote(): NoteDraftCacheRecord | null {
    const scope = cacheScope()
    if (scope === null) return null
    return readNoteDraft(scope, draftAuthority(true), cacheOptions())
  }

  function readRetrievableDraft(): NoteDraftCacheRecord | null {
    const scope = cacheScope()
    if (scope === null) return null
    return readNoteDraftForRetrieval(scope, draftAuthority(false), cacheOptions())
  }

  function cleanupPersistentDrafts(): void {
    if (currentViewerUserId.length === 0) {
      state.cacheStatus = 'unavailable'
      return
    }
    if (state.noteId === null) return
    removeNoteDraftsForNote(
      currentViewerUserId,
      currentProjectId,
      state.noteId,
      cacheOptions(),
    )
  }

  function removeCurrentDraftCache(): void {
    const scope = cacheScope()
    if (scope === null) return
    removeNoteDraft(scope, cacheOptions())
    state.cacheStatus = currentViewerUserId.length > 0 ? 'ok' : 'unavailable'
  }

  // ── 状态广播 ──

  function buildPublicState(): NoteEditorState {
    return {
      status: state.status,
      note: state.note,
      title: state.title,
      content: state.content,
      saveStatus: state.saveStatus,
      conflict: state.conflict,
      pendingMutationId:
        state.saveStatus === 'unknown'
          ? (state.pendingMutation?.mutationId ?? state.pendingMutationId)
          : null,
      cacheStatus: state.cacheStatus,
      restoredFromCache: state.restoredFromCache,
      canUndo: state.canUndo,
      blockReason: state.blockReason,
      error: state.error,
      authGeneration: currentGeneration,
      leaveBlockReason: state.leaveBlockReason,
      localSeq: state.localSeq,
      baseRevision: state.serverRevision,
      inserting: state.inserting,
      selectionRequest: state.selectionRequest,
    }
  }

  function isSettled(): boolean {
    return (
      state.inFlight === null &&
      state.saveStatus !== 'saving' &&
      state.saveStatus !== 'pending' &&
      debounceHandle === null
    )
  }

  function resolveSettleWaiters(): void {
    if (!isSettled()) return
    const waiters = settleWaiters
    settleWaiters = []
    for (const resolve of waiters) resolve()
  }

  function buildActions(): NoteEditorActions {
    return {
      openNote,
      createBlankNote,
      closeEditor,
      setTitle,
      setContent,
      beginComposition,
      endComposition,
      saveNow,
      retrySave,
      confirmPendingMutation,
      undo,
      copyLocalContent,
      downloadLocalMarkdown,
      saveAsCopy,
      loadLatest,
      discardLocal,
      flushBeforeLeave,
      flushForInsert,
      insertFragment,
      restoreEditorPosition,
    }
  }

  const actions: NoteEditorActions = buildActions()

  function emit(): void {
    state.canUndo = undoStack.canUndo()
    publicState = buildPublicState()
    for (const listener of listeners) listener()
    resolveSettleWaiters()
  }

  function current(): { generation: number; projectId: string; token: number } {
    return { generation: currentGeneration, projectId: currentProjectId, token: openToken }
  }

  function isCurrent(target: { generation: number; projectId: string; token: number }): boolean {
    return (
      !disposed &&
      target.token === openToken &&
      target.generation === currentGeneration &&
      target.projectId === currentProjectId
    )
  }

  function isStaleWrite(write: InFlightWrite): boolean {
    return (
      disposed ||
      state.inFlight !== write ||
      write.openToken !== openToken ||
      write.projectId !== currentProjectId ||
      write.generation !== currentGeneration
    )
  }

  // ── 定时器 ──

  function clearDebounce(): void {
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle)
      debounceHandle = null
    }
  }

  function scheduleDebounce(): void {
    clearDebounce()
    if (disposed) return
    debounceHandle = setTimeout(() => {
      debounceHandle = null
      if (disposed || state.composing) return
      if (!canAutoSave()) return
      void dispatchSave()
    }, debounceMs)
  }

  // ── 能力/守卫 ──

  function capabilityExistingBlockReason(): string | null {
    if (capabilities === null) return 'capability_unknown'
    const capability = capabilities.noteEditorExisting
    if (capability === undefined || capability === null) return 'capability_unknown'
    if (capability.available !== true) {
      return typeof capability.reason === 'string' && capability.reason.length > 0
        ? capability.reason
        : 'capability_unknown'
    }
    return null
  }

  function capabilityCreateBlockReason(): string | null {
    if (capabilities === null) return 'capability_unknown'
    const capability = capabilities.noteEditor
    if (capability === undefined || capability === null) return 'capability_unknown'
    if (capability.available !== true) {
      return typeof capability.reason === 'string' && capability.reason.length > 0
        ? capability.reason
        : 'capability_unknown'
    }
    return null
  }

  function canEdit(): boolean {
    return (
      !disposed &&
      !state.inserting &&
      state.status === 'ready' &&
      state.note !== null &&
      state.note.edit_schema === NOTE_EDIT_SCHEMA_D2_V1 &&
      !isAdminReadonly &&
      state.blockReason === null &&
      state.saveStatus !== 'restricted' &&
      state.saveStatus !== 'blocked'
    )
  }

  function canAutoSave(): boolean {
    return (
      canEdit() &&
      state.noteId !== null &&
      state.serverRevision !== null &&
      state.serverSnapshotHash !== null &&
      state.saveStatus !== 'conflict' &&
      state.saveStatus !== 'unknown' &&
      state.saveStatus !== 'failed' &&
      state.saveStatus !== 'restricted' &&
      state.saveStatus !== 'blocked'
    )
  }

  /** 读取当前 saveStatus（避免 TS 对属性窄化影响异步后的状态判断）。 */
  function readSaveStatus(): NoteSaveStatus {
    return state.saveStatus
  }

  /**
   * 是否存在“不能静默丢弃”的本地文本：dirty（已确认 revision 之后的编辑）、
   * 未决 mutation（未知结果）、或当前标题/正文偏离最近一次服务端确认快照
   * （含 404 删除后的取回文本、能力阻断时只读展示的本地草稿）。
   *
   * 用于区分「无本地文本的阻断态可直接关闭/切换」与「有本地文本时必须显式
   * 放弃才能离开」（方案 §4.4：允许重试、复制/下载、确认放弃）。
   */
  function hasUnsyncedLocalText(): boolean {
    return (
      state.dirty ||
      state.pendingMutation !== null ||
      state.content !== state.baseContent ||
      state.title !== state.baseTitle
    )
  }

  /** 新建后打开：保留受限/阻断结果，否则按已保存展示。 */
  function finalStatusAfterLoad(): NoteSaveStatus {
    const current = state.saveStatus
    if (current === 'blocked' || current === 'restricted') return current
    return 'saved'
  }

  function waitForSettle(): Promise<void> {
    if (isSettled()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      settleWaiters.push(resolve)
    })
  }

  // ── 文档生命周期 ──

  function resetState(status: NoteEditorState['status'], noteId: string | null): void {
    clearDebounce()
    state = createInitialState()
    state.status = status
    state.noteId = noteId
    state.cacheStatus = currentViewerUserId.length > 0 ? 'ok' : 'unavailable'
    lastCacheSavedAt = null
    localContentPreserved = false
    discardAfterFlight = false
    queuedAfterFlight = false
    capabilityBlockedAtLoad = false
    undoStack.clear()
  }

  function endCompositionInternal(): void {
    if (!state.composing) return
    state.composing = false
    if (state.dirty && canAutoSave() && debounceHandle === null) scheduleDebounce()
  }

  async function openNote(noteId: string): Promise<void> {
    if (disposed || noteId.length === 0) return
    const retrySameDocument = state.noteId === noteId
    if (retrySameDocument && state.status !== 'error') return
    if (state.noteId !== null && !retrySameDocument) {
      const blocked = await flushBeforeLeave()
      if (blocked !== null) {
        state.leaveBlockReason = blocked
        emit()
        return
      }
    }
    endCompositionInternal()
    clearDebounce()
    openToken += 1
    const target = current()
    resetState('loading', noteId)
    emit()
    try {
      const note = await client.getNote(currentProjectId, noteId)
      if (!isCurrent(target)) return
      applyLoadedNote(note, { restoreDraft: true })
      emit()
    } catch (error) {
      if (!isCurrent(target)) return
      handleOpenFailure(error, noteId)
      emit()
    }
  }

  function handleOpenFailure(error: unknown, noteId: string): void {
    const apiError = normalizeNoteApiError(error)
    state.error = apiError
    state.status = 'error'
    if (apiError.code === 'note_access_restricted') {
      state.saveStatus = 'restricted'
      state.blockReason = 'note_access_restricted'
      cleanupPersistentDrafts()
      return
    }
    if (apiError.code === 'note_not_found') {
      // 删除/不存在：明确失败，但保留可取回本地文本（复制/下载），不自动新建。
      state.noteId = noteId
      const record = readRetrievableDraft()
      if (record !== null) {
        state.title = record.title
        state.content = record.content
        state.localSeq = Math.max(record.localSeq, 0)
        bumpCacheStatusFromRead(record)
      }
      state.saveStatus = 'failed'
      state.blockReason = 'note_not_found'
      return
    }
    if (apiError.code === 'note_edit_schema_unsupported') {
      state.saveStatus = 'blocked'
      state.blockReason = 'note_edit_schema_unsupported'
      return
    }
    state.saveStatus = 'failed'
    state.blockReason = apiError.retryable ? null : apiError.code
  }

  function applyLoadedNote(
    note: ResearchNoteD2,
    optionsBundle: { restoreDraft: boolean },
  ): void {
    state.note = note
    state.noteId = note.note_id
    state.serverRevision = note.revision
    state.serverSnapshotHash = note.snapshot_hash
    state.baseTitle = note.title
    state.baseContent = note.content
    state.title = note.title
    state.content = note.content
    state.localSeq = 0
    state.ackedSeq = 0
    state.dirty = false
    state.conflict = null
    state.pendingMutation = null
    state.pendingMutationId = null
    state.restoredFromCache = false
    state.error = null
    state.leaveBlockReason = null
    state.status = 'ready'
    state.composing = false
    state.inserting = false
    state.selectionRequest = null
    localContentPreserved = false
    capabilityBlockedAtLoad = false
    undoStack.clear()

    if (note.access_state === 'restricted') {
      state.saveStatus = 'restricted'
      state.blockReason = 'note_access_restricted'
      cleanupPersistentDrafts()
      return
    }
    if (note.edit_schema !== NOTE_EDIT_SCHEMA_D2_V1) {
      // 旧未保护 Note 保持旧表单行为：新编辑器 fail-closed，不做无 revision 编辑。
      state.saveStatus = 'blocked'
      state.blockReason = 'note_edit_schema_unsupported'
      return
    }
    if (note.revision === null || note.snapshot_hash === null) {
      state.saveStatus = 'blocked'
      state.blockReason = 'note_snapshot_unavailable'
      return
    }
    if (isAdminReadonly) {
      state.saveStatus = 'restricted'
      state.blockReason = 'note_access_restricted'
      state.cacheStatus = 'unavailable'
      return
    }
    const capabilityBlock = capabilityExistingBlockReason()
    if (capabilityBlock !== null) {
      state.saveStatus = 'blocked'
      state.blockReason = capabilityBlock
      capabilityBlockedAtLoad = true
      // 能力故障不得显示为已保存/可编辑，但必须保留用户的本地草稿：只读展示并
      // 允许复制/下载取回（离开保护会要求显式放弃）；绝不据此写服务端。
      if (optionsBundle.restoreDraft) {
        const pendingRecord = readDraftForCurrentNote()
        if (pendingRecord !== null) {
          state.title = pendingRecord.title
          state.content = pendingRecord.content
          state.localSeq = Math.max(pendingRecord.localSeq, 0)
          state.ackedSeq = 0
          state.restoredFromCache = true
          bumpCacheStatusFromRead(pendingRecord)
        }
      }
      return
    }
    if (!optionsBundle.restoreDraft) {
      state.saveStatus = 'saved'
      removeCurrentDraftCache()
      return
    }
    const record = readDraftForCurrentNote()
    if (record === null) {
      state.saveStatus = 'saved'
      removeCurrentDraftCache()
      return
    }
    applyDraftRecord(record)
  }

  function applyDraftRecord(record: NoteDraftCacheRecord): void {
    state.title = record.title
    state.content = record.content
    state.localSeq = Math.max(record.localSeq, 0)
    state.ackedSeq = 0
    state.restoredFromCache = true
    bumpCacheStatusFromRead(record)

    const pendingMutation =
      record.pendingMutation !== null &&
      (record.pendingMutation.kind === 'save' || record.pendingMutation.kind === 'fragment') &&
      record.pendingMutation.noteId === state.noteId
        ? record.pendingMutation
        : null
    const sameAsServer =
      record.title === state.baseTitle && record.content === state.baseContent
    if (sameAsServer && pendingMutation === null) {
      // 服务端已含该内容（ACK 后清理失败/内容回退）：按已保存处理并清掉旧缓存。
      state.localSeq = 0
      state.ackedSeq = 0
      state.dirty = false
      state.saveStatus = 'saved'
      removeCurrentDraftCache()
      return
    }
    state.dirty = state.localSeq > state.ackedSeq
    if (pendingMutation !== null) {
      state.pendingMutation = pendingMutation
      state.pendingMutationId = pendingMutation.mutationId
      state.saveStatus = 'unknown'
      state.leaveBlockReason = 'unknown'
      return
    }
    if (
      record.baseRevision !== state.serverRevision ||
      record.baseSnapshotHash !== state.serverSnapshotHash
    ) {
      // 草稿基于另一个服务端版本：不静默覆盖（禁止强制覆盖/自动合并），
      // 交由用户选择 复制 / 受保护另存 / 加载最新版。
      state.conflict = {
        currentRevision: state.serverRevision,
        currentSnapshotHash: state.serverSnapshotHash,
      }
      state.saveStatus = 'conflict'
      return
    }
    state.saveStatus = 'pending'
    scheduleDebounce()
  }

  /** 能力恢复后补恢复本地草稿（加载时因能力故障被阻断的场景）。 */
  function tryRestoreDraftAfterCapabilityRecovery(): void {
    if (!capabilityBlockedAtLoad || state.noteId === null) return
    const record = readDraftForCurrentNote()
    capabilityBlockedAtLoad = false
    state.blockReason = null
    if (record === null) {
      // 草稿已被其它标签/显式放弃清理：回到服务端已确认基线，避免只读残留的
      // 本地文本被误当成已保存内容。
      state.title = state.baseTitle
      state.content = state.baseContent
      state.localSeq = 0
      state.ackedSeq = 0
      state.dirty = false
      state.restoredFromCache = false
      state.saveStatus = 'saved'
      return
    }
    applyDraftRecord(record)
  }

  // ── 编辑输入 ──

  function applyEdit(nextTitle: string, nextContent: string): void {
    if (!canEdit()) return
    if (nextTitle === state.title && nextContent === state.content) return
    undoStack.observe({ title: state.title, content: state.content })
    state.title = nextTitle
    state.content = nextContent
    state.localSeq += 1
    state.dirty = true
    if (state.error !== null) state.error = null
    if (state.saveStatus === 'saved' || state.saveStatus === 'idle') {
      state.saveStatus = 'pending'
    } else if (state.saveStatus === 'failed') {
      // 新输入触发新的保存尝试（旧失败请求已结算，不是未知结果）。
      state.saveStatus = 'pending'
    }
    writeCache()
    if (!state.composing && canAutoSave()) scheduleDebounce()
    emit()
  }

  function setTitle(value: string): void {
    applyEdit(value, state.content)
  }

  function setContent(value: string): void {
    applyEdit(state.title, value)
  }

  function beginComposition(): void {
    if (disposed) return
    state.composing = true
    emit()
  }

  function endComposition(): void {
    if (disposed || !state.composing) return
    state.composing = false
    undoStack.breakGroup()
    if (state.dirty && canAutoSave()) scheduleDebounce()
    emit()
  }

  // ── 保存派发与结算 ──

  function buildSaveRequest(write: InFlightWrite): NoteD2SaveRequest {
    return {
      mutation_id: write.mutationId,
      expected_revision: write.expectedRevision ?? 1,
      title: write.capturedTitle,
      content: write.capturedContent,
    }
  }

  async function dispatchSave(): Promise<void> {
    if (disposed) return
    clearDebounce()
    if (state.pendingMutation !== null && state.saveStatus === 'unknown') {
      await confirmPendingMutation()
      return
    }
    if (state.inFlight !== null) {
      queuedAfterFlight = true
      return
    }
    if (!canAutoSave()) return
    if (!state.dirty) {
      state.saveStatus = 'saved'
      writeCache()
      emit()
      return
    }
    const noteId = state.noteId
    const expectedRevision = state.serverRevision
    if (noteId === null || expectedRevision === null) return

    const write: InFlightWrite = {
      kind: 'save',
      mutationId: nextMutationId(),
      noteId,
      capturedSeq: state.localSeq,
      capturedTitle: state.title,
      capturedContent: state.content,
      expectedRevision,
      generation: currentGeneration,
      projectId: currentProjectId,
      openToken,
    }
    state.pendingMutation = {
      mutationId: write.mutationId,
      kind: 'save',
      noteId,
      expectedRevision,
      title: write.capturedTitle,
      content: write.capturedContent,
      createdAt: now().toISOString(),
    }
    state.pendingMutationId = write.mutationId
    writeCache()
    state.inFlight = write
    state.saveStatus = 'saving'
    state.error = null
    state.leaveBlockReason = null
    emit()

    try {
      const receipt = await client.saveNote(
        write.projectId,
        noteId,
        buildSaveRequest(write),
      )
      handleSaveReceipt(write, receipt)
    } catch (error) {
      if (isStaleWrite(write)) return
      handleSaveFailure(write, normalizeNoteApiError(error))
      emit()
    }
  }

  function handleSaveReceipt(write: InFlightWrite, receipt: NoteReceipt): void {
    if (isStaleWrite(write)) return
    state.inFlight = null
    state.serverRevision = receipt.applied_revision
    state.serverSnapshotHash = receipt.snapshot_hash ?? state.serverSnapshotHash
    state.baseTitle = write.capturedTitle
    state.baseContent = write.capturedContent
    syncNoteFromReceipt(receipt, write.capturedTitle, write.capturedContent)
    state.pendingMutation = null
    state.pendingMutationId = null
    state.ackedSeq = Math.max(state.ackedSeq, write.capturedSeq)
    state.dirty = state.localSeq > state.ackedSeq
    state.saveStatus = state.dirty ? 'pending' : 'saved'
    state.error = null
    state.leaveBlockReason = null
    writeCache()
    if (discardAfterFlight) {
      discardAfterFlight = false
      discardLocalInternal()
      emit()
      return
    }
    emit()
    const shouldContinue = queuedAfterFlight || (state.dirty && canAutoSave())
    queuedAfterFlight = false
    if (shouldContinue && canAutoSave() && state.dirty) {
      void dispatchSave()
    }
  }

  function handleSaveFailure(write: InFlightWrite, apiError: NoteApiError): void {
    if (isStaleWrite(write)) return
    state.inFlight = null
    state.error = apiError
    state.conflict = null
    switch (apiError.code) {
      case 'note_revision_conflict':
        state.conflict = {
          currentRevision: apiError.currentRevision ?? null,
          currentSnapshotHash: apiError.currentSnapshotHash ?? null,
        }
        state.saveStatus = 'conflict'
        state.pendingMutation = null
        state.pendingMutationId = null
        writeCache()
        return
      case 'note_access_restricted':
        state.saveStatus = 'restricted'
        state.blockReason = 'note_access_restricted'
        state.pendingMutation = null
        state.pendingMutationId = null
        cleanupPersistentDrafts()
        return
      case 'note_not_found':
        state.saveStatus = 'failed'
        state.blockReason = 'note_not_found'
        state.pendingMutation = null
        state.pendingMutationId = null
        writeCache()
        return
      case 'note_revision_required':
      case 'note_edit_schema_unsupported':
      case 'note_revision_exhausted':
      case 'note_snapshot_fence_exhausted':
        state.saveStatus = 'blocked'
        state.blockReason = apiError.code
        state.pendingMutation = null
        state.pendingMutationId = null
        writeCache()
        return
      default:
        break
    }
    if (apiError.retryable) {
      // 结果未知：保留同一 mutation + 完整请求，确认前禁止新写入/静默导航。
      state.saveStatus = 'unknown'
      state.leaveBlockReason = 'unknown'
      return
    }
    state.saveStatus = 'failed'
    state.pendingMutation = null
    state.pendingMutationId = null
    writeCache()
  }

  // ── PR5/B3：片段插入保护（方案 §4.3/§5） ──

  /** 把 UTF-16 选区收敛到当前正文的安全边界；切代理对返回 null。 */
  function clampSelection(
    content: string,
    selection: EditorTextSelectionSnapshot,
  ): EditorTextSelectionSnapshot | null {
    const max = content.length
    const start = Math.max(0, Math.min(selection.start, max))
    const end = Math.max(0, Math.min(selection.end, max))
    if (splitsSurrogatePair(content, start) || splitsSurrogatePair(content, end)) return null
    return { start: Math.min(start, end), end: Math.max(start, end) }
  }

  function validateFragmentTarget(
    content: string,
    target: NoteInsertFragmentInput['target'],
  ): NoteApiError | null {
    if (target.kind === 'cursor') {
      if (!Number.isInteger(target.position_utf16) || target.position_utf16 < 0) {
        return stateError('note_request_invalid', 'invalid fragment cursor', false, 422)
      }
      if (target.position_utf16 > content.length) {
        return stateError('note_request_invalid', 'fragment cursor is out of bounds', false, 422)
      }
      if (splitsSurrogatePair(content, target.position_utf16)) {
        return stateError('note_request_invalid', 'fragment cursor splits a surrogate pair', false, 422)
      }
      return null
    }
    const { start_utf16: start, end_utf16: end } = target
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end) {
      return stateError('note_request_invalid', 'invalid fragment range', false, 422)
    }
    if (end > content.length) {
      return stateError('note_request_invalid', 'fragment range is out of bounds', false, 422)
    }
    if (splitsSurrogatePair(content, start) || splitsSurrogatePair(content, end)) {
      return stateError('note_request_invalid', 'fragment range splits a surrogate pair', false, 422)
    }
    return null
  }

  /**
   * 未知/不可重试结果的状态归并。可重试（retryable）时保留同一 pending
   * mutation（同 mutation_id 重放）；其余按契约稳定码落到显式状态。
   */
  function settleFragmentFailure(
    write: InFlightWrite,
    apiError: NoteApiError,
  ): NoteInsertFragmentResult {
    if (isStaleWrite(write)) {
      return { ok: false, code: apiError.code, retryable: false }
    }
    state.inFlight = null
    state.inserting = false
    state.error = apiError
    if (apiError.retryable) {
      state.saveStatus = 'unknown'
      state.leaveBlockReason = 'unknown'
      writeCache()
      emit()
      return {
        ok: false,
        code: apiError.code,
        retryable: true,
        pendingMutationId: state.pendingMutation?.mutationId ?? write.mutationId,
      }
    }
    state.pendingMutation = null
    state.pendingMutationId = null
    switch (apiError.code) {
      case 'note_revision_conflict':
        state.conflict = {
          currentRevision: apiError.currentRevision ?? null,
          currentSnapshotHash: apiError.currentSnapshotHash ?? null,
        }
        state.saveStatus = 'conflict'
        break
      case 'note_access_restricted':
        state.saveStatus = 'restricted'
        state.blockReason = 'note_access_restricted'
        cleanupPersistentDrafts()
        break
      case 'note_not_found':
      case 'fragment_source_not_found':
        state.saveStatus = 'failed'
        break
      case 'note_revision_required':
      case 'note_edit_schema_unsupported':
      case 'note_revision_exhausted':
      case 'note_snapshot_fence_exhausted':
        state.saveStatus = 'blocked'
        state.blockReason = apiError.code
        break
      default:
        state.saveStatus = 'failed'
        break
    }
    writeCache()
    emit()
    return { ok: false, code: apiError.code, retryable: false }
  }

  /** 回执已确认后的读回与落盘：再按身份/localSeq 判定是否允许覆盖编辑器。 */
  async function completeFragmentWrite(
    write: InFlightWrite,
    receipt: NoteReceipt,
  ): Promise<NoteInsertFragmentResult> {
    if (isStaleWrite(write)) {
      state.inserting = false
      return { ok: false, code: 'note_store_unavailable', retryable: false }
    }
    state.inFlight = null
    const isCurrentDocument = (): boolean =>
      !disposed &&
      write.openToken === openToken &&
      write.projectId === currentProjectId &&
      write.generation === currentGeneration &&
      state.noteId === write.noteId
    if (!isCurrentDocument()) {
      // 过期响应：绝不覆盖新打开的文档；服务端已应用也不回填本地状态。
      state.inserting = false
      if (state.noteId === write.noteId) {
        state.pendingMutation = null
        state.pendingMutationId = null
        writeCache()
      }
      emit()
      return { ok: false, code: 'note_store_unavailable', retryable: false }
    }
    const unchangedSinceStart = (): boolean =>
      state.localSeq === write.capturedSeq &&
      state.title === write.capturedTitle &&
      state.content === write.capturedContent
    if (!unchangedSinceStart()) {
      // 期间产生新草稿：不加载回执/GET 旧正文覆盖；进入冲突态由用户选择。
      state.serverRevision = receipt.applied_revision
      state.serverSnapshotHash = receipt.snapshot_hash ?? state.serverSnapshotHash
      state.pendingMutation = null
      state.pendingMutationId = null
      state.inserting = false
      state.conflict = {
        currentRevision: receipt.applied_revision,
        currentSnapshotHash: receipt.snapshot_hash ?? state.serverSnapshotHash,
      }
      state.saveStatus = 'conflict'
      state.error = null
      state.leaveBlockReason = null
      writeCache()
      emit()
      return { ok: false, code: 'note_revision_conflict', retryable: false }
    }
    let loaded: ResearchNoteD2
    try {
      loaded = await client.getNote(write.projectId, write.noteId ?? '')
    } catch (error) {
      if (!isCurrentDocument()) {
        state.inserting = false
        emit()
        return { ok: false, code: 'note_store_unavailable', retryable: false }
      }
      if (!unchangedSinceStart()) {
        state.inserting = false
        state.serverRevision = receipt.applied_revision
        state.serverSnapshotHash = receipt.snapshot_hash ?? state.serverSnapshotHash
        state.pendingMutation = null
        state.pendingMutationId = null
        state.conflict = {
          currentRevision: receipt.applied_revision,
          currentSnapshotHash: receipt.snapshot_hash ?? state.serverSnapshotHash,
        }
        state.saveStatus = 'conflict'
        writeCache()
        emit()
        return { ok: false, code: 'note_revision_conflict', retryable: false }
      }
      // 服务端已应用但读回失败：保留同一 mutation 待确认（重放 replayed=true 再读）。
      const apiError = normalizeNoteApiError(error)
      state.error = apiError
      state.inserting = false
      if (apiError.retryable) {
        state.saveStatus = 'unknown'
        state.leaveBlockReason = 'unknown'
      } else {
        state.saveStatus = 'failed'
        state.pendingMutation = null
        state.pendingMutationId = null
      }
      writeCache()
      emit()
      return apiError.retryable
        ? {
            ok: false,
            code: apiError.code,
            retryable: true,
            pendingMutationId: write.mutationId,
          }
        : { ok: false, code: apiError.code, retryable: false }
    }
    if (!isCurrentDocument() || !unchangedSinceStart()) {
      // 读回期间身份/草稿再次变化：保留当前编辑器，不套用旧结果。
      state.inserting = false
      state.serverRevision = Math.max(
        state.serverRevision ?? receipt.applied_revision,
        receipt.applied_revision,
      )
      state.serverSnapshotHash = receipt.snapshot_hash ?? state.serverSnapshotHash
      state.pendingMutation = null
      state.pendingMutationId = null
      state.conflict = {
        currentRevision: receipt.applied_revision,
        currentSnapshotHash: receipt.snapshot_hash ?? state.serverSnapshotHash,
      }
      state.saveStatus = 'conflict'
      writeCache()
      emit()
      return { ok: false, code: 'note_revision_conflict', retryable: false }
    }
    const insertedRange =
      computeInsertedRange(write.capturedContent, loaded.content) ?? {
        start: loaded.content.length,
        end: loaded.content.length,
      }
    // 单次插入 = 一个普通撤销单元：保存插入前正文与选区，自动保存 ACK 不清空。
    undoStack.observe(
      {
        title: write.capturedTitle,
        content: write.capturedContent,
        ...(write.editorSelection === null || write.editorSelection === undefined
          ? {}
          : { selection: write.editorSelection }),
      },
      { breakGroup: true },
    )
    state.note = loaded
    state.serverRevision = loaded.revision ?? receipt.applied_revision
    state.serverSnapshotHash =
      loaded.snapshot_hash ?? receipt.snapshot_hash ?? state.serverSnapshotHash
    state.baseTitle = loaded.title
    state.baseContent = loaded.content
    state.title = loaded.title
    state.content = loaded.content
    state.localSeq += 1
    state.ackedSeq = state.localSeq
    state.dirty = false
    state.pendingMutation = null
    state.pendingMutationId = null
    state.conflict = null
    state.error = null
    state.leaveBlockReason = null
    state.inserting = false
    state.status = 'ready'
    localContentPreserved = false
    if (loaded.access_state === 'restricted') {
      state.saveStatus = 'restricted'
      state.blockReason = 'note_access_restricted'
      cleanupPersistentDrafts()
    } else if (loaded.edit_schema !== NOTE_EDIT_SCHEMA_D2_V1) {
      state.saveStatus = 'blocked'
      state.blockReason = 'note_edit_schema_unsupported'
    } else {
      state.saveStatus = 'saved'
    }
    const cursor = clampSelection(state.content, {
      start: insertedRange.end,
      end: insertedRange.end,
    })
    if (cursor !== null) {
      state.selectionSeq += 1
      state.selectionRequest = { selection: cursor, scrollTop: null, seq: state.selectionSeq }
    }
    writeCache()
    emit()
    return {
      ok: true,
      noteId: loaded.note_id,
      appliedRevision: state.serverRevision ?? receipt.applied_revision,
      snapshotHash: state.serverSnapshotHash,
      insertedRange,
      replayed: receipt.replayed,
    }
  }

  /** 提交片段请求（新请求与同 mutation 重放共用）。 */
  async function dispatchFragment(
    write: InFlightWrite,
  ): Promise<NoteInsertFragmentResult> {
    const fragment = write.fragment
    if (fragment === undefined) {
      state.inserting = false
      return { ok: false, code: 'note_request_invalid', retryable: false }
    }
    state.inFlight = write
    state.inserting = true
    state.saveStatus = 'saving'
    state.error = null
    state.leaveBlockReason = null
    emit()
    try {
      const receipt = await client.insertFragment(write.projectId, write.noteId ?? '', {
        mutation_id: write.mutationId,
        expected_revision: write.expectedRevision ?? 1,
        target: fragment.target,
        source: fragment.source,
      })
      return await completeFragmentWrite(write, receipt)
    } catch (error) {
      if (isStaleWrite(write)) {
        state.inFlight = null
        state.inserting = false
        emit()
        return { ok: false, code: 'note_store_unavailable', retryable: false }
      }
      return settleFragmentFailure(write, normalizeNoteApiError(error))
    }
  }

  /**
   * 片段插入（当前打开文档）。
   *
   * 顺序（方案 §4.3）：先 flush 当前草稿（失败/冲突/未知结果不发插入）→ 暂停
   * 正文编辑 → 提交 → 读回对齐 revision → 仅在身份/localSeq/正文未变化时
   * 应用并恢复光标；结果未知保留同一 mutation 与本地草稿供确认重放。
   */
  async function insertFragment(
    input: NoteInsertFragmentInput,
    editorSelection?: EditorTextSelectionSnapshot | null,
  ): Promise<NoteInsertFragmentResult> {
    if (disposed || state.status !== 'ready' || state.noteId === null) {
      return { ok: false, code: 'note_revision_required', retryable: false }
    }
    if (
      state.pendingMutation !== null &&
      (state.saveStatus === 'unknown' || state.inserting)
    ) {
      return {
        ok: false,
        code: 'note_store_unavailable',
        retryable: true,
        pendingMutationId: state.pendingMutation.mutationId,
      }
    }
    if (state.inFlight !== null) await waitForSettle()
    if (disposed || state.status !== 'ready' || state.noteId === null) {
      return { ok: false, code: 'note_revision_required', retryable: false }
    }
    const targetError = validateFragmentTarget(state.content, input.target)
    if (targetError !== null) {
      state.error = targetError
      state.saveStatus = 'failed'
      emit()
      return { ok: false, code: 'note_request_invalid', retryable: false }
    }
    endCompositionInternal()
    clearDebounce()
    if (state.dirty) {
      // 插入前先落盘当前草稿；保存失败/冲突/未知结果不继续插入。
      await saveNow()
    }
    if (disposed || state.status !== 'ready' || state.noteId === null) {
      return { ok: false, code: 'note_revision_required', retryable: false }
    }
    if (state.inFlight !== null) await waitForSettle()
    if (state.dirty || state.pendingMutation !== null) {
      const code: NoteApiError['code'] =
        state.saveStatus === 'conflict'
          ? 'note_revision_conflict'
          : state.saveStatus === 'restricted'
            ? 'note_access_restricted'
            : state.saveStatus === 'blocked'
              ? 'note_edit_schema_unsupported'
              : 'note_store_unavailable'
      return { ok: false, code, retryable: code === 'note_store_unavailable' }
    }
    const noteId = state.noteId
    const expectedRevision = state.serverRevision
    if (noteId === null || expectedRevision === null) {
      return { ok: false, code: 'note_revision_required', retryable: false }
    }
    const mutationId = nextMutationId()
    const capturedSeq = state.localSeq
    const capturedTitle = state.title
    const capturedContent = state.content
    const selection =
      editorSelection === null || editorSelection === undefined
        ? null
        : clampSelection(capturedContent, editorSelection)
    const pendingMutation: PendingNoteMutation = {
      mutationId,
      kind: 'fragment',
      noteId,
      expectedRevision,
      title: capturedTitle,
      content: capturedContent,
      createdAt: now().toISOString(),
      fragment: input,
      editorSelection: selection,
      capturedLocalSeq: capturedSeq,
    }
    state.pendingMutation = pendingMutation
    state.pendingMutationId = mutationId
    writeCache()
    const write: InFlightWrite = {
      kind: 'fragment',
      mutationId,
      noteId,
      capturedSeq,
      capturedTitle,
      capturedContent,
      expectedRevision,
      generation: currentGeneration,
      projectId: currentProjectId,
      openToken,
      fragment: input,
      editorSelection: selection,
    }
    return dispatchFragment(write)
  }

  /** 未知结果的同一 mutation_id 重放（同目标、同 expected_revision、同请求）。 */
  async function replayFragment(pending: PendingNoteMutation): Promise<void> {
    if (disposed || state.inFlight !== null) return
    if (
      pending.noteId === null ||
      pending.noteId !== state.noteId ||
      pending.fragment === null ||
      pending.fragment === undefined ||
      pending.expectedRevision === null
    ) {
      state.pendingMutation = null
      state.pendingMutationId = null
      state.saveStatus = 'failed'
      state.error = stateError(
        'note_request_invalid',
        'fragment replay is missing the frozen request',
        false,
        422,
      )
      writeCache()
      emit()
      return
    }
    const write: InFlightWrite = {
      kind: 'fragment',
      mutationId: pending.mutationId,
      noteId: pending.noteId,
      capturedSeq: pending.capturedLocalSeq ?? state.localSeq,
      capturedTitle: pending.title,
      capturedContent: pending.content,
      expectedRevision: pending.expectedRevision,
      generation: currentGeneration,
      projectId: currentProjectId,
      openToken,
      fragment: pending.fragment,
      editorSelection: pending.editorSelection ?? null,
    }
    await dispatchFragment(write)
  }

  /**
   * 引用核查返回时恢复原选区/滚动位置（方案 §5.2）。
   * 只在文档与 localSeq 仍匹配时生效；否则保留当前光标（返回 false，不回放旧坐标）。
   */
  function restoreEditorPosition(request: NoteEditorPositionRestoreRequest): boolean {
    if (disposed || state.status !== 'ready' || state.noteId !== request.noteId) return false
    if (state.localSeq !== request.expectedLocalSeq) return false
    let selection: EditorTextSelectionSnapshot | null = null
    if (request.selection !== null) {
      selection = clampSelection(state.content, request.selection)
      if (selection === null) return false
    }
    state.selectionSeq += 1
    state.selectionRequest = {
      selection,
      scrollTop: request.scrollTop,
      seq: state.selectionSeq,
    }
    emit()
    return true
  }

  async function confirmPendingMutation(): Promise<void> {
    if (disposed) return
    const pending = state.pendingMutation
    if (pending === null) return
    endCompositionInternal()
    clearDebounce()

    if (pending.kind === 'save') {
      if (state.noteId === null || pending.noteId !== state.noteId) {
        state.pendingMutation = null
        state.pendingMutationId = null
        writeCache()
        emit()
        return
      }
      if (state.inFlight !== null) return
      const write: InFlightWrite = {
        kind: 'save',
        mutationId: pending.mutationId,
        noteId: pending.noteId,
        capturedSeq: state.localSeq,
        capturedTitle: pending.title,
        capturedContent: pending.content,
        expectedRevision: pending.expectedRevision,
        generation: currentGeneration,
        projectId: currentProjectId,
        openToken,
      }
      state.inFlight = write
      state.saveStatus = 'saving'
      state.error = null
      emit()
      try {
        const receipt = await client.saveNote(
          write.projectId,
          write.noteId ?? '',
          buildSaveRequest(write),
        )
        if (isStaleWrite(write)) return
        state.inFlight = null
        state.serverRevision = receipt.applied_revision
        state.serverSnapshotHash = receipt.snapshot_hash ?? state.serverSnapshotHash
        state.baseTitle = pending.title
        state.baseContent = pending.content
        syncNoteFromReceipt(receipt, pending.title, pending.content)
        state.pendingMutation = null
        state.pendingMutationId = null
        state.error = null
        state.leaveBlockReason = null
        const contentMatches =
          pending.title === state.title && pending.content === state.content
        if (contentMatches) state.ackedSeq = state.localSeq
        state.dirty = state.localSeq > state.ackedSeq
        state.saveStatus = state.dirty ? 'pending' : 'saved'
        writeCache()
        emit()
        if (state.dirty && canAutoSave()) void dispatchSave()
      } catch (error) {
        if (isStaleWrite(write)) return
        handleSaveFailure(write, normalizeNoteApiError(error))
        emit()
      }
      return
    }

    if (pending.kind === 'fragment') {
      await replayFragment(pending)
      return
    }

    if (pending.kind === 'create') {
      await replayCreate(pending)
      return
    }

    await replayCopy(pending)
  }

  async function retrySave(): Promise<void> {
    if (disposed) return
    endCompositionInternal()
    clearDebounce()
    if (state.pendingMutation !== null || state.saveStatus === 'unknown') {
      await confirmPendingMutation()
      return
    }
    if (
      state.saveStatus === 'conflict' ||
      state.saveStatus === 'restricted' ||
      state.saveStatus === 'blocked'
    ) {
      return
    }
    state.error = null
    if (state.saveStatus === 'failed') state.saveStatus = 'pending'
    if (state.inFlight !== null) await waitForSettle()
    if (!state.dirty) {
      state.saveStatus = 'saved'
      writeCache()
      emit()
      return
    }
    await saveNow()
  }

  async function saveNow(): Promise<void> {
    if (disposed) return
    endCompositionInternal()
    clearDebounce()
    if (state.pendingMutation !== null && state.saveStatus === 'unknown') {
      await confirmPendingMutation()
      return
    }
    if (!canAutoSave()) return
    if (state.inFlight !== null) await waitForSettle()
    if (state.pendingMutation !== null) {
      await confirmPendingMutation()
      return
    }
    if (!state.dirty) {
      if (state.saveStatus !== 'saved') {
        state.saveStatus = 'saved'
        writeCache()
      }
      emit()
      return
    }
    await dispatchSave()
    await waitForSettle()
  }

  // ── 撤销/取回/另存/加载 ──

  function undo(): void {
    if (disposed || !canEdit()) return
    const snapshot = undoStack.undo()
    if (snapshot === null) {
      emit()
      return
    }
    endCompositionInternal()
    state.title = snapshot.title
    state.content = snapshot.content
    state.localSeq += 1
    state.dirty = state.localSeq > state.ackedSeq
    if (snapshot.selection !== undefined) {
      const restored = clampSelection(state.content, snapshot.selection)
      if (restored !== null) {
        state.selectionSeq += 1
        state.selectionRequest = { selection: restored, scrollTop: null, seq: state.selectionSeq }
      }
    }
    if (state.saveStatus === 'failed') {
      state.saveStatus = 'pending'
    } else if (state.saveStatus === 'saved' || state.saveStatus === 'idle') {
      state.saveStatus = state.dirty ? 'pending' : 'saved'
    }
    writeCache()
    if (canAutoSave()) scheduleDebounce()
    emit()
  }

  async function copyLocalContent(): Promise<void> {
    const writeClipboard = options.writeClipboard ?? defaultWriteClipboard
    try {
      await writeClipboard(state.content)
    } catch {
      // 剪贴板不可用（权限/环境）：用户仍可用下载本地 Markdown 取回。
    }
  }

  function downloadLocalMarkdown(): void {
    const input: NoteLocalDraftInput = {
      title: state.title,
      content: state.content,
      noteId: state.noteId,
      savedAt: lastCacheSavedAt,
    }
    if (options.downloadMarkdown) {
      options.downloadMarkdown(input)
      return
    }
    downloadLocalDraftMarkdown(input)
  }

  function resolveCopyTitle(): string | null {
    const candidates = [state.title, state.baseTitle]
    for (const candidate of candidates) {
      if (candidate.trim().length > 0) return candidate
    }
    return null
  }

  async function saveAsCopy(): Promise<string | null> {
    if (disposed) return null
    endCompositionInternal()
    const existingPending = state.pendingMutation
    if (existingPending !== null && existingPending.kind === 'copy') {
      return replayCopy(existingPending)
    }
    if (state.pendingMutation !== null && state.saveStatus === 'unknown') return null
    if (state.noteId === null) return null
    const sourceRevision = state.serverRevision
    const sourceSnapshotHash = state.serverSnapshotHash
    if (sourceRevision === null || sourceSnapshotHash === null) {
      state.error = stateError(
        'note_revision_required',
        'source revision is required for protected copy',
        false,
        428,
      )
      emit()
      return null
    }
    const title = resolveCopyTitle()
    if (title === null) {
      state.error = stateError(
        'note_request_invalid',
        'copy title must not be blank',
        false,
        422,
      )
      emit()
      return null
    }
    if (state.inFlight !== null) await waitForSettle()
    const pendingMutation: PendingNoteMutation = {
      mutationId: nextMutationId(),
      kind: 'copy',
      noteId: state.noteId,
      expectedRevision: sourceRevision,
      title,
      content: state.content,
      createdAt: now().toISOString(),
      sourceSnapshotHash,
    }
    state.pendingMutation = pendingMutation
    state.pendingMutationId = pendingMutation.mutationId
    writeCache()
    return replayCopy(pendingMutation)
  }

  async function replayCopy(pending: PendingNoteMutation): Promise<string | null> {
    if (disposed || state.inFlight !== null) return null
    if (pending.noteId === null || pending.noteId !== state.noteId) return null
    const sourceSnapshotHash = pending.sourceSnapshotHash ?? state.serverSnapshotHash
    if (
      pending.expectedRevision === null ||
      typeof sourceSnapshotHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sourceSnapshotHash)
    ) {
      state.pendingMutation = null
      state.pendingMutationId = null
      state.saveStatus = 'failed'
      state.error = stateError(
        'note_revision_required',
        'copy replay requires source revision and snapshot hash',
        false,
        428,
      )
      writeCache()
      emit()
      return null
    }
    const write: InFlightWrite = {
      kind: 'copy',
      mutationId: pending.mutationId,
      noteId: pending.noteId,
      capturedSeq: state.localSeq,
      capturedTitle: pending.title,
      capturedContent: pending.content,
      expectedRevision: pending.expectedRevision,
      generation: currentGeneration,
      projectId: currentProjectId,
      openToken,
    }
    state.inFlight = write
    state.saveStatus = 'saving'
    state.error = null
    emit()
    const request: NoteD2CopyRequest = {
      mutation_id: pending.mutationId,
      source_revision: pending.expectedRevision,
      source_snapshot_hash: sourceSnapshotHash,
      title: pending.title,
      content: pending.content,
    }
    try {
      const receipt = await client.copyNote(
        write.projectId,
        write.noteId ?? '',
        request,
      )
      if (isStaleWrite(write)) return null
      state.inFlight = null
      state.pendingMutation = null
      state.pendingMutationId = null
      state.error = null
      state.leaveBlockReason = null
      state.saveStatus = 'saved'
      // 本地正文已受保护保存到新 Note：允许随后丢弃源文档的本地编辑并安全离开。
      localContentPreserved = true
      writeCache()
      const noteId = state.noteId
      emit()
      if (noteId !== null) {
        try {
          const latest = await client.getNote(currentProjectId, noteId)
          if (
            !disposed &&
            state.noteId === noteId &&
            state.note !== null &&
            latest.note_id === noteId
          ) {
            applyLoadedNote(latest, { restoreDraft: false })
            localContentPreserved = false
            state.saveStatus = 'saved'
            emit()
          }
        } catch {
          // 回读失败：保留 localContentPreserved（离开时不再阻止）+ 当前冲突态。
        }
      }
      return receipt.note_id
    } catch (error) {
      if (isStaleWrite(write)) return null
      const apiError = normalizeNoteApiError(error)
      state.inFlight = null
      state.error = apiError
      if (apiError.retryable) {
        state.saveStatus = 'unknown'
        state.leaveBlockReason = 'unknown'
      } else {
        state.pendingMutation = null
        state.pendingMutationId = null
        state.saveStatus = 'failed'
        if (apiError.code === 'note_not_found') state.blockReason = 'note_not_found'
        writeCache()
      }
      emit()
      return null
    }
  }

  async function loadLatest(): Promise<void> {
    if (disposed || state.noteId === null) return
    // 未知结果必须先确认原 mutation（禁止确认前以「加载最新版」静默丢弃未决写）。
    if (state.pendingMutation !== null && state.saveStatus === 'unknown') return
    const noteId = state.noteId
    endCompositionInternal()
    clearDebounce()
    if (state.inFlight !== null) await waitForSettle()
    if (disposed || state.noteId !== noteId) return
    const target = current()
    state.status = 'loading'
    emit()
    try {
      const note = await client.getNote(currentProjectId, noteId)
      if (!isCurrent(target) || state.noteId !== noteId) return
      applyLoadedNote(note, { restoreDraft: false })
      state.conflict = null
      state.pendingMutation = null
      state.pendingMutationId = null
      state.error = null
      state.leaveBlockReason = null
      localContentPreserved = false
      if (state.saveStatus !== 'restricted' && state.saveStatus !== 'blocked') {
        state.saveStatus = 'saved'
      }
      removeCurrentDraftCache()
      emit()
    } catch (error) {
      if (!isCurrent(target) || state.noteId !== noteId) return
      state.status = 'ready'
      const apiError = normalizeNoteApiError(error)
      state.error = apiError
      if (apiError.code === 'note_access_restricted') {
        state.saveStatus = 'restricted'
        state.blockReason = 'note_access_restricted'
        cleanupPersistentDrafts()
      } else if (apiError.code === 'note_not_found') {
        state.saveStatus = 'failed'
        state.blockReason = 'note_not_found'
      } else {
        state.saveStatus = state.conflict !== null ? 'conflict' : 'failed'
      }
      emit()
    }
  }

  function discardLocalInternal(): void {
    endCompositionInternal()
    clearDebounce()
    const noteId = state.noteId
    // 受限态：必须清理该 Note 的全部持久草稿（方案 §4.2「权限受限后停止展示并
    // 清理对应持久缓存」）。失败/阻断态的显式放弃则至少清理当前标签页草稿。
    if (state.saveStatus === 'restricted' && currentViewerUserId.length > 0 && noteId !== null) {
      removeNoteDraftsForNote(currentViewerUserId, currentProjectId, noteId, cacheOptions())
    }
    // 「无已加载 document / 权限受限 / 删除 / 能力或 schema 阻断」的显式放弃：
    // 清内存文本与持久草稿，状态回 idle（随后 closeEditor/flushBeforeLeave 不再
    // 被永久阻断；方案 §4.4 允许「确认放弃」）。
    const fullReset =
      state.status !== 'ready' ||
      state.note === null ||
      state.blockReason !== null ||
      state.saveStatus === 'restricted' ||
      state.saveStatus === 'blocked'
    if (fullReset) {
      if (noteId !== null) removeCurrentDraftCache()
      resetState('idle', null)
      return
    }
    // 已加载文档（冲突 / 未知结果 / 普通失败 / 脏文本）：显式放弃 = 回到最近一次
    // 服务端确认基线并清未决 mutation；文档保持打开，随后可关闭或切换。
    state.title = state.baseTitle
    state.content = state.baseContent
    state.localSeq += 1
    state.ackedSeq = state.localSeq
    state.dirty = false
    state.pendingMutation = null
    state.pendingMutationId = null
    state.conflict = null
    state.error = null
    state.leaveBlockReason = null
    state.restoredFromCache = false
    localContentPreserved = false
    discardAfterFlight = false
    queuedAfterFlight = false
    undoStack.clear()
    state.saveStatus = 'saved'
    removeCurrentDraftCache()
  }

  function discardLocal(): void {
    if (disposed) return
    // 打开失败（status='error'）也必须允许显式放弃，否则 403/404/503 会把用户
    // 永久困在编辑器里（审查 A HIGH）。
    if (state.status !== 'ready' && state.status !== 'error') return
    if (state.inFlight !== null) {
      discardAfterFlight = true
      return
    }
    discardLocalInternal()
    emit()
  }

  // ── 新建空白文档 ──

  async function createBlankNote(): Promise<string | null> {
    if (disposed) return null
    const capabilityBlock = capabilityCreateBlockReason()
    if (capabilityBlock !== null) {
      state.saveStatus = 'blocked'
      state.blockReason = capabilityBlock
      emit()
      return null
    }
    if (state.pendingMutation !== null && state.pendingMutation.kind === 'create') {
      return replayCreate(state.pendingMutation)
    }
    if (state.noteId !== null) {
      const blocked = await flushBeforeLeave()
      if (blocked !== null) {
        state.leaveBlockReason = blocked
        emit()
        return null
      }
    }
    if (state.pendingMutation !== null) return null
    const pendingMutation: PendingNoteMutation = {
      mutationId: nextMutationId(),
      kind: 'create',
      noteId: null,
      expectedRevision: null,
      title: '',
      content: '',
      createdAt: now().toISOString(),
    }
    state.pendingMutation = pendingMutation
    state.pendingMutationId = pendingMutation.mutationId
    return replayCreate(pendingMutation)
  }

  async function replayCreate(pending: PendingNoteMutation): Promise<string | null> {
    if (disposed || state.inFlight !== null) return null
    const write: InFlightWrite = {
      kind: 'create',
      mutationId: pending.mutationId,
      noteId: null,
      capturedSeq: 0,
      capturedTitle: '',
      capturedContent: '',
      expectedRevision: null,
      generation: currentGeneration,
      projectId: currentProjectId,
      openToken,
    }
    state.inFlight = write
    state.status = 'loading'
    state.saveStatus = 'saving'
    state.error = null
    state.conflict = null
    emit()
    try {
      const receipt = await client.createNote(write.projectId, {
        mutation_id: pending.mutationId,
      })
      if (isStaleWrite(write)) return null
      state.inFlight = null
      state.pendingMutation = null
      state.pendingMutationId = null
      let note: ResearchNoteD2
      try {
        note = await client.getNote(write.projectId, receipt.note_id)
      } catch (error) {
        if (disposed || openToken !== write.openToken) return null
        const apiError = normalizeNoteApiError(error)
        state.status = 'error'
        state.saveStatus = 'failed'
        state.blockReason = apiError.code === 'note_not_found' ? 'note_not_found' : null
        state.error = apiError
        emit()
        return null
      }
      if (disposed || openToken !== write.openToken) return null
      resetState('ready', note.note_id)
      applyLoadedNote(note, { restoreDraft: false })
      state.status = 'ready'
      state.saveStatus = finalStatusAfterLoad()
      emit()
      return receipt.note_id
    } catch (error) {
      if (isStaleWrite(write)) return null
      state.inFlight = null
      const apiError = normalizeNoteApiError(error)
      state.error = apiError
      state.status = 'idle'
      if (apiError.retryable) {
        state.saveStatus = 'unknown'
        state.leaveBlockReason = 'unknown'
      } else {
        state.pendingMutation = null
        state.pendingMutationId = null
        state.saveStatus = 'blocked'
        state.blockReason = apiError.code === 'note_edit_schema_unsupported'
          ? apiError.code
          : null
      }
      emit()
      return null
    }
  }

  // ── 离开保护 ──

  async function flushBeforeLeave(): Promise<NoteLeaveBlockReason | null> {
    if (disposed) return null
    if (state.composing) endCompositionInternal()
    // 片段插入进行中：不得静默导航（结果未知或仍在写），先等结算/确认。
    if (state.inserting) return 'saving'
    if (localContentPreserved) {
      discardLocalInternal()
      emit()
      return null
    }
    if (state.pendingMutation !== null && state.saveStatus === 'unknown') return 'unknown'
    if (state.saveStatus === 'conflict') return 'conflict'
    // 受限/阻断/明确失败：只有存在不可静默丢弃的本地文本时才阻挡离开；无本地
    // 文本的阻断态（Admin 只读、加载失败的空白编辑器、schema/能力阻止但无草稿）
    // 必须允许直接关闭/切换（方案 §4.4，不得永久阻断）。
    if (state.saveStatus === 'restricted') {
      return hasUnsyncedLocalText() ? 'restricted' : null
    }
    if (state.saveStatus === 'blocked') {
      return hasUnsyncedLocalText() ? 'failed' : null
    }
    if (state.saveStatus === 'failed') {
      return hasUnsyncedLocalText() ? 'failed' : null
    }
    if (state.status === 'ready' && state.dirty) {
      await saveNow()
    }
    if (state.inFlight !== null) return 'saving'
    const finalStatus = readSaveStatus()
    if (finalStatus === 'unknown') return 'unknown'
    if (finalStatus === 'conflict') return 'conflict'
    if (finalStatus === 'restricted') {
      return hasUnsyncedLocalText() ? 'restricted' : null
    }
    if (finalStatus === 'blocked' || finalStatus === 'failed') {
      return hasUnsyncedLocalText() ? 'failed' : null
    }
    if (state.dirty) return 'unsaved'
    if (hasUnsyncedLocalText()) return 'unsaved'
    return null
  }

  /**
   * 摘入前 flush（review LOW-4）：复用 flushBeforeLeave 的全部守卫，但
   * `localContentPreserved` 分支不静默 discard 本地正文（插入不是导航）；
   * 返回 'unsaved' 让对话框显式阻断，用户可先处理副本再插入。
   */
  async function flushForInsert(): Promise<NoteLeaveBlockReason | null> {
    if (disposed) return null
    if (localContentPreserved) return 'unsaved'
    return flushBeforeLeave()
  }

  async function closeEditor(): Promise<boolean> {
    if (disposed) return true
    const blocked = await flushBeforeLeave()
    if (blocked !== null) {
      state.leaveBlockReason = blocked
      emit()
      return false
    }
    clearDebounce()
    // 仅在确认无本地未同步文本时清理本档持久草稿；阻断/失败态保留草稿供恢复
    // （受限态已在权限失败处置时清理）。
    if (!hasUnsyncedLocalText() && state.saveStatus !== 'blocked' && state.saveStatus !== 'failed') {
      removeCurrentDraftCache()
    }
    undoStack.clear()
    resetState('idle', null)
    emit()
    return true
  }

  // ── 身份/能力变化 ──

  function setIdentity(identity: NoteEditorIdentity): void {
    if (disposed) return
    const projectChanged = identity.projectId !== currentProjectId
    const viewerChanged = identity.viewerUserId !== currentViewerUserId
    const generationChanged = identity.authGeneration !== currentGeneration
    const adminReadonlyChanged = identity.isAdminReadonly !== isAdminReadonly
    currentProjectId = identity.projectId
    currentViewerUserId = identity.viewerUserId
    isAdminReadonly = identity.isAdminReadonly
    if (projectChanged || viewerChanged) {
      // 身份/项目切换：丢弃旧回调与旧视图状态；旧缓存使用权随分区失配作废。
      openToken += 1
      resetState('idle', null)
      currentGeneration = identity.authGeneration
      state.cacheStatus = currentViewerUserId.length > 0 ? 'ok' : 'unavailable'
      emit()
      return
    }
    if (generationChanged) {
      currentGeneration = identity.authGeneration
      if (state.inFlight !== null) {
        // 旧代回调已无意义：结果未知，保留同一 mutation 待（同 viewer）确认。
        state.inFlight = null
        if (state.pendingMutation !== null) {
          state.saveStatus = 'unknown'
          state.leaveBlockReason = 'unknown'
        }
        emit()
      }
      emit()
      return
    }
    if (adminReadonlyChanged && identity.isAdminReadonly) {
      // 同代身份变化：进入 Admin 只读时停止编辑与自动保存（保留本地草稿）。
      clearDebounce()
      if (state.status === 'ready') {
        state.saveStatus = state.saveStatus === 'saved' ? 'restricted' : state.saveStatus
        state.blockReason = 'note_access_restricted'
      }
      emit()
      return
    }
    if (adminReadonlyChanged && !identity.isAdminReadonly) {
      // 只读解除（同代角色变化）：d2-v1 文档恢复为可保存状态。
      if (
        state.status === 'ready' &&
        state.note !== null &&
        state.note.edit_schema === NOTE_EDIT_SCHEMA_D2_V1 &&
        state.blockReason === 'note_access_restricted'
      ) {
        state.blockReason = null
        if (capabilityExistingBlockReason() === null) {
          state.saveStatus = state.dirty ? 'pending' : 'saved'
          if (state.dirty && canAutoSave()) scheduleDebounce()
        } else {
          state.saveStatus = 'blocked'
          state.blockReason = capabilityExistingBlockReason()
        }
      }
      emit()
      return
    }
    emit()
  }

  function updateCapabilities(next: NoteCapabilities | null): void {
    if (disposed) return
    capabilities = next
    if (state.status !== 'ready' || state.note === null) {
      emit()
      return
    }
    if (state.note.edit_schema !== NOTE_EDIT_SCHEMA_D2_V1) {
      emit()
      return
    }
    if (isAdminReadonly) {
      emit()
      return
    }
    if (state.conflict !== null || state.saveStatus === 'unknown') {
      // 冲突/未知结果状态由各自流程掌控，能力变化不解除。
      emit()
      return
    }
    const block = capabilityExistingBlockReason()
    if (block !== null) {
      clearDebounce()
      if (
        state.saveStatus !== 'restricted' &&
        state.saveStatus !== 'blocked' &&
        state.saveStatus !== 'conflict'
      ) {
        state.saveStatus = 'blocked'
      }
      state.blockReason = block
      capabilityBlockedAtLoad = true
      emit()
      return
    }
    if (state.saveStatus === 'blocked' && isCapabilityBlock(state.blockReason)) {
      tryRestoreDraftAfterCapabilityRecovery()
      if (state.blockReason === null) {
        if (state.saveStatus === 'blocked') {
          state.saveStatus = state.dirty ? 'pending' : 'saved'
        }
        if (state.dirty && canAutoSave()) scheduleDebounce()
      }
    }
    emit()
  }

  // ── pagehide/未完成判定 ──

  function persistLocalDraft(): void {
    if (disposed) return
    if (state.status !== 'ready' && state.noteId === null) return
    if (state.serverRevision === null) return
    writeCache()
  }

  function hasUnfinishedWork(): boolean {
    if (disposed) return false
    return (
      state.inserting ||
      state.inFlight !== null ||
      state.pendingMutation !== null ||
      state.dirty ||
      isUnfinishedSaveStatus(state.saveStatus)
    )
  }

  function stop(): void {
    if (disposed) return
    // 只清定时器；不置 disposed、不清 listeners、不改 state——StrictMode
    // cleanup 后同一 machine 必须继续可用（remount 不会重建 machine）。
    clearDebounce()
  }

  function isDisposed(): boolean {
    return disposed
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearDebounce()
    const waiters = settleWaiters
    settleWaiters = []
    for (const resolve of waiters) resolve()
    listeners.clear()
  }

  // 初始快照（authGeneration 已在 publicState 中暴露）
  emit()

  return {
    getState: () => publicState,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getActions: () => actions,
    setIdentity,
    updateCapabilities,
    persistLocalDraft,
    hasUnfinishedWork,
    stop,
    isDisposed,
    dispose,
  }
}
