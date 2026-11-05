'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { NoteLeaveBlockReason } from '@/lib/research/issue585/types'
import { leaveReasonLabelKey } from './note-ui-labels'

export interface NoteLeaveGuardDialogProps {
  open: boolean
  /** 离开被阻断的原因（方案 §4.4 的稳定机器码）。 */
  reason: NoteLeaveBlockReason | null
  /** 应用内切文档/项目/页面被阻断时的上下文说明（可选）。 */
  busy?: boolean
  /** 复制结果：failed 时提示手动复制，不假装成功。 */
  copyState?: 'idle' | 'copying' | 'copied' | 'failed'
  onRetrySave: () => void
  onCopyLocal: () => void
  onDownloadLocalMarkdown: () => void
  /** 用户确认放弃本地编辑后离开（父层负责 discardLocal + 关闭）。 */
  onDiscardAndLeave: () => void
  /** 留在当前文档（关闭对话框，不导航）。 */
  onStay: () => void
}

/**
 * 离开保护对话框（Issue #1046 PR4，方案 §4.4）。
 *
 * 未完成保存、保存中、结果未知、冲突、失败、权限受限或 IME 未结束时阻止
 * 静默导航，并给出：重试保存 / 复制本地文本 / 下载本地 Markdown / 确认放弃。
 * “放弃”需要二次确认（不可撤销），且**不**删除服务端内容。
 */
export function NoteLeaveGuardDialog({
  open,
  reason,
  busy = false,
  copyState = 'idle',
  onRetrySave,
  onCopyLocal,
  onDownloadLocalMarkdown,
  onDiscardAndLeave,
  onStay,
}: NoteLeaveGuardDialogProps) {
  const { t } = useTranslation()
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  // 每次重新打开都复位二次确认（避免上次的“确认放弃”残留）。
  useEffect(() => {
    if (!open) setConfirmingDiscard(false)
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onStay()
      }}
    >
      <DialogContent data-testid="note-leave-guard-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('research.notes.leave.title')}</DialogTitle>
          <DialogDescription data-testid="note-leave-reason">
            {t(leaveReasonLabelKey(reason))}
          </DialogDescription>
        </DialogHeader>

        {copyState === 'failed' && (
          <p className="text-xs text-destructive" role="alert" data-testid="note-leave-copy-failed">
            {t('research.notes.conflict.copyFailed')}
          </p>
        )}
        {copyState === 'copied' && (
          <p className="text-xs" role="status" data-testid="note-leave-copied">
            {t('common.copyToClipboard')}
          </p>
        )}

        {confirmingDiscard ? (
          <div className="space-y-2 rounded border border-destructive/40 p-2" data-testid="note-leave-discard-confirm">
            <p className="text-sm">{t('research.notes.leave.discardConfirm')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmingDiscard(false)
                  onDiscardAndLeave()
                }}
              >
                {t('research.notes.leave.discardConfirmAction')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmingDiscard(false)}
                data-testid="note-leave-discard-cancel"
              >
                {t('research.notes.leave.stay')}
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter className="flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onRetrySave}
              disabled={busy}
              data-testid="note-leave-retry"
            >
              {t('research.notes.leave.retrySave')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onCopyLocal}
              disabled={busy || copyState === 'copying'}
              data-testid="note-leave-copy"
            >
              {t('research.notes.leave.copyLocal')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onDownloadLocalMarkdown}
              data-testid="note-leave-download"
            >
              {t('research.notes.leave.downloadMarkdown')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirmingDiscard(true)}
              data-testid="note-leave-discard"
            >
              {t('research.notes.leave.discard')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onStay} data-testid="note-leave-stay">
              {t('research.notes.leave.stay')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
