'use client'

import { useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { blockReasonLabelKey } from './note-ui-labels'

export interface NoteCapabilityBlockedProps {
  /**
   * 阻断的稳定机器码：能力原因（disabled_by_flag/note_store_unavailable/
   * not_ready/capability_unknown）或 API 错误码（note_not_found/
   * note_access_restricted/note_edit_schema_unsupported/
   * note_dependency_unavailable…）。未知码落到通用文案。
   */
  reason: string | null
  /**
   * 能力关闭（note_editor=false）时已有 d2-v1 文档仍可安全打开保存——
   * 展示该提示，避免用户误以为所有编辑都被禁。
   */
  canEditExisting?: boolean
  /** 重试（重新读取能力/重新打开文档）；删除等不可重试场景不传。 */
  onRetry?: () => void
  /** 本地文本取回入口（删除/受限/能力故障时保留可取回文本）。 */
  onCopyLocal?: () => void
  onDownloadLocalMarkdown?: () => void
  /**
   * 关闭编辑器（返回目录）。调用方负责在关闭前执行“放弃本地编辑”动作；
   * 本组件只在 `closeNeedsConfirm` 时先做二次确认。
   */
  onClose?: () => void
  /**
   * 本地存在未保存文本：关闭前必须二次确认，避免静默丢弃（审查 A HIGH-1）。
   */
  closeNeedsConfirm?: boolean
  className?: string
}

/**
 * Note 编辑能力/权限/删除阻断态（Issue #1046 PR4，方案 §4.1/§4.2/§8.2）。
 *
 * 硬约束：阻断态**绝不**渲染可编辑的标题/正文表单，也不退回无 revision 的
 * 旧表单（旧表单只属于 `edit_schema=null` 的旧未保护 Note，由 NotesPanel
 * 决定）。这里给出原因、重试、本地文本取回与可关闭出口；本地有未保存文本
 * 时关闭必须二次确认（不是静默丢弃）。
 */
export function NoteCapabilityBlocked({
  reason,
  canEditExisting = false,
  onRetry,
  onCopyLocal,
  onDownloadLocalMarkdown,
  onClose,
  closeNeedsConfirm = false,
  className,
}: NoteCapabilityBlockedProps) {
  const { t } = useTranslation()
  const [confirmingClose, setConfirmingClose] = useState(false)
  const reasonKey = blockReasonLabelKey(reason)
  const showExistingHint = canEditExisting && reason === 'disabled_by_flag'

  // 阻断原因变化（例如重试后换了一种失败）时复位二次确认。
  useEffect(() => {
    setConfirmingClose(false)
  }, [reason])

  return (
    <div className={className} data-testid="note-capability-blocked" data-reason={reason ?? 'unknown'}>
      <Alert variant="destructive" role="alert">
        <AlertTitle>{t('research.notes.capability.title')}</AlertTitle>
        <AlertDescription>
          <p data-testid="note-capability-reason">{t(reasonKey)}</p>
          {showExistingHint && (
            <p className="text-xs" data-testid="note-capability-existing-hint">
              {t('research.notes.capability.existingEditableHint')}
            </p>
          )}
        </AlertDescription>
      </Alert>

      {confirmingClose ? (
        <div
          className="mt-2 space-y-2 rounded border border-destructive/40 p-2"
          data-testid="note-capability-close-confirm"
        >
          <p className="text-sm">{t('research.notes.leave.discardConfirm')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={onClose}
              data-testid="note-capability-close-confirm-action"
            >
              {t('research.notes.leave.discardConfirmAction')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingClose(false)}
              data-testid="note-capability-close-confirm-cancel"
            >
              {t('research.notes.leave.stay')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {onRetry && (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              data-testid="note-capability-retry"
            >
              {t('research.notes.capability.retry')}
            </Button>
          )}
          {onCopyLocal && (
            <Button
              size="sm"
              variant="outline"
              onClick={onCopyLocal}
              data-testid="note-capability-copy-local"
            >
              {t('research.notes.capability.copyLocal')}
            </Button>
          )}
          {onDownloadLocalMarkdown && (
            <Button
              size="sm"
              variant="outline"
              onClick={onDownloadLocalMarkdown}
              data-testid="note-capability-download"
            >
              {t('research.notes.capability.downloadMarkdown')}
            </Button>
          )}
          {onClose && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (closeNeedsConfirm) {
                  setConfirmingClose(true)
                  return
                }
                onClose()
              }}
              data-testid="note-capability-close"
            >
              {t('research.notes.capability.close')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
