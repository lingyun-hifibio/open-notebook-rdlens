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
import type { NoteEditorConflict } from '@/lib/research/issue585/types'

export interface NoteConflictDialogProps {
  open: boolean
  /** 409 `note_revision_conflict` 携带的当前 revision/hash（可为 null）。 */
  conflict: NoteEditorConflict | null
  /** 本地未保存正文（只读展示；复制/另存都以它为准）。 */
  localContent: string
  /** 另存/复制进行中（按钮防重入）。 */
  busy?: boolean
  /** 复制结果：failed 时给出手动复制提示，不假装成功。 */
  copyState?: 'idle' | 'copying' | 'copied' | 'failed'
  /** 另存失败（归一化错误）；成功路径由父层关闭/切换文档。 */
  saveAsCopyError?: string | null
  onCopyLocal: () => void
  onSaveAsCopy: () => void
  onLoadLatest: () => void
  /** 继续本地编辑（弹窗关闭，自动保存仍暂停）。 */
  onKeepEditing: () => void
}

/**
 * 版本冲突对话框（Issue #1046 PR4，方案 §4.1）。
 *
 * 只提供三条明确路径：复制本地内容 / 受保护另存（copies）/ 加载最新版
 * （先确认放弃）。**禁止自动合并与强制覆盖**——这里没有、也不得新增
 * “覆盖服务端”/“合并”按钮；自动保存由 hook 暂停，本组件只收集用户决定。
 */
export function NoteConflictDialog({
  open,
  conflict,
  localContent,
  busy = false,
  copyState = 'idle',
  saveAsCopyError = null,
  onCopyLocal,
  onSaveAsCopy,
  onLoadLatest,
  onKeepEditing,
}: NoteConflictDialogProps) {
  const { t } = useTranslation()
  const [confirmingLoadLatest, setConfirmingLoadLatest] = useState(false)

  // 关闭/重新打开时复位“加载最新版”的二次确认，避免上一次状态泄漏。
  useEffect(() => {
    if (!open) setConfirmingLoadLatest(false)
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Esc/遮罩关闭等同“继续编辑”，不静默丢弃本地正文。
        if (!next) onKeepEditing()
      }}
    >
      <DialogContent data-testid="note-conflict-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('research.notes.conflict.title')}</DialogTitle>
          <DialogDescription>{t('research.notes.conflict.description')}</DialogDescription>
        </DialogHeader>

        {conflict?.currentRevision !== null && conflict?.currentRevision !== undefined && (
          <p className="text-xs text-muted-foreground" data-testid="note-conflict-current-revision">
            {t('research.notes.conflict.currentRevision', {
              revision: conflict.currentRevision,
            })}
          </p>
        )}

        <div className="space-y-1">
          <p className="text-sm font-medium">{t('research.notes.conflict.localContent')}</p>
          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-xs"
            data-testid="note-conflict-local-content"
          >
            {localContent}
          </pre>
        </div>

        {copyState === 'failed' && (
          <p className="text-xs text-destructive" role="alert" data-testid="note-conflict-copy-failed">
            {t('research.notes.conflict.copyFailed')}
          </p>
        )}
        {copyState === 'copied' && (
          <p className="text-xs" role="status" data-testid="note-conflict-copied">
            {t('common.copyToClipboard')}
          </p>
        )}
        {saveAsCopyError !== null && (
          <p className="text-xs text-destructive" role="alert" data-testid="note-conflict-save-as-copy-failed">
            {t('research.notes.conflict.saveAsCopyFailed')}
          </p>
        )}

        {confirmingLoadLatest ? (
          <div className="space-y-2 rounded border border-destructive/40 p-2" data-testid="note-conflict-load-latest-confirm">
            <p className="text-sm font-medium">{t('research.notes.conflict.loadLatestConfirmTitle')}</p>
            <p className="text-xs text-muted-foreground">
              {t('research.notes.conflict.loadLatestConfirm')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmingLoadLatest(false)
                  onLoadLatest()
                }}
              >
                {t('research.notes.conflict.loadLatestConfirmAction')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmingLoadLatest(false)}
                data-testid="note-conflict-load-latest-cancel"
              >
                {t('research.notes.conflict.keepEditing')}
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter className="flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onCopyLocal}
              disabled={busy || copyState === 'copying'}
              data-testid="note-conflict-copy-local"
            >
              {t('research.notes.conflict.copyLocal')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onSaveAsCopy}
              disabled={busy || localContent.trim().length === 0}
              data-testid="note-conflict-save-as-copy"
            >
              {busy ? t('research.notes.conflict.savingAsCopy') : t('research.notes.conflict.saveAsCopy')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmingLoadLatest(true)}
              data-testid="note-conflict-load-latest"
            >
              {t('research.notes.conflict.loadLatest')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onKeepEditing}
              data-testid="note-conflict-keep-editing"
            >
              {t('research.notes.conflict.keepEditing')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
