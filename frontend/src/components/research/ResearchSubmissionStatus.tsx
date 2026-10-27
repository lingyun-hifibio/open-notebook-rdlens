'use client'

/**
 * 提交状态与恢复动作（DESIGN §6.7 / §10.2 F10/F15 / §9.2 组件契约）。
 *
 * 只呈现**可证明**的提交事实与显式动作：
 * - accepted（已提交，执行中/排队）；terminal completed/failed；
 * - outcome_unknown（结果未知/可能计费）必须显式人工重试，不自动重发；
 * - 查回失败：保留草稿与未知标记，提示可再次查回，不清稿/不换键；
 * - `submitted_draft_text` 仅在用户显式查看/复制时展示；当前稿为空才提供
 *   「恢复上一份已提交草稿」，非空稿绝不自动覆盖。
 */

import { useState } from 'react'

import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  ResearchContextReportProjection,
  ResearchSessionVisibility,
} from '@/lib/research/session-contract'
import { ResearchContextReport } from './ResearchContextReport'

export type ResearchSubmissionStatusView =
  | { readonly kind: 'not_observed' }
  | {
      readonly kind: 'accepted'
      readonly generationId: string | null
      readonly generationState: string | null
      readonly submittedDraftText: string | null
    }
  | {
      readonly kind: 'terminal'
      readonly outcome: 'completed' | 'failed'
      readonly failureCode?: string | null
      readonly generationId: string | null
      readonly submittedDraftText: string | null
    }
  | {
      readonly kind: 'outcome_unknown'
      readonly generationId: string | null
      readonly submittedDraftText: string | null
    }
  | {
      readonly kind: 'lookup_failed'
      readonly generationId: string | null
      readonly submittedDraftText: string | null
    }

/** 静态字面量映射（i18n 扫描器按字面量统计引用，禁止模板拼接）。 */
const GENERATION_STATE_KEYS = {
  accepted: 'research.submission.generationState.accepted',
  running: 'research.submission.generationState.running',
  job_queued: 'research.submission.generationState.job_queued',
  completed: 'research.submission.generationState.completed',
  failed: 'research.submission.generationState.failed',
  outcome_unknown: 'research.submission.generationState.outcome_unknown',
} as const

export interface ResearchSubmissionStatusProps {
  readonly submissionView: ResearchSubmissionStatusView | null
  /** 当前编辑器草稿（用于判断是否允许「恢复上一份已提交草稿」）。 */
  readonly currentDraft: string | null
  readonly contextReport?: ResearchContextReportProjection | null
  readonly visibility?: ResearchSessionVisibility
  readonly onLookup: () => void
  readonly onRestore: (text: string) => void
  readonly onCopy: (text: string) => void
  readonly onRetryManually?: () => void
}

function submittedTextOf(view: ResearchSubmissionStatusView): string | null {
  switch (view.kind) {
    case 'accepted':
    case 'terminal':
    case 'outcome_unknown':
    case 'lookup_failed':
      return view.submittedDraftText
    default:
      return null
  }
}

export function ResearchSubmissionStatus({
  submissionView,
  currentDraft,
  contextReport,
  visibility = 'visible',
  onLookup,
  onRestore,
  onCopy,
  onRetryManually,
}: ResearchSubmissionStatusProps) {
  const { t } = useTranslation()
  const [showSubmitted, setShowSubmitted] = useState(false)

  if (submissionView === null) return null

  const submittedText = submittedTextOf(submissionView)
  const draftEmpty = currentDraft === null || currentDraft.trim().length === 0
  const canRestore = submittedText !== null && draftEmpty

  const statusText = (() => {
    switch (submissionView.kind) {
      case 'not_observed':
        return t('research.submission.notObserved')
      case 'accepted':
        return t('research.submission.accepted')
      case 'terminal':
        return submissionView.outcome === 'completed'
          ? t('research.submission.terminalCompleted')
          : t('research.submission.terminalFailed')
      case 'outcome_unknown':
        return t('research.submission.outcomeUnknown')
      case 'lookup_failed':
        return t('research.submission.lookupFailed')
    }
  })()

  const handleCopy = (): void => {
    if (submittedText === null) return
    try {
      void navigator.clipboard?.writeText?.(submittedText)
    } catch {
      // 剪贴板不可用时仍把文本交给调用方（显式动作不静默失败）。
    }
    onCopy(submittedText)
  }

  return (
    <section
      data-testid="research-submission-status"
      data-kind={submissionView.kind}
      data-visibility={visibility}
      className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs"
    >
      <p className="font-medium">{statusText}</p>

      {submissionView.kind === 'accepted' && submissionView.generationState !== null ? (
        <p className="text-muted-foreground">
          {t(
            GENERATION_STATE_KEYS[
              submissionView.generationState as keyof typeof GENERATION_STATE_KEYS
            ] ?? 'research.submission.generationState.outcome_unknown',
          )}
        </p>
      ) : null}

      {submissionView.kind === 'terminal'
        && submissionView.outcome === 'failed'
        && typeof submissionView.failureCode === 'string'
        && submissionView.failureCode.length > 0 ? (
          <p className="text-muted-foreground">{submissionView.failureCode}</p>
        ) : null}

      {submissionView.kind === 'outcome_unknown' ? (
        <p className="text-muted-foreground">{t('research.submission.outcomeUnknownHint')}</p>
      ) : null}

      {submissionView.kind === 'lookup_failed' ? (
        <p className="text-muted-foreground">{t('research.submission.lookupFailedHint')}</p>
      ) : null}

      {submittedText !== null ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className="underline"
            onClick={() => setShowSubmitted((prev) => !prev)}
          >
            {t('research.submission.viewSubmitted')}
          </button>
          <button type="button" className="underline" onClick={handleCopy}>
            {t('research.submission.copySubmitted')}
          </button>
          {canRestore ? (
            <button type="button" className="underline" onClick={() => onRestore(submittedText)}>
              {t('research.submission.restoreSubmitted')}
            </button>
          ) : null}
        </div>
      ) : null}

      {showSubmitted && submittedText !== null ? (
        <pre
          data-testid="submitted-draft-text"
          className="mt-1 whitespace-pre-wrap break-words rounded bg-background/60 p-2"
        >
          {submittedText}
        </pre>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" className="underline" onClick={onLookup}>
          {t('research.submission.lookup')}
        </button>
        {submissionView.kind === 'outcome_unknown' && onRetryManually ? (
          <button type="button" className="underline" onClick={onRetryManually}>
            {t('research.submission.manualRetry')}
          </button>
        ) : null}
      </div>

      {contextReport !== null && contextReport !== undefined ? (
        <div className="pt-1">
          <ResearchContextReport report={contextReport} visibility={visibility} variant="failed-card" />
        </div>
      ) : null}
    </section>
  )
}
