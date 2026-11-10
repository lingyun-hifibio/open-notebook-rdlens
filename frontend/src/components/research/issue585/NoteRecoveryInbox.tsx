'use client'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { RecoverableNoteDraftSummary } from '@/lib/research/issue585/note-draft-cache'
import { formatCachedAt } from './note-ui-labels'

export interface NoteRecoveryInboxProps {
  /** 本标签页/本项目仍待恢复的草稿（Issue #1136；正文恢复走 openNote 权限校验）。 */
  drafts: readonly RecoverableNoteDraftSummary[]
  /** 目录中已确认 `access_state='restricted'` 的笔记：标题脱敏、隐藏取回动作。 */
  restrictedNoteIds?: ReadonlySet<string>
  onOpen: (noteId: string) => void
  /** 复制本地草稿正文（显式点击才读取缓存；与打开/恢复正文相互独立）。 */
  onCopyLocal?: (noteId: string) => void
  /** 下载本地草稿 Markdown（方案 §4.4 的用户取回入口，不冒充已保存导出）。 */
  onDownloadLocal?: (noteId: string) => void
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
 * 独立审查 HIGH-1：打开失败（离线/503）时编辑器会把文档置为未加载的阻断态，
 * 其“关闭”按钮不认为存在本地文本、会直接 discardLocal 并删除唯一草稿。因此
 * 每行在**打开之前**就提供「复制本地正文 / 下载本地 Markdown」显式取回入口；
 * 取回只在用户点击时读取缓存，不填充编辑器。已知 restricted 的笔记标题脱敏、
 * 不提供取回动作（方案 §4.2：权限受限后停止展示内容，打开时清理草稿）。
 *
 * 文案全部复用 PR4 已存在的 locale 键（不新增 key）。
 */
export function NoteRecoveryInbox({
  drafts,
  restrictedNoteIds,
  onOpen,
  onCopyLocal,
  onDownloadLocal,
  className,
}: NoteRecoveryInboxProps) {
  const { t } = useTranslation()
  if (drafts.length === 0) return null

  return (
    <div className={className} data-testid="note-recovery-inbox">
      {/* 非阻塞恢复入口：用 status（隐式 polite live region），避免每次进入
          Notes 面板都 assertive 播报整张列表。 */}
      <Alert role="status">
        <p className="mb-1 font-medium leading-none tracking-tight">
          {t('research.notes.editor.saveStatus.pending')}
        </p>
        <AlertDescription>
          <p>{t('research.notes.leave.unsaved')}</p>
          <ul className="mt-2 space-y-2">
            {drafts.map((draft) => {
              const restricted = restrictedNoteIds?.has(draft.noteId) === true
              const cachedAt = restricted ? null : formatCachedAt(draft.savedAt)
              const rawTitle = draft.title.trim()
              const title = restricted
                ? t('research.notes.catalog.restricted')
                : rawTitle.length > 0
                  ? rawTitle
                  : t('research.notes.editor.untitled')
              return (
                <li
                  key={draft.noteId}
                  className="flex flex-wrap items-center justify-between gap-2"
                  data-testid={`note-recovery-row-${draft.noteId}`}
                  data-restricted={restricted ? 'true' : undefined}
                >
                  <div className="min-w-0">
                    <p
                      className="truncate text-sm"
                      title={restricted ? undefined : title}
                      data-testid={`note-recovery-title-${draft.noteId}`}
                    >
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
                  <div className="flex flex-wrap items-center gap-1">
                    {!restricted && onCopyLocal !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onCopyLocal(draft.noteId)}
                        data-testid={`note-recovery-copy-${draft.noteId}`}
                      >
                        {t('research.notes.leave.copyLocal')}
                      </Button>
                    )}
                    {!restricted && onDownloadLocal !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onDownloadLocal(draft.noteId)}
                        data-testid={`note-recovery-download-${draft.noteId}`}
                      >
                        {t('research.notes.leave.downloadMarkdown')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onOpen(draft.noteId)}
                      data-testid={`note-recovery-open-${draft.noteId}`}
                    >
                      {t('research.notes.catalog.openNote')}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  )
}
