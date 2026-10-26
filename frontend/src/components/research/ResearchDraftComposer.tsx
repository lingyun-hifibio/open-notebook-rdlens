'use client'

/**
 * 草稿 composer（#602 第三批 PR-4，DESIGN §5.4 / §5.8 / §6.1 / §8.2 / §9.2）。
 *
 * 职责：
 * - 多行 textarea：自动增高到上限后内部滚动；保留换行/首尾空白/非 ASCII；
 *   绝不本地 `trim()` 覆盖 editor 草稿；
 * - 键盘：Enter 发送（非 IME 组合、无 Shift），Shift+Enter 换行，IME 期间不发送；
 * - 可见保存状态（未保存/保存中/已保存/冲突/受阻/只读）与重试保存入口；
 * - 发送门禁：按钮 `disabled` 不是唯一信号，非空原因必须显示在输入区。
 *
 * 本 PR 不接发送/SSE/submit hold（PR-5a）；`onSend` 只做既有分派的转发，
 * 发送后不清稿（清稿由 PR-5a 的原子提交协议承接）。adopt-server-version /
 * save-local-over-server / submission 恢复回调仅暴露，不渲染（PR-5b）。
 */

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  EditorSnapshot,
  ResearchConversationSnapshot,
  ResearchDraftGate,
  ResearchDraftGateReason,
  ResearchDraftSaveState,
} from '@/lib/research/types'

export interface ResearchDraftComposerProps {
  readonly editorSnapshot: EditorSnapshot | null
  readonly conversationSnapshot: ResearchConversationSnapshot
  readonly gate: ResearchDraftGate
  /** 门禁原因文案（父层已 `t()` 映射）；空表示无需展示。 */
  readonly gateReasonText: string | null
  readonly onDraftChange: (text: string) => void
  readonly onSend: () => void
  readonly onRetrySave: () => void
  /** 本机草稿恢复入口（DESIGN §3.5）；PR-5b 完整呈现。 */
  readonly onRestoreDraft?: (writerId: string) => void
  /** 仅暴露给后续 PR（本 PR 不渲染按钮）：采纳服务端版本。 */
  readonly onAdoptServerVersion?: () => void
  /** 仅暴露给后续 PR（本 PR 不渲染按钮）：用本机版本覆盖服务端。 */
  readonly onSaveLocalOverServer?: () => void
  /** 仅暴露给后续 PR（本 PR 不渲染按钮）：提交结果查回/结算。 */
  readonly onReconcileSubmission?: () => void
}

/** 门禁原因 → 既有 i18n 键（不使用 `defaultValue` 兜底）。 */
const GATE_REASON_KEYS: Record<ResearchDraftGateReason, string> = {
  runtime_unavailable: 'research.errors.internal',
  editor_not_ready: 'research.loading',
  editor_unreadable: 'research.errors.internal',
  submission_not_ready: 'research.loading',
  save_failed: 'research.resultActions.saveFailed',
  saving: 'research.resultActions.saving',
  conflict: 'research.errors.revisionChanged',
  blocked: 'research.editor.blocked',
  readonly: 'research.workbench.adminWriteDenied',
  invalidated: 'research.errors.internal',
  oversize: 'research.editor.blocked',
  empty_draft: 'research.chatPlaceholder',
  scope_invalid: 'research.layout.scope.selectItemRequired',
  turn_active: 'research.errors.generationInProgress',
}

export function researchDraftGateReasonKey(reason: ResearchDraftGateReason): string {
  return GATE_REASON_KEYS[reason]
}

/** 保存状态投影（DESIGN §5.8 用户可见状态；纯函数便于复用与测试）。 */
export function researchDraftSaveState(snapshot: EditorSnapshot | null): ResearchDraftSaveState {
  if (snapshot === null) return 'unavailable'
  if (snapshot.readOnly || snapshot.phase === 'readonly') return 'readonly'
  if (snapshot.blocked || snapshot.phase === 'blocked') return 'blocked'
  if (snapshot.conflict !== null || snapshot.phase === 'conflict') return 'conflict'
  if (snapshot.saving || snapshot.phase === 'saving' || snapshot.phase === 'loading') {
    return 'saving'
  }
  if (snapshot.dirty) return 'dirty'
  return 'clean'
}

/**
 * 发送门禁（DESIGN §6.1）。
 *
 * 允许“正常编辑产生的 pending dirty”，但保存失败/冲突/blocked/readonly/
 * 未就绪/空草稿/范围无效/本会话仍有活动轮时禁止派发；原因必须可见。
 */
export function deriveResearchDraftGate(input: {
  readonly editorSnapshot: EditorSnapshot | null
  readonly conversationSnapshot: ResearchConversationSnapshot
}): ResearchDraftGate {
  const { editorSnapshot, conversationSnapshot } = input
  if (editorSnapshot === null) return { allowed: false, reason: 'runtime_unavailable' }
  if (editorSnapshot.invalidated) return { allowed: false, reason: 'invalidated' }
  if (editorSnapshot.readOnly || editorSnapshot.phase === 'readonly') {
    return { allowed: false, reason: 'readonly' }
  }
  if (editorSnapshot.blocked || editorSnapshot.phase === 'blocked') {
    return { allowed: false, reason: 'blocked' }
  }
  if (editorSnapshot.conflict !== null || editorSnapshot.phase === 'conflict') {
    return { allowed: false, reason: 'conflict' }
  }
  if (editorSnapshot.saveFailure !== null) return { allowed: false, reason: 'save_failed' }
  if (editorSnapshot.saving || editorSnapshot.phase === 'saving') {
    return { allowed: false, reason: 'saving' }
  }
  if (editorSnapshot.oversize) return { allowed: false, reason: 'oversize' }
  if (editorSnapshot.unreadable) return { allowed: false, reason: 'editor_unreadable' }
  if (
    editorSnapshot.loading ||
    editorSnapshot.phase === 'idle' ||
    editorSnapshot.phase === 'loading'
  ) {
    return { allowed: false, reason: 'editor_not_ready' }
  }
  if (!editorSnapshot.transportAvailable) {
    return { allowed: false, reason: 'runtime_unavailable' }
  }
  if (editorSnapshot.draftText.trim().length === 0) {
    return { allowed: false, reason: 'empty_draft' }
  }
  // legacy（base_scope=null）必须先重选范围，不得默认 all（DESIGN §7.2）。
  if (editorSnapshot.baseScope === null && editorSnapshot.singleSourceId === null) {
    return { allowed: false, reason: 'scope_invalid' }
  }
  if (
    editorSnapshot.baseScope?.mode === 'selected' &&
    editorSnapshot.baseScope.sourceIds.length === 0 &&
    editorSnapshot.noteIds.length === 0 &&
    editorSnapshot.singleSourceId === null
  ) {
    return { allowed: false, reason: 'scope_invalid' }
  }
  if (
    conversationSnapshot.isBusy ||
    conversationSnapshot.isStreaming ||
    conversationSnapshot.activeTurnId !== null
  ) {
    return { allowed: false, reason: 'turn_active' }
  }
  return { allowed: true, reason: null }
}

/** textarea 自动增高上限（px）：超过后内部滚动（DESIGN §5.4）。 */
const TEXTAREA_MAX_HEIGHT_PX = 160

export function ResearchDraftComposer({
  editorSnapshot,
  conversationSnapshot,
  gate,
  gateReasonText,
  onDraftChange,
  onSend,
  onRetrySave,
  onRestoreDraft,
}: ResearchDraftComposerProps) {
  const { t } = useTranslation()
  const [localDraft, setLocalDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)

  const value = editorSnapshot === null ? localDraft : editorSnapshot.draftText
  const saveState = researchDraftSaveState(editorSnapshot)
  const connectionBusy = conversationSnapshot.isStreaming || conversationSnapshot.isBusy

  // 自动增高：先重置为 auto 再按 scrollHeight 截断；不改变文本内容。
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.style.height = 'auto'
    const next = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)
    textarea.style.height = `${next}px`
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [value])

  const saveStateText = (() => {
    switch (saveState) {
      case 'dirty':
        return t('research.editor.unsavedDraft')
      case 'saving':
        return t('research.resultActions.saving')
      case 'conflict':
        return t('research.errors.revisionChanged')
      case 'blocked':
        return t('research.editor.blocked')
      case 'readonly':
        return t('research.workbench.adminWriteDenied')
      case 'unavailable':
        return t('research.loading')
      case 'clean':
      default:
        return t('research.editor.saved')
    }
  })()

  const handleChange = (next: string): void => {
    if (editorSnapshot === null) setLocalDraft(next)
    onDraftChange(next)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      return
    }
    event.preventDefault()
    if (gate.allowed) onSend()
  }

  const showRetry =
    editorSnapshot !== null &&
    (editorSnapshot.saveFailure !== null || editorSnapshot.phase === 'blocked')
  const restoreCandidate = editorSnapshot?.restoreCandidates?.[0] ?? null
  const showRestore = restoreCandidate !== null && onRestoreDraft !== undefined

  return (
    <div className="shrink-0 space-y-1.5 border-t px-4 py-2" data-testid="research-draft-composer">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p
          className="min-w-0 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="research-draft-save-state"
        >
          {saveStateText}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {showRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={onRetrySave}
              data-testid="research-draft-save-retry"
            >
              {t('research.retry')}
            </Button>
          )}
          {showRestore && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={() => onRestoreDraft(restoreCandidate.writerId)}
              data-testid="research-draft-restore"
            >
              {t('research.editor.restoreDraft')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-w-0 items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          className="min-h-[36px] w-full min-w-0 resize-none rounded-md border bg-background px-3 py-2 text-sm"
          placeholder={t('research.chatPlaceholder')}
          aria-label={t('research.chatSend')}
          aria-describedby={gateReasonText !== null ? 'research-draft-gate-hint' : undefined}
          onChange={event => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          data-testid="chat-input"
        />
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={!gate.allowed}
          onClick={() => {
            if (gate.allowed) onSend()
          }}
          aria-label={t('research.chatSend')}
          data-testid="chat-send"
        >
          {connectionBusy ? t('research.chatStreaming') : t('research.chatSend')}
        </Button>
      </div>

      {gateReasonText !== null && (
        <p
          id="research-draft-gate-hint"
          className="text-xs text-amber-700"
          role="alert"
          data-testid="research-draft-gate-hint"
        >
          {gateReasonText}
        </p>
      )}
    </div>
  )
}
