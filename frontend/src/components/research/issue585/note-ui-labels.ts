/**
 * Issue #1046 PR4（D2-B2）：Note 编辑器 UI 的稳定机器码 → i18n key 映射。
 *
 * 只做「码 → key」的纯映射（不依赖 React），让每个展示组件都能 fail-closed：
 * 未知码一律落到通用文案，绝不把原始错误正文/堆栈显示给用户，也不臆造
 * “已保存”之类状态。所有 key 必须存在于 en-US（参考语言）。
 *
 * 注意：这里刻意使用**字面量映射表**而不是模板字符串拼接——仓库的
 * `locales/index.test.ts`（Unused Key Detection）要求每个 en-US leaf key
 * 在源码中有字面出现，动态拼接会被判为未使用。
 */

import type {
  NoteApiError,
  NoteErrorCode,
  NoteLeaveBlockReason,
  NoteSaveStatus,
} from '@/lib/research/issue585/types'
import type { NoteEnableFailureKind } from '@/lib/research/issue585/note-enable'

/** 保存状态 → 文案 key（方案 §4.1 的九类显式状态）。 */
const SAVE_STATUS_LABEL_KEYS: Record<NoteSaveStatus, string> = {
  idle: 'research.notes.editor.saveStatus.idle',
  saved: 'research.notes.editor.saveStatus.saved',
  pending: 'research.notes.editor.saveStatus.pending',
  saving: 'research.notes.editor.saveStatus.saving',
  failed: 'research.notes.editor.saveStatus.failed',
  unknown: 'research.notes.editor.saveStatus.unknown',
  conflict: 'research.notes.editor.saveStatus.conflict',
  restricted: 'research.notes.editor.saveStatus.restricted',
  blocked: 'research.notes.editor.saveStatus.blocked',
}

/** 契约 §8 稳定错误码（含传输层兜底码）→ 用户可读文案 key。 */
const NOTE_ERROR_LABEL_KEYS: Record<NoteErrorCode, string> = {
  note_not_found: 'research.notes.editor.errors.note_not_found',
  note_access_restricted: 'research.notes.editor.errors.note_access_restricted',
  note_edit_schema_unsupported: 'research.notes.editor.errors.note_edit_schema_unsupported',
  note_revision_required: 'research.notes.editor.errors.note_revision_required',
  note_revision_conflict: 'research.notes.editor.errors.note_revision_conflict',
  note_revision_exhausted: 'research.notes.editor.errors.note_revision_exhausted',
  note_snapshot_fence_exhausted: 'research.notes.editor.errors.note_snapshot_fence_exhausted',
  mutation_id_reused: 'research.notes.editor.errors.mutation_id_reused',
  note_request_invalid: 'research.notes.editor.errors.note_request_invalid',
  note_snapshot_unavailable: 'research.notes.editor.errors.note_snapshot_unavailable',
  note_dependency_unavailable: 'research.notes.editor.errors.note_dependency_unavailable',
  note_store_unavailable: 'research.notes.editor.errors.note_store_unavailable',
  fragment_source_not_found: 'research.notes.editor.errors.fragment_source_not_found',
  network_error: 'research.notes.editor.errors.network_error',
  unknown_error: 'research.notes.editor.errors.unknown_error',
}

/** §8.2 能力位原因码（后端投影 + 前端 fail-closed 兜底）→ 文案 key。 */
const CAPABILITY_REASON_LABEL_KEYS: Record<string, string> = {
  disabled_by_flag: 'research.notes.capability.reasons.disabled_by_flag',
  note_store_unavailable: 'research.notes.capability.reasons.note_store_unavailable',
  not_ready: 'research.notes.capability.reasons.not_ready',
  capability_unknown: 'research.notes.capability.reasons.capability_unknown',
  note_access_restricted: 'research.notes.capability.reasons.note_access_restricted',
  note_not_found: 'research.notes.capability.reasons.note_not_found',
  note_edit_schema_unsupported: 'research.notes.capability.reasons.note_edit_schema_unsupported',
  note_dependency_unavailable: 'research.notes.capability.reasons.note_dependency_unavailable',
}

/** 离开阻断原因（方案 §4.4 的稳定机器码）→ 文案 key。 */
const LEAVE_REASON_LABEL_KEYS: Record<NoteLeaveBlockReason, string> = {
  unsaved: 'research.notes.leave.unsaved',
  saving: 'research.notes.leave.saving',
  unknown: 'research.notes.leave.unknown',
  conflict: 'research.notes.leave.conflict',
  failed: 'research.notes.leave.failed',
  restricted: 'research.notes.leave.restricted',
  composing: 'research.notes.leave.composing',
}

/** Issue #1135：启用受保护编辑的失败分类 → 文案 key（字面量映射）。 */
const NOTE_ENABLE_FAILURE_LABEL_KEYS: Record<NoteEnableFailureKind, string> = {
  restricted: 'research.notes.enable.errors.restricted',
  not_found: 'research.notes.enable.errors.notFound',
  unsupported: 'research.notes.enable.errors.unsupported',
  conflict: 'research.notes.enable.errors.conflict',
  unavailable: 'research.notes.enable.errors.unavailable',
  unknown: 'research.notes.enable.errors.unknown',
}

/** 启用失败分类 → 文案 key；未知分类落到通用「结果未知」文案。 */
export function noteEnableFailureLabelKey(
  kind: NoteEnableFailureKind | null | undefined,
): string {
  if (typeof kind === 'string' && kind in NOTE_ENABLE_FAILURE_LABEL_KEYS) {
    return NOTE_ENABLE_FAILURE_LABEL_KEYS[kind as NoteEnableFailureKind]
  }
  return 'research.notes.enable.errors.unknown'
}

export function isNoteErrorCode(value: unknown): value is NoteErrorCode {
  return typeof value === 'string' && value in NOTE_ERROR_LABEL_KEYS
}

export function saveStatusLabelKey(status: NoteSaveStatus): string {
  return SAVE_STATUS_LABEL_KEYS[status] ?? 'research.notes.editor.saveStatus.idle'
}

/** 归一化 API 错误 → 用户可读文案 key（未知码 → 通用文案）。 */
export function noteErrorLabelKey(code: NoteErrorCode | string | null | undefined): string {
  if (typeof code === 'string' && code in NOTE_ERROR_LABEL_KEYS) {
    return NOTE_ERROR_LABEL_KEYS[code as NoteErrorCode]
  }
  return 'research.notes.editor.errors.unknown_error'
}

/**
 * 阻断原因 → 文案 key。同一字符串可能是 API 错误码、能力原因码或
 * 编辑器 blockReason；按「错误码 → 能力原因 → 通用」的顺序解析。
 */
export function blockReasonLabelKey(reason: string | null | undefined): string {
  if (typeof reason === 'string') {
    if (reason in NOTE_ERROR_LABEL_KEYS) {
      return NOTE_ERROR_LABEL_KEYS[reason as NoteErrorCode]
    }
    if (reason in CAPABILITY_REASON_LABEL_KEYS) {
      return CAPABILITY_REASON_LABEL_KEYS[reason]
    }
  }
  return 'research.notes.capability.unknown'
}

/** 离开阻断原因 → 文案 key（未知原因按未保存处理，偏保守）。 */
export function leaveReasonLabelKey(reason: NoteLeaveBlockReason | null | undefined): string {
  if (reason && reason in LEAVE_REASON_LABEL_KEYS) {
    return LEAVE_REASON_LABEL_KEYS[reason]
  }
  return 'research.notes.leave.unsaved'
}

/** 草稿缓存降级提示 key；`ok` 不提示。 */
export function cacheStatusLabelKey(
  cacheStatus: 'ok' | 'memory_only' | 'unavailable' | null | undefined,
): string | null {
  if (cacheStatus === 'memory_only') return 'research.notes.editor.cache.memoryOnly'
  if (cacheStatus === 'unavailable') return 'research.notes.editor.cache.unavailable'
  return null
}

/**
 * 错误对象 → 展示文案 key。冲突/未知结果不是“错误文案”，由状态区与
 * 对话框承担，这里仍给出稳定兜底，避免空白提示。
 */
export function noteErrorFromState(error: NoteApiError | null | undefined): string | null {
  if (!error) return null
  return noteErrorLabelKey(error.code)
}

/** 只取安全的本地时间展示；非法值返回 null（不显示虚假时间）。 */
export function formatCachedAt(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString()
}
