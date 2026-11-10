'use client'

/**
 * 启用受保护编辑对话框（Issue #1135，纯展示）。
 *
 * 只收集用户决定并渲染稳定状态：
 * - confirming：确认启用 / 取消；
 * - pending：单在途提示（按钮禁用、Esc/遮罩不可关闭）；
 * - error：按 failureKind 显示可读原因；`retryMode` 决定是否给重试，
 *   `same_mutation`（结果未知/依赖不可判定）使用「确认结果」文案；
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
  NoteEnableFailureKind,
  NoteEnablePhase,
  NoteEnableRetryMode,
} from '@/lib/research/issue585/note-enable'
import { noteEnableFailureLabelKey } from './note-ui-labels'

export interface NoteEnableDialogProps {
  open: boolean
  phase: NoteEnablePhase
  /** 目标 Note 标题（目录缺失时为空串，不臆造标题）。 */
  noteTitle: string
  failureKind: NoteEnableFailureKind | null
  retryMode: NoteEnableRetryMode
  onConfirm: () => void
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}

export function NoteEnableDialog({
  open,
  phase,
  noteTitle,
  failureKind,
  retryMode,
  onConfirm,
  onCancel,
  onRetry,
  onClose,
}: NoteEnableDialogProps) {
  const { t } = useTranslation()
  const pending = phase === 'pending'

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        // pending 为单在途：Esc/遮罩关闭等同 no-op（结果未知前不让用户丢状态）。
        if (pending) return
        // confirming：Esc/关闭请求等同「取消」；error：等同「关闭错误」。
        if (phase === 'confirming') {
          onCancel()
          return
        }
        onClose()
      }}
    >
      <AlertDialogContent
        data-testid="note-enable-dialog"
        data-phase={phase}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t('research.notes.enable.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('research.notes.enable.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <p className="truncate text-sm font-medium" data-testid="note-enable-note-title">
          {noteTitle}
        </p>

        {pending && (
          <p
            className="text-xs text-muted-foreground"
            role="status"
            data-testid="note-enable-status"
          >
            {t('research.notes.enable.pending')}
          </p>
        )}

        {phase === 'error' && (
          <p
            className="text-xs text-destructive"
            role="alert"
            data-testid="note-enable-error"
            data-failure-kind={failureKind ?? 'unknown'}
          >
            {t(noteEnableFailureLabelKey(failureKind))}
          </p>
        )}

        <AlertDialogFooter className="flex-wrap gap-2">
          {(phase === 'confirming' || pending) && (
            <>
              <Button
                size="sm"
                onClick={onConfirm}
                disabled={pending}
                data-testid="note-enable-confirm"
              >
                {t('research.notes.enable.confirm')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onCancel}
                disabled={pending}
                data-testid="note-enable-cancel"
              >
                {t('research.notes.cancel')}
              </Button>
            </>
          )}

          {phase === 'error' && (
            <>
              {retryMode !== 'none' && (
                <Button size="sm" onClick={onRetry} data-testid="note-enable-retry">
                  {retryMode === 'same_mutation'
                    ? t('research.notes.enable.confirmResult')
                    : t('research.notes.catalog.retry')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={onClose}
                data-testid="note-enable-close"
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
