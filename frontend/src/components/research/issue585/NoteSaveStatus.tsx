'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  NoteApiError,
  NoteSaveStatus as NoteSaveStatusValue,
} from '@/lib/research/issue585/types'
import {
  cacheStatusLabelKey,
  noteErrorFromState,
  saveStatusLabelKey,
} from './note-ui-labels'

export interface NoteSaveStatusProps {
  /** 方案 §4.1 的显式保存状态（绝不合并成模糊的 loading）。 */
  saveStatus: NoteSaveStatusValue
  /** 归一化 API 错误；只展示映射后的稳定文案，不展示原始正文。 */
  error?: NoteApiError | null
  /** 草稿缓存可用性：memory_only/unavailable 时明确提示本地恢复不可用。 */
  cacheStatus?: 'ok' | 'memory_only' | 'unavailable'
  /** 未决 mutation（未知结果时保留，确认前禁止新写入）。 */
  pendingMutationId?: string | null
  onRetry?: () => void
  onConfirmPending?: () => void
  onReviewConflict?: () => void
  className?: string
}

/**
 * 保存状态条（Issue #1046 PR4，方案 §4.1/§4.4）。
 *
 * 纯展示组件：状态文案来自 `saveStatus`，恢复能力下降来自 `cacheStatus`。
 * “结果待确认”（unknown）必须显式给出确认入口，不得显示成已保存；失败/冲突
 * 提供重试/查看冲突入口，但绝不提供“强制覆盖”。
 */
export function NoteSaveStatus({
  saveStatus,
  error = null,
  cacheStatus = 'ok',
  pendingMutationId = null,
  onRetry,
  onConfirmPending,
  onReviewConflict,
  className,
}: NoteSaveStatusProps) {
  const { t } = useTranslation()
  const errorKey = noteErrorFromState(error)
  const cacheKey = cacheStatusLabelKey(cacheStatus)

  return (
    <div className={`space-y-1 ${className ?? ''}`} data-testid="note-save-status" data-status={saveStatus}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
          data-testid="note-save-status-label"
        >
          {t(saveStatusLabelKey(saveStatus))}
        </span>
        {errorKey !== null && (
          <span className="text-xs text-destructive" data-testid="note-save-status-error">
            {t(errorKey)}
          </span>
        )}
        {saveStatus === 'failed' && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('research.notes.editor.retrySave')}
          </Button>
        )}
        {saveStatus === 'unknown' && onConfirmPending && (
          <Button size="sm" variant="outline" onClick={onConfirmPending}>
            {t('research.notes.editor.confirmPending')}
          </Button>
        )}
        {saveStatus === 'conflict' && onReviewConflict && (
          <Button size="sm" variant="outline" onClick={onReviewConflict}>
            {t('research.notes.conflict.reviewConflict')}
          </Button>
        )}
      </div>
      {pendingMutationId !== null && saveStatus === 'unknown' && (
        <p className="text-xs text-muted-foreground" data-testid="note-save-status-pending">
          {t('research.notes.editor.confirmPending')}
        </p>
      )}
      {cacheKey !== null && (
        <p
          role="status"
          className="text-xs text-amber-700 dark:text-amber-400"
          data-testid="note-cache-status"
          data-cache-status={cacheStatus}
        >
          {t(cacheKey)}
        </p>
      )}
    </div>
  )
}
