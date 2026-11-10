'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { RecoverableNoteDraftSummary } from '@/lib/research/issue585/note-draft-cache'
import { formatCachedAt } from './note-ui-labels'

export interface NoteRecoveryInboxProps {
  /** 本标签页/本项目仍待恢复的草稿（Issue #1136；正文恢复走 openNote 权限校验）。 */
  drafts: readonly RecoverableNoteDraftSummary[]
  onOpen: (noteId: string) => void
  className?: string
}

/**
 * 可恢复草稿入口（Issue #1136：工作台父级导航「自动保存＋可恢复」）。
 *
 * 父级导航（切 pane／切项目／页面跳转）不阻断；离开前已尽力 flush 并把本地
 * 草稿同步持久化。若服务端保存未能完成（失败／冲突／结果未知），回到 Notes
 * 目录时这里**显式列出**仍待恢复的草稿，避免“草稿只在下次碰巧打开同一篇时
 * 才出现”的静默恢复路径；点「打开笔记」后由编辑器恢复正文并继续显示 PR4
 * 既有的恢复横幅/保存状态/冲突对话框。
 *
 * 文案全部复用 PR4 已存在的 locale 键（不新增 key）：标题=未保存状态、
 * 说明=未保存提示、行内=草稿标题 + 缓存时间、动作=打开笔记。
 */
export function NoteRecoveryInbox({ drafts, onOpen, className }: NoteRecoveryInboxProps) {
  const { t } = useTranslation()
  if (drafts.length === 0) return null

  return (
    <div className={className} data-testid="note-recovery-inbox">
      <Alert variant="default">
        <AlertTitle>{t('research.notes.editor.saveStatus.pending')}</AlertTitle>
        <AlertDescription>
          <p>{t('research.notes.leave.unsaved')}</p>
          <ul className="mt-2 space-y-2">
            {drafts.map((draft) => {
              const cachedAt = formatCachedAt(draft.savedAt)
              const title = draft.title.trim().length > 0
                ? draft.title
                : t('research.notes.editor.untitled')
              return (
                <li
                  key={draft.noteId}
                  className="flex flex-wrap items-center justify-between gap-2"
                  data-testid={`note-recovery-row-${draft.noteId}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm" data-testid={`note-recovery-title-${draft.noteId}`}>
                      {title}
                    </p>
                    {cachedAt !== null && (
                      <p
                        className="text-xs text-muted-foreground"
                        data-testid={`note-recovery-saved-at-${draft.noteId}`}
                      >
                        {t('research.notes.editor.recovery.savedAt', { time: cachedAt })}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpen(draft.noteId)}
                    data-testid={`note-recovery-open-${draft.noteId}`}
                  >
                    {t('research.notes.catalog.openNote')}
                  </Button>
                </li>
              )
            })}
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  )
}
