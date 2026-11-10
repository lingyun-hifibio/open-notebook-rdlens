/**
 * Issue #1048 PR7（D2-B4）：写作 UI 的稳定机器码 → i18n key 映射。
 *
 * 只做「码 → key」的纯映射（不依赖 React）；未知码一律落到通用文案，绝不把
 * 原始错误正文/堆栈/服务端 message 显示给用户，也不臆造“已完整保留”之类
 * 结论。所有 key 必须以**字面量**出现在源码中（仓内 Unused Key Detection）。
 */

import type {
  WritingComposeErrorCode,
  WritingComposeErrorStage,
} from './use-writing-compose'
import type {
  WritingErrorCode,
  WritingHistoryExcludedReason,
  WritingHistoryMode,
} from './writing-types'

/** 编排错误 → 文案 key（阶段前缀只影响标题，不拼动态 key）。 */
const COMPOSE_ERROR_LABEL_KEYS: Record<WritingComposeErrorCode, string> = {
  note_required: 'research.notes.writing.composeErrors.noteRequired',
  selection_invalid: 'research.notes.writing.composeErrors.selectionInvalid',
  owner_unknown: 'research.notes.writing.composeErrors.ownerUnknown',
  model_missing: 'research.notes.writing.composeErrors.modelMissing',
  query_required: 'research.notes.writing.composeErrors.queryRequired',
  query_too_large: 'research.notes.writing.composeErrors.queryTooLarge',
  session_required: 'research.notes.writing.composeErrors.sessionRequired',
  session_create_failed: 'research.notes.writing.composeErrors.sessionCreateFailed',
  session_unauthorized: 'research.notes.writing.composeErrors.sessionUnauthorized',
  composer_not_ready: 'research.notes.writing.composeErrors.composerNotReady',
  composer_conflict: 'research.notes.writing.composeErrors.composerConflict',
  composer_blocked: 'research.notes.writing.composeErrors.composerBlocked',
  composer_failed: 'research.notes.writing.composeErrors.composerFailed',
  invalid_request: 'research.notes.writing.composeErrors.invalidRequest',
  unknown: 'research.notes.writing.composeErrors.unknown',
}

export function composeErrorLabelKey(code: WritingComposeErrorCode | null | undefined): string {
  if (typeof code === 'string' && code in COMPOSE_ERROR_LABEL_KEYS) {
    return COMPOSE_ERROR_LABEL_KEYS[code as WritingComposeErrorCode]
  }
  return 'research.notes.writing.composeErrors.unknown'
}

/** 阶段 → 标题类文案（当前阶段提示，不改变判定）。 */
export function composeStageLabelKey(
  stage: WritingComposeErrorStage | null | undefined,
): string {
  if (stage === 'session') return 'research.notes.writing.stage.session'
  if (stage === 'composer') return 'research.notes.writing.stage.composer'
  if (stage === 'submit') return 'research.notes.writing.stage.submit'
  if (stage === 'validation') return 'research.notes.writing.stage.validation'
  return 'research.notes.writing.stage.submit'
}

/** 契约 §8 写作相关稳定码 → 文案 key。 */
const API_ERROR_LABEL_KEYS: Record<WritingErrorCode, string> = {
  writing_not_available: 'research.notes.writing.errors.writingNotAvailable',
  writing_context_changed: 'research.notes.writing.errors.contextChanged',
  writing_input_unavailable: 'research.notes.writing.errors.inputUnavailable',
  context_limit_exceeded: 'research.notes.writing.errors.contextLimitExceeded',
  submission_intent_conflict: 'research.notes.writing.errors.intentConflict',
  session_not_found: 'research.notes.writing.errors.sessionNotFound',
  chat_owner_required: 'research.notes.writing.errors.ownerRequired',
  invalid_response: 'research.notes.writing.errors.invalidResponse',
  network_error: 'research.notes.writing.errors.networkError',
  unknown_error: 'research.notes.writing.errors.unknown',
}

export function writingApiErrorLabelKey(
  code: WritingErrorCode | string | null | undefined,
): string {
  if (typeof code === 'string' && code in API_ERROR_LABEL_KEYS) {
    return API_ERROR_LABEL_KEYS[code as WritingErrorCode]
  }
  return 'research.notes.writing.errors.unknown'
}

/** 历史未采用原因 → 文案 key（契约 §6.5 三个稳定码）。 */
const HISTORY_EXCLUDED_LABEL_KEYS: Record<WritingHistoryExcludedReason, string> = {
  history_scope_excluded: 'research.notes.writing.context.history.excludedScope',
  history_budget_excluded: 'research.notes.writing.context.history.excludedBudget',
  history_authority_excluded: 'research.notes.writing.context.history.excludedAuthority',
}

export function historyExcludedLabelKey(
  reason: WritingHistoryExcludedReason | string | null | undefined,
): string {
  if (typeof reason === 'string' && reason in HISTORY_EXCLUDED_LABEL_KEYS) {
    return HISTORY_EXCLUDED_LABEL_KEYS[reason as WritingHistoryExcludedReason]
  }
  return 'research.notes.writing.context.history.excludedScope'
}

/** history_mode → 文案 key。 */
export function historyModeLabelKey(mode: WritingHistoryMode): string {
  return mode === 'current'
    ? 'research.notes.writing.context.history.current'
    : 'research.notes.writing.context.history.none'
}
