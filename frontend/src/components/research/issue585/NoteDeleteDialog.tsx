'use client'

/**
 * d2-v1 Note 删除二次确认对话框（Issue #1134，纯展示）。
 *
 * 只收集用户决定并渲染稳定状态：
 * - confirming：显式二次确认（说明硬删除不可恢复、已插入文档的副本不受影响、
 *   权限会再次校验；被删的是当前打开且有未保存修改时额外提示本地修改会丢弃）；
 * - pending：单在途提示（按钮禁用、Esc/遮罩不可关闭）；
 * - error：按 failureKind 显示可读原因；`retryMode` 决定给哪种重试：
 *   `same_mutation`（结果未知/依赖不可判定）→「Confirm result」，
 *   `new_mutation` →「Retry」, `reconfirm`（409 冲突）→「Refresh and review」；
 * - 所有状态都不展示原始错误正文/堆栈（失败文案由 failureKind 映射）。
 */

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  NoteDeleteFailureKind,
  NoteDeletePhase,
  NoteDeleteRetryMode,
} from '@/lib/research/issue585/note-delete'
import { noteDeleteFailureLabelKey } from './note-ui-labels'

export interface NoteDeleteDialogProps {
  open: boolean
  phase: NoteDeletePhase
  /** 目标 Note 标题（目录缺失时为空串，不臆造标题）。 */
  noteTitle: string
  /**
   * 目标 Note 正文投影（复核用；409 冲突刷新后为服务端最新读取结果）。
   * 空串时不渲染正文块（绝不伪造内容）。
   */
  noteContent?: string
  /** 本次删除冻结的 revision（confirming 时展示，便于复核刷新后的版本）。 */
  expectedRevision: number | null
  failureKind: NoteDeleteFailureKind | null
  retryMode: NoteDeleteRetryMode
  /** 被删目标正是当前打开且有未保存修改的编辑器文档时提示本地修改会丢弃。 */
  localChangesWarning?: boolean
  onConfirm: () => void
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}

export function NoteDeleteDialog({
  open,
  phase,
  noteTitle,
  noteContent = '',
  expectedRevision,
  failureKind,
  retryMode,
  localChangesWarning = false,
  onConfirm,
  onCancel,
  onRetry,
  onClose,
}: NoteDeleteDialogProps) {
  const { t } = useTranslation()
  const pending = phase === 'pending'
  const confirming = phase === 'confirming'

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        // pending 为单在途：Esc/遮罩关闭等同 no-op（结果未知前不让用户丢状态）。
        if (pending) return
        // confirming：Esc/关闭请求等同「取消」；error：等同「关闭错误」。
        if (confirming) {
          onCancel()
          return
        }
        onClose()
      }}
    >
      <AlertDialogContent
        data-testid="note-delete-dialog"
        data-phase={phase}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('research.notes.deleteDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('research.notes.deleteDialog.description', { title: noteTitle })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {confirming && expectedRevision !== null && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="note-delete-revision"
          >
            {t('research.notes.deleteDialog.revision', { revision: expectedRevision })}
          </p>
        )}

        {confirming && noteContent.length > 0 && (
          <div data-testid="note-delete-content">
            <p className="text-xs font-medium text-muted-foreground">
              {t('research.notes.deleteDialog.contentLabel')}
            </p>
            <div className="max-h-24 overflow-auto whitespace-pre-wrap rounded border p-2 text-xs">
              {noteContent}
            </div>
          </div>
        )}

        <p
          className="text-xs text-muted-foreground"
          data-testid="note-delete-impact"
        >
          {t('research.notes.deleteDialog.impact')}
        </p>

        {confirming && localChangesWarning && (
          <p
            className="text-xs text-destructive"
            data-testid="note-delete-unsaved"
          >
            {t('research.notes.deleteDialog.unsavedLocal')}
          </p>
        )}

        {pending && (
          <p
            className="text-xs text-muted-foreground"
            role="status"
            data-testid="note-delete-status"
          >
            {t('research.notes.deleteDialog.pending')}
          </p>
        )}

        {phase === 'error' && (
          <p
            className="text-xs text-destructive"
            role="alert"
            data-testid="note-delete-error"
            data-failure-kind={failureKind ?? 'unknown'}
          >
            {t(noteDeleteFailureLabelKey(failureKind))}
          </p>
        )}

        <AlertDialogFooter className="flex-wrap gap-2">
          {(confirming || pending) && (
            <>
              <Button
                size="sm"
                variant="destructive"
                onClick={onConfirm}
                disabled={pending}
                data-testid="note-delete-confirm"
              >
                {t('research.notes.deleteDialog.confirm')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onCancel}
                disabled={pending}
                data-testid="note-delete-cancel"
              >
                {t('research.notes.cancel')}
              </Button>
            </>
          )}

          {phase === 'error' && (
            <>
              {retryMode !== 'none' && (
                <Button size="sm" onClick={onRetry} data-testid="note-delete-retry">
                  {retryMode === 'same_mutation'
                    ? t('research.notes.deleteDialog.confirmResult')
                    : retryMode === 'reconfirm'
                      ? t('research.notes.deleteDialog.refreshAndReview')
                      : t('research.notes.catalog.retry')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={onClose}
                data-testid="note-delete-close"
              >
                {t('common.close')}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
