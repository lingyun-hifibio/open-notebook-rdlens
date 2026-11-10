/**
 * Issue #1135：旧未保护 Note 的「启用受保护编辑」状态机。
 *
 * 权威依据：
 * - 宿主 issue #1135（#1046 PR4 §8.2〔R31〕的后续入口）；
 * - 机器契约 `note_d2_v1.enable_protection` / `capabilities` / `errors`；
 * - 宿主 PR3 `src/rdlens/research/issue585/errors.py` 的 retryable 语义
 *   （retryable=true = 客户端可用**同一 mutation_id / 同一幂等键**重试）；
 * - PR4 冻结的 `./note-client.ts`（`enableNoteEditingD2` 已存在）与
 *   `./types.ts`（`NoteApiError` / `NoteCapabilities`）。
 *
 * 设计要点：
 * - 纯逻辑、无 React；client 可注入（默认 `noteApiClient`），单测用 fake 即可；
 * - capability fail-closed：能力未知/关闭时入口不渲染（由 UI 层判断），状态机
 *   侧再做一次守卫，守卫失败**不发任何网络请求**；
 * - 首次启用成功 = 响应投影 `edit_schema === 'd2-v1'`（已受保护时
 *   `receipt=null` 也按成功结算，不增 revision、不改写正文/标题）；
 * - 结果未知（store/网络/未知码/畸形响应）必须保留同一 mutation_id 重放确认，
 *   绝不按成功结算；冲突类换新 mutation_id 重试；受限/不存在/不支持为终态；
 * - 单在途：pending 期间 confirm/retry/cancel/requestEnable 全部 no-op；
 * - 所有动作不抛异常：失败只体现在 state 上。
 */

import {
  newNoteMutationId,
  normalizeNoteApiError,
  noteApiClient,
  noteProtocolError,
  type NoteApiClient,
} from './note-client'
import type { NoteApiError, NoteCapabilities } from './types'

/** 受保护 Note 的冻结 edit_schema 值（与 PR4 编辑器一致）。 */
const NOTE_EDIT_SCHEMA_D2_V1 = 'd2-v1'

// ── 冻结类型 ──

/** 启用流程的用户可见阶段（idle = 无对话框）。 */
export type NoteEnablePhase = 'idle' | 'confirming' | 'pending' | 'error'

/** 失败分类（UI 只按它映射文案，不展示原始错误正文）。 */
export type NoteEnableFailureKind =
  | 'restricted'
  | 'not_found'
  | 'unsupported'
  | 'conflict'
  | 'unavailable'
  | 'unknown'

/**
 * 重试策略：
 * - `none`：终态，不提供重试；
 * - `new_mutation`：换新 mutation_id 重试（冲突类；同一 id 会再次 409
 *   `mutation_id_reused`）；
 * - `same_mutation`：复用同一 mutation_id 重放确认（结果未知/依赖不可判定；
 *   retryable=true 的语义是同一幂等键重试）。
 */
export type NoteEnableRetryMode = 'none' | 'new_mutation' | 'same_mutation'

/** 启用流程状态（全部字段可序列化；UI 只读消费）。 */
export interface NoteEnableState {
  phase: NoteEnablePhase
  /** 本次启用目标 note_id（idle 时为 null）。 */
  noteId: string | null
  /** 已发送/待确认的 mutation_id（用于同 mutation 重放）。 */
  mutationId: string | null
  error: NoteApiError | null
  failureKind: NoteEnableFailureKind | null
  retryMode: NoteEnableRetryMode
  /** UI 级守卫的稳定机器码（admin_readonly / capability_unknown / 能力 reason）。 */
  blockReason: string | null
}

/** 启用动作（所有网络动作不抛异常，结果体现在 state / 返回值上）。 */
export interface NoteEnableActions {
  /** 请求启用（打开确认对话框）；能力/权限守卫失败时不发请求。 */
  requestEnable: (noteId: string) => void
  /** 关闭确认对话框（仅 confirming → idle）。 */
  cancel: () => void
  /** 确认启用；成功返回 note_id，失败/未知返回 null。 */
  confirmEnable: () => Promise<string | null>
  /** 重试失败/未知的启用；成功返回 note_id，否则 null。 */
  retry: () => Promise<string | null>
  /** 关闭错误对话框（仅 error → idle，清 error/mutation）。 */
  dismiss: () => void
}

export interface NoteEnableMachineOptions {
  projectId: string
  isAdminReadonly: boolean
  capabilities: NoteCapabilities | null
  client?: NoteApiClient
  /** 可注入的 mutation_id 生成器（测试固定序列；生产用随机 uuid）。 */
  nextMutationId?: () => string
}

export interface NoteEnableMachine {
  getState(): NoteEnableState
  subscribe(listener: () => void): () => void
  getActions(): NoteEnableActions
  /** hook 在能力投影变化时同步（不重建状态机）。 */
  updateCapabilities(capabilities: NoteCapabilities | null): void
  /** 永久销毁：仅身份/项目真正替换时调用；销毁后一切动作 no-op。 */
  dispose(): void
}

// ── 状态构造 ──

function createIdleState(): NoteEnableState {
  return {
    phase: 'idle',
    noteId: null,
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

function guardFailureKind(blockReason: string): NoteEnableFailureKind {
  return blockReason === 'admin_readonly' ? 'restricted' : 'unavailable'
}

// ── 错误分类（宿主 errors.py 的 retryable 语义） ──

interface NoteEnableFailure {
  failureKind: NoteEnableFailureKind
  retryMode: NoteEnableRetryMode
}

/**
 * 归一化错误 → (failureKind, retryMode)。
 *
 * 终态（none）：不存在/受限/格式不支持/请求非法——重试无意义。
 * 冲突类（new_mutation）：契约里 409 非 retryable，但 issue 要求冲突有明确
 *   状态与重试；同一 mutation_id 会再次 409 `mutation_id_reused`，故换新 id。
 * 结果未知（same_mutation）：服务端可能已应用，必须用同一 mutation_id 重放
 *   确认，绝不按成功结算。
 */
export function classifyNoteEnableError(error: NoteApiError): NoteEnableFailure {
  switch (error.code) {
    case 'note_access_restricted':
      return { failureKind: 'restricted', retryMode: 'none' }
    case 'note_not_found':
      return { failureKind: 'not_found', retryMode: 'none' }
    case 'note_edit_schema_unsupported':
    case 'note_request_invalid':
      return { failureKind: 'unsupported', retryMode: 'none' }
    case 'mutation_id_reused':
    case 'note_revision_conflict':
    case 'note_revision_required':
    case 'note_revision_exhausted':
    case 'note_snapshot_fence_exhausted':
      return { failureKind: 'conflict', retryMode: 'new_mutation' }
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

/** 能力位守卫：null/关闭/缺失 → 稳定原因码（fail-closed）。 */
export function noteEnableBlockReason(capabilities: NoteCapabilities | null): string | null {
  if (capabilities === null) return 'capability_unknown'
  const capability = capabilities.noteEditor
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

// ── 状态机 ──

export function createNoteEnableMachine(options: NoteEnableMachineOptions): NoteEnableMachine {
  const client: NoteApiClient = options.client ?? noteApiClient
  const nextMutationId = options.nextMutationId ?? newNoteMutationId

  const projectId = options.projectId
  const isAdminReadonly = options.isAdminReadonly
  let capabilities = options.capabilities

  const listeners = new Set<() => void>()
  let disposed = false
  let state: NoteEnableState = createIdleState()

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function setState(next: NoteEnableState): void {
    state = next
    emit()
  }

  /** 守卫失败：不发请求；phase=error + blockReason + 合成错误。 */
  function failGuard(noteId: string, blockReason: string): void {
    setState({
      phase: 'error',
      noteId,
      mutationId: null,
      error: guardError(blockReason),
      failureKind: guardFailureKind(blockReason),
      retryMode: 'none',
      blockReason,
    })
  }

  function failWithUnknown(noteId: string, mutationId: string): null {
    setState({
      phase: 'error',
      noteId,
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
    mutationId: string,
    error: NoteApiError,
  ): null {
    const failure = classifyNoteEnableError(error)
    setState({
      phase: 'error',
      noteId,
      mutationId,
      error,
      failureKind: failure.failureKind,
      retryMode: failure.retryMode,
      blockReason: null,
    })
    return null
  }

  /**
   * 发送一次启用请求（pending → 成功 idle / 失败 error）。
   *
   * 成功判定：响应投影 `edit_schema === 'd2-v1'`。已受保护时服务端返回当前
   * 投影且 `receipt=null`、不增 revision——同样按成功结算。响应缺 note /
   * 非 d2-v1 / 畸形 → 结果未知（保留同一 mutation_id 待确认）。
   */
  async function runEnable(noteId: string, mutationId: string): Promise<string | null> {
    setState({
      phase: 'pending',
      noteId,
      mutationId,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
    try {
      const result = await client.enableNoteEditing(projectId, noteId, {
        mutation_id: mutationId,
      })
      if (disposed) return null
      const note = isRecord(result) && isRecord(result.note) ? result.note : null
      if (note === null || note.edit_schema !== NOTE_EDIT_SCHEMA_D2_V1) {
        return failWithUnknown(noteId, mutationId)
      }
      setState(createIdleState())
      return noteId
    } catch (error) {
      if (disposed) return null
      return failWithError(noteId, mutationId, normalizeNoteApiError(error))
    }
  }

  function requestEnable(noteId: string): void {
    if (disposed) return
    if (noteId.length === 0) return
    // 单在途：pending 期间不允许切换目标/重入。
    if (state.phase === 'pending') return
    if (isAdminReadonly) {
      failGuard(noteId, 'admin_readonly')
      return
    }
    const block = noteEnableBlockReason(capabilities)
    if (block !== null) {
      failGuard(noteId, block)
      return
    }
    setState({
      phase: 'confirming',
      noteId,
      mutationId: null,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
  }

  async function confirmEnable(): Promise<string | null> {
    if (disposed) return null
    if (state.phase !== 'confirming') return null
    const noteId = state.noteId
    if (noteId === null) return null
    // 每次新尝试都生成新 mutation_id（绝不复用旧 id）。
    return runEnable(noteId, nextMutationId())
  }

  async function retry(): Promise<string | null> {
    if (disposed) return null
    if (state.phase !== 'error') return null
    if (state.retryMode === 'none') return null
    const noteId = state.noteId
    if (noteId === null) return null
    const mutationId =
      state.retryMode === 'same_mutation' && state.mutationId !== null
        ? state.mutationId
        : nextMutationId()
    return runEnable(noteId, mutationId)
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

  const actions: NoteEnableActions = {
    requestEnable,
    cancel,
    confirmEnable,
    retry,
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
