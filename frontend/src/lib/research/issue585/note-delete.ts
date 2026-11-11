/**
 * Issue #1134：d2-v1 受保护 Note 的删除状态机（成果目录行 / 编辑器入口共用）。
 *
 * 权威依据：
 * - 宿主 issue #1134（#1046 PR4 范围外的删除入口；期望行为「显式二次确认、
 *   走 d2-v1 DELETE（mutation_id + expected_revision 回执）、409/未知结果/403/
 *   依赖不可判定有明确状态与重试/取回语义、成功后清理本地草稿缓存」）；
 * - 机器契约 `deploy/research/issue585_d2_contract_v1.yaml` 的
 *   `note_delete` / `errors` / `replay`（`unknown_result`：同一 mutation_id
 *   与相同请求重试；`delete`：回执保留删除前 revision、snapshot_hash=null）；
 * - PR4 冻结的 `./note-client.ts`（`deleteNoteD2` 已存在）与 `./types.ts`
 *   （`NoteApiError` / `NoteReceipt` / `NoteCapabilities`）。
 *
 * 设计要点：
 * - 纯逻辑、无 React；client 可注入（默认 `noteApiClient`），单测用 fake；
 * - `expected_revision` 由调用方在发起时冻结（目录行 revision / 编辑器
 *   `state.note.revision`），**绝不**使用旧无 revision 删除路径；
 * - 能力 fail-closed：`note_editor_existing` 不可用/未知时守卫失败且不发请求
 *   （入口由 UI 隐藏，状态机再守一层）；Admin 只读同样只守卫不触网；
 * - 成功判定 = `deleteNoteD2` 返回合法回执且 `note_id` 与目标一致（畸形/不一致
 *   按结果未知处理，绝不清草稿、绝不按成功结算）；成功后清理该 Note 的全部
 *   本地草稿分支（注入的 `clearDrafts`，默认 versioned 草稿缓存）；
 * - 409 revision 冲突不走同 mutation 重放（同一 id 会再次 `mutation_id_reused`）：
 *   进入 `reconfirm`，由调用方刷新目录后用服务端已授权的
 *   `current_revision` 调 `reconfirm()` 重新进入二次确认；
 * - 依赖/快照不可判定、store/网络/未知码按 `retryable` 语义用**同一
 *   mutation_id + 同一 expected_revision** 重放确认（结果未定前不按成功结算，
 *   也不得丢失本地文本）；
 * - 单在途：pending 期间 confirm/retry/cancel/requestDelete 全部 no-op；
 * - 所有动作不抛异常：失败只体现在 state 上，返回 null。
 */

import {
  newNoteMutationId,
  normalizeNoteApiError,
  noteApiClient,
  noteProtocolError,
  type NoteApiClient,
} from './note-client'
import { removeNoteDraftsForNote } from './note-draft-cache'
import type { NoteApiError, NoteCapabilities, NoteReceipt } from './types'

// ── 冻结类型 ──

/** 删除流程的用户可见阶段（idle = 无对话框）。 */
export type NoteDeletePhase = 'idle' | 'confirming' | 'pending' | 'error'

/** 失败分类（UI 只按它映射文案，不展示原始错误正文）。 */
export type NoteDeleteFailureKind =
  | 'restricted'
  | 'not_found'
  | 'conflict'
  | 'stale_request'
  | 'unsupported'
  | 'unavailable'
  | 'unknown'

/**
 * 重试策略：
 * - `none`：终态，不提供重试；
 * - `new_mutation`：换新 mutation_id 重试（旧 mutation 已被其他请求占用）；
 * - `same_mutation`：复用同一 mutation_id + 同一 expected_revision 重放确认
 *   （结果未知/依赖不可判定；契约 replay `unknown_result`）；
 * - `reconfirm`：revision 冲突——先刷新目录，再用服务端已授权的
 *   `current_revision` 重新二次确认（调用方 `reconfirm()`）。
 */
export type NoteDeleteRetryMode = 'none' | 'same_mutation' | 'new_mutation' | 'reconfirm'

/** 删除流程状态（全部字段可序列化；UI 只读消费）。 */
export interface NoteDeleteState {
  phase: NoteDeletePhase
  /** 本次删除目标 note_id（idle 时为 null）。 */
  noteId: string | null
  /** 目标 Note 标题（确认对话框展示用；目录缺失/刷新后为空串，不臆造）。 */
  noteTitle: string
  /**
   * 目标 Note 正文投影（确认对话框复核用；取目录行/编辑器的当前文本，
   * 409 冲突刷新后更新为服务端最新读取结果）。绝不伪造，空串按空展示。
   */
  noteContent: string
  /** 本次删除冻结的 revision CAS 基线（idle 时为 null）。 */
  expectedRevision: number | null
  /** 已发送/待确认的 mutation_id（用于同 mutation 重放）。 */
  mutationId: string | null
  error: NoteApiError | null
  failureKind: NoteDeleteFailureKind | null
  retryMode: NoteDeleteRetryMode
  /** UI 级守卫的稳定机器码（admin_readonly / 能力 reason / 缺 revision）。 */
  blockReason: string | null
}

/** 删除动作（所有网络动作不抛异常，结果体现在 state / 返回值上）。 */
export interface NoteDeleteActions {
  /** 请求删除（打开二次确认；能力/权限/revision 守卫失败时不发请求）。 */
  requestDelete: (
    noteId: string,
    expectedRevision: number | null,
    noteTitle?: string,
    noteContent?: string,
  ) => void
  /** 关闭确认对话框（仅 confirming → idle）。 */
  cancel: () => void
  /**
   * 确认删除；成功返回 note_id（本地草稿已清理），失败/未知/冲突返回 null。
   * 每次新尝试都生成新 mutation_id。
   */
  confirmDelete: () => Promise<string | null>
  /**
   * 重试 error 阶段：
   * - same_mutation → 同一 mutation_id + 同一 expectedRevision 重放；
   * - new_mutation → 新 mutation_id；
   * - reconfirm → 不触网（调用方须先 `reconfirm(latestRevision)`）。
   */
  retry: () => Promise<string | null>
  /**
   * 409 冲突后的重新确认：调用方应先按既有权限**另行读取最新版**（GET），
   * 再把最新 revision/标题/正文传回；`expectedRevision=null` 表示该 Note 已
   * 消失，直接复位 idle（调用方负责刷新目录）。确认框据此呈现刷新后的目标，
   * 用户复核后再决定是否删除。
   */
  reconfirm: (
    expectedRevision: number | null,
    noteTitle?: string,
    noteContent?: string,
  ) => void
  /** 关闭错误对话框（仅 error → idle，清 error/mutation）。 */
  dismiss: () => void
}

export interface NoteDeleteMachineOptions {
  projectId: string
  /** 已认证 owner（草稿缓存命名空间首段；空串时不做草稿清理）。 */
  ownerId?: string
  isAdminReadonly: boolean
  capabilities: NoteCapabilities | null
  client?: NoteApiClient
  /** 可注入的 mutation_id 生成器（测试固定序列；生产用随机 uuid）。 */
  nextMutationId?: () => string
  /** 可注入的本地草稿清理（默认删除 versioned 草稿缓存的所有 tab 分支）。 */
  clearDrafts?: (noteId: string) => void
}

export interface NoteDeleteMachine {
  getState(): NoteDeleteState
  subscribe(listener: () => void): () => void
  getActions(): NoteDeleteActions
  /** hook 在能力投影变化时同步（不重建状态机）。 */
  updateCapabilities(capabilities: NoteCapabilities | null): void
  /** 永久销毁：仅身份/项目真正替换时调用；销毁后一切动作 no-op。 */
  dispose(): void
}

// ── 状态构造 ──

function createIdleState(): NoteDeleteState {
  return {
    phase: 'idle',
    noteId: null,
    noteTitle: '',
    noteContent: '',
    expectedRevision: null,
    mutationId: null,
    error: null,
    failureKind: null,
    retryMode: 'none',
    blockReason: null,
  }
}

/** UI 守卫失败的合成错误（不触网；code 仅用于统一展示兜底）。 */
function guardError(blockReason: string): NoteApiError {
  return {
    code: blockReason === 'admin_readonly' ? 'note_access_restricted' : 'note_store_unavailable',
    message: blockReason,
    retryable: false,
    status: 0,
  }
}

function guardFailureKind(blockReason: string): NoteDeleteFailureKind {
  if (blockReason === 'admin_readonly') return 'restricted'
  if (blockReason === 'note_revision_required') return 'unsupported'
  return 'unavailable'
}

// ── 错误分类（宿主 errors.py 的 retryable 语义） ──

interface NoteDeleteFailure {
  failureKind: NoteDeleteFailureKind
  retryMode: NoteDeleteRetryMode
}

/**
 * 归一化错误 → (failureKind, retryMode)。
 *
 * 终态（none）：不存在/受限/格式不支持/请求非法/缺 revision——重试无意义。
 * revision 冲突（reconfirm）：刷新后以已授权当前 revision 重新二次确认。
 * 旧 mutation 被占用（new_mutation）：换新 mutation_id 重试同一删除。
 * 依赖/快照不可判定（same_mutation）：可重试，且必须同一幂等键（契约）。
 * store/网络/未知码（same_mutation）：结果未知，先同请求确认再谈其他。
 */
export function classifyNoteDeleteError(error: NoteApiError): NoteDeleteFailure {
  switch (error.code) {
    case 'note_access_restricted':
      return { failureKind: 'restricted', retryMode: 'none' }
    case 'note_not_found':
      return { failureKind: 'not_found', retryMode: 'none' }
    case 'note_edit_schema_unsupported':
    case 'note_request_invalid':
      return { failureKind: 'unsupported', retryMode: 'none' }
    case 'note_revision_required':
      return { failureKind: 'unsupported', retryMode: 'none' }
    case 'note_revision_conflict':
    case 'note_revision_exhausted':
    case 'note_snapshot_fence_exhausted':
      return { failureKind: 'conflict', retryMode: 'reconfirm' }
    case 'mutation_id_reused':
      return { failureKind: 'stale_request', retryMode: 'new_mutation' }
    case 'note_dependency_unavailable':
    case 'note_snapshot_unavailable':
      return { failureKind: 'unavailable', retryMode: 'same_mutation' }
    case 'note_store_unavailable':
    case 'network_error':
    case 'unknown_error':
      return { failureKind: 'unknown', retryMode: 'same_mutation' }
    default:
      // 新增/未知稳定码一律按结果未知处理（保守：可能已应用）。
      return { failureKind: 'unknown', retryMode: 'same_mutation' }
  }
}

/** 能力位守卫：null/`note_editor_existing` 不可用 → 稳定原因码（fail-closed）。 */
export function noteDeleteBlockReason(capabilities: NoteCapabilities | null): string | null {
  if (capabilities === null) return 'capability_unknown'
  const capability = capabilities.noteEditorExisting
  if (capability === null || capability === undefined || capability.available !== true) {
    return typeof capability?.reason === 'string' && capability.reason.length > 0
      ? capability.reason
      : 'capability_unknown'
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 删除回执的 delete 专有校验（defense-in-depth，服务端为权威）：
 * `note_id` 必须为目标；`mutation_id` 必须是本次发送的幂等键；
 * `applied_revision` 必须等于冻结的 expected_revision（删除回执保留删除前
 * revision）；`snapshot_hash` 必须为 null（契约 `delete_snapshot_hash: null`）；
 * `replayed` 为布尔。任一不符 → 服务端可能已应用但回包不可信 ⇒ 结果未知。
 */
function isReceiptForNote(
  receipt: unknown,
  noteId: string,
  mutationId: string,
  expectedRevision: number,
): receipt is NoteReceipt {
  return (
    isRecord(receipt) &&
    receipt.note_id === noteId &&
    receipt.mutation_id === mutationId &&
    receipt.applied_revision === expectedRevision &&
    receipt.snapshot_hash === null &&
    typeof receipt.replayed === 'boolean'
  )
}

// ── 状态机 ──

export function createNoteDeleteMachine(options: NoteDeleteMachineOptions): NoteDeleteMachine {
  const client: NoteApiClient = options.client ?? noteApiClient
  const nextMutationId = options.nextMutationId ?? newNoteMutationId
  const projectId = options.projectId
  const ownerId = options.ownerId ?? ''
  const clearDrafts =
    options.clearDrafts ??
    ((noteId: string): void => {
      if (ownerId.length === 0) return
      removeNoteDraftsForNote(ownerId, projectId, noteId)
    })
  const isAdminReadonly = options.isAdminReadonly
  let capabilities = options.capabilities

  const listeners = new Set<() => void>()
  let disposed = false
  let state: NoteDeleteState = createIdleState()

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function setState(next: NoteDeleteState): void {
    state = next
    emit()
  }

  /** 守卫失败：不发请求；phase=error + blockReason + 合成错误。 */
  function failGuard(
    noteId: string,
    noteTitle: string,
    noteContent: string,
    blockReason: string,
  ): void {
    setState({
      phase: 'error',
      noteId,
      noteTitle,
      noteContent,
      expectedRevision: null,
      mutationId: null,
      error: guardError(blockReason),
      failureKind: guardFailureKind(blockReason),
      retryMode: 'none',
      blockReason,
    })
  }

  function failWithUnknown(
    noteId: string,
    noteTitle: string,
    noteContent: string,
    expectedRevision: number,
    mutationId: string,
  ): null {
    setState({
      phase: 'error',
      noteId,
      noteTitle,
      noteContent,
      expectedRevision,
      mutationId,
      error: noteProtocolError(),
      failureKind: 'unknown',
      retryMode: 'same_mutation',
      blockReason: null,
    })
    return null
  }

  function failWithError(
    noteId: string,
    noteTitle: string,
    noteContent: string,
    expectedRevision: number,
    mutationId: string,
    error: NoteApiError,
  ): null {
    const failure = classifyNoteDeleteError(error)
    setState({
      phase: 'error',
      noteId,
      noteTitle,
      noteContent,
      expectedRevision,
      mutationId,
      error,
      failureKind: failure.failureKind,
      retryMode: failure.retryMode,
      blockReason: null,
    })
    return null
  }

  /**
   * 发送一次删除请求（pending → 成功 idle / 失败 error）。
   *
   * 成功判定：回执是 `deleteNoteD2` 归一化后的 `NoteReceipt` 且 `note_id`
   * 与目标一致。成功后清理该 Note 的全部本地草稿分支；畸形/不一致回执按
   * 结果未知处理（同一 mutation 待确认），绝不清草稿、绝不按成功结算。
   */
  async function runDelete(
    noteId: string,
    noteTitle: string,
    noteContent: string,
    expectedRevision: number,
    mutationId: string,
  ): Promise<string | null> {
    setState({
      phase: 'pending',
      noteId,
      noteTitle,
      noteContent,
      expectedRevision,
      mutationId,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
    try {
      const receipt = await client.deleteNote(projectId, noteId, {
        mutation_id: mutationId,
        expected_revision: expectedRevision,
      })
      if (disposed) return null
      if (!isReceiptForNote(receipt, noteId, mutationId, expectedRevision)) {
        return failWithUnknown(
          noteId,
          noteTitle,
          noteContent,
          expectedRevision,
          mutationId,
        )
      }
      clearDrafts(noteId)
      setState(createIdleState())
      return noteId
    } catch (error) {
      if (disposed) return null
      return failWithError(
        noteId,
        noteTitle,
        noteContent,
        expectedRevision,
        mutationId,
        normalizeNoteApiError(error),
      )
    }
  }

  function requestDelete(
    noteId: string,
    expectedRevision: number | null,
    noteTitle = '',
    noteContent = '',
  ): void {
    if (disposed) return
    if (noteId.length === 0) return
    // 单在途：pending 期间不允许切换目标/重入。
    if (state.phase === 'pending') return
    if (isAdminReadonly) {
      failGuard(noteId, noteTitle, noteContent, 'admin_readonly')
      return
    }
    const block = noteDeleteBlockReason(capabilities)
    if (block !== null) {
      failGuard(noteId, noteTitle, noteContent, block)
      return
    }
    if (expectedRevision === null || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      // 没有可用的 revision 基线：绝不退回旧无 revision 删除路径。
      failGuard(noteId, noteTitle, noteContent, 'note_revision_required')
      return
    }
    setState({
      phase: 'confirming',
      noteId,
      noteTitle,
      noteContent,
      expectedRevision,
      mutationId: null,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
  }

  async function confirmDelete(): Promise<string | null> {
    if (disposed) return null
    if (state.phase !== 'confirming') return null
    const noteId = state.noteId
    const expectedRevision = state.expectedRevision
    if (noteId === null || expectedRevision === null) return null
    // 每次新尝试都生成新 mutation_id（绝不复用旧 id）。
    return runDelete(
      noteId,
      state.noteTitle,
      state.noteContent,
      expectedRevision,
      nextMutationId(),
    )
  }

  async function retry(): Promise<string | null> {
    if (disposed) return null
    if (state.phase !== 'error') return null
    if (state.retryMode === 'none' || state.retryMode === 'reconfirm') return null
    const noteId = state.noteId
    const expectedRevision = state.expectedRevision
    if (noteId === null || expectedRevision === null) return null
    // reconfirm 由调用方在刷新目录后显式调用；这里只处理可直接重放的两种。
    if (state.retryMode === 'same_mutation') {
      if (state.mutationId === null) return null
      // 同一 mutation_id + 同一 expected_revision = 完全相同的请求（契约 replay）。
      return runDelete(
        noteId,
        state.noteTitle,
        state.noteContent,
        expectedRevision,
        state.mutationId,
      )
    }
    return runDelete(
      noteId,
      state.noteTitle,
      state.noteContent,
      expectedRevision,
      nextMutationId(),
    )
  }

  function reconfirm(
    expectedRevision: number | null,
    noteTitle?: string,
    noteContent?: string,
  ): void {
    if (disposed) return
    if (state.phase !== 'error' || state.retryMode !== 'reconfirm') return
    const noteId = state.noteId
    const nextTitle = noteTitle ?? state.noteTitle
    const nextContent = noteContent ?? state.noteContent
    if (noteId === null) return
    if (
      expectedRevision === null ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 1
    ) {
      // 目标已消失/无法获得新基线：复位，调用方负责刷新目录。
      setState(createIdleState())
      return
    }
    setState({
      phase: 'confirming',
      noteId,
      noteTitle: nextTitle,
      noteContent: nextContent,
      expectedRevision,
      mutationId: null,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
  }

  function cancel(): void {
    if (disposed) return
    if (state.phase !== 'confirming') return
    setState(createIdleState())
  }

  function dismiss(): void {
    if (disposed) return
    if (state.phase !== 'error') return
    setState(createIdleState())
  }

  function updateCapabilities(next: NoteCapabilities | null): void {
    if (disposed) return
    capabilities = next
  }

  const actions: NoteDeleteActions = {
    requestDelete,
    cancel,
    confirmDelete,
    retry,
    reconfirm,
    dismiss,
  }

  return {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getActions: () => actions,
    updateCapabilities,
    dispose(): void {
      if (disposed) return
      disposed = true
      listeners.clear()
    },
  }
}
