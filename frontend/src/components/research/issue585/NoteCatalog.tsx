'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Trash2 } from 'lucide-react'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { NoteApiError, ResearchNoteD2 } from '@/lib/research/issue585/types'

const DISPLAY_PAGE_SIZE = 20

export interface NoteCatalogProps {
  /** d2-v1 目录（含旧未保护 Note；`edit_schema===null` 的行走旧表单）。 */
  items: ResearchNoteD2[]
  isLoading: boolean
  error: NoteApiError | null
  /** 词法搜索词（300ms debounce 由调用方负责）。 */
  search: string
  onSearchChange: (value: string) => void
  /** 空白新建入口仅在 `capabilities.noteEditor.available` 时为 true。 */
  canCreate: boolean
  /** 入口关闭时的机器可读原因（如 disabled_by_flag），用于说明文案。 */
  createBlockedReason?: string | null
  /** 新建请求进行中（防重入）。 */
  createPending?: boolean
  onCreateBlank: () => void
  /** Admin 只读时 false：无新建/编辑入口。 */
  canEdit: boolean
  /** 当前打开的 d2-v1 文档（行高亮）。 */
  activeNoteId?: string | null
  /** 打开 d2-v1 文档（旧未保护行不得调用；由 legacyActions 提供旧入口）。 */
  onOpenNote: (noteId: string) => void
  /** Issue #1047 PR5（B3）：把该 Note 作为来源摘入其他文档（仅 d2-v1 行）。 */
  onExcerptNote?: (item: ResearchNoteD2) => void
  /**
   * Issue #1134：打开该 d2-v1 行的删除二次确认（仅 d2-v1 受保护行）。
   * 旧未保护行不得调用（旧删除入口由 `legacyActions` 提供，语义不变）。
   */
  onRequestDelete?: (item: ResearchNoteD2) => void
  /** Issue #1134：该行当前是否可删（能力/权限/revision 由调用方判定，fail-closed）。 */
  canDeleteNote?: (item: ResearchNoteD2) => boolean
  onRefresh: () => void
  /** Save-as-Note 后的高亮目标（RWV2-23）。 */
  revealId?: string | null
  /** 行首 Slot：NotesPanel 注入 Scope 复选框（唯一 Scope 编辑面）。 */
  scopeControl?: (item: ResearchNoteD2) => ReactNode
  /** 旧未保护行的操作 Slot：NotesPanel 注入既有 Edit/Delete（旧表单）。 */
  legacyActions?: (item: ResearchNoteD2) => ReactNode
  pageSize?: number
}

function isRestricted(item: ResearchNoteD2): boolean {
  return item.access_state === 'restricted'
}

function isD2(item: ResearchNoteD2): boolean {
  return item.edit_schema === 'd2-v1'
}

/**
 * 成果目录（Issue #1046 PR4，方案 §4.1；issue #1046 PR4 行）。
 *
 * - 单一目录数据源：d2-v1 受保护行 → 新编辑器；`edit_schema=null` 的旧
 *   未保护行 → 调用方注入的旧表单操作（行为不变）；受限行只显示“内容受限”
 *   占位，不渲染标题/正文（防泄露）。
 * - 空白新建入口只在 `canCreate`（`note_editor.available`）时可用；关闭时
 *   显示说明而不是静默消失。
 * - 搜索/加载/错误/空态与分页沿用既有 NotesPanel 行为。
 */
export function NoteCatalog({
  items,
  isLoading,
  error,
  search,
  onSearchChange,
  canCreate,
  createBlockedReason = null,
  createPending = false,
  onCreateBlank,
  canEdit,
  activeNoteId = null,
  onOpenNote,
  onExcerptNote,
  onRequestDelete,
  canDeleteNote,
  onRefresh,
  revealId = null,
  scopeControl,
  legacyActions,
  pageSize = DISPLAY_PAGE_SIZE,
}: NoteCatalogProps) {
  const { t } = useTranslation()
  const [visibleCount, setVisibleCount] = useState(pageSize)

  // 搜索词/项目变化时重置分页窗口（既有 NotesPanel 行为）。
  useEffect(() => {
    setVisibleCount(pageSize)
  }, [search, pageSize])

  const visibleItems = items.slice(0, visibleCount)

  return (
    <div className="space-y-3" data-testid="note-catalog">
      {canEdit && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <Input
            placeholder={t('research.notes.search')}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="max-w-xs"
            aria-label="search"
            data-testid="note-catalog-search"
          />
          <div className="flex items-center gap-2">
            {!canCreate && createBlockedReason !== null && (
              <span className="text-xs text-muted-foreground" data-testid="note-catalog-new-blocked">
                {t('research.notes.catalog.createUnavailable')}
              </span>
            )}
            <Button
              size="sm"
              onClick={onCreateBlank}
              disabled={!canCreate || createPending}
              data-testid="note-catalog-new"
            >
              {t('research.notes.newNote')}
            </Button>
          </div>
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground" data-testid="note-catalog-loading">
          {t('common.loading')}
        </p>
      )}
      {!isLoading && error !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
          <Button size="sm" variant="outline" onClick={onRefresh}>
            {t('research.notes.catalog.retry')}
          </Button>
        </div>
      )}

      {!isLoading && error === null && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.notes.empty')}</p>
      )}

      <ul className="divide-y divide-border" data-testid="note-list-rows">
        {visibleItems.map((item) => {
          const restricted = isRestricted(item)
          const d2 = isD2(item)
          const active = d2 && item.note_id === activeNoteId
          // Issue #1134：d2-v1 行删除入口的可见性由调用方判定（fail-closed）。
          const deleteEntryVisible =
            onRequestDelete !== undefined && (canDeleteNote?.(item) ?? true)
          return (
            <li
              key={item.note_id}
              data-testid={`note-catalog-row-${item.note_id}`}
              data-restricted={restricted ? 'true' : 'false'}
              data-edit-schema={item.edit_schema ?? 'legacy'}
              className={`group flex items-start gap-2 rounded px-2 py-1.5 hover:bg-accent/60${
                item.note_id === revealId ? ' ring-1 ring-primary' : ''
              }${active ? ' bg-accent/40' : ''}`}
            >
              {scopeControl && <div className="shrink-0">{scopeControl(item)}</div>}
              <div className="min-w-0 flex-1">
                {restricted ? (
                  <>
                    <p
                      className="truncate text-sm font-medium text-muted-foreground"
                      data-testid={`note-catalog-restricted-${item.note_id}`}
                    >
                      {t('research.notes.catalog.restricted')}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t('research.notes.catalog.restrictedHint')}
                    </p>
                  </>
                ) : d2 ? (
                  <>
                    {canEdit ? (
                      <button
                        type="button"
                        className="block max-w-full truncate text-left text-sm font-medium underline-offset-2 hover:underline"
                        onClick={() => onOpenNote(item.note_id)}
                        aria-label={`${t('research.notes.catalog.openNote')}: ${item.title}`}
                        data-testid={`note-open-${item.note_id}`}
                      >
                        {item.title}
                      </button>
                    ) : (
                      <p className="truncate text-sm font-medium">{item.title}</p>
                    )}
                    <p className="truncate text-xs text-muted-foreground">{item.content}</p>
                    {item.revision !== null && (
                      <p className="text-xs text-muted-foreground" data-testid={`note-revision-${item.note_id}`}>
                        {t('research.notes.editor.revision', { revision: item.revision })}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.content}</p>
                    <p className="text-xs text-muted-foreground" data-testid={`note-legacy-${item.note_id}`}>
                      {t('research.notes.catalog.legacyBadge')}
                    </p>
                  </>
                )}
              </div>
              {legacyActions && !d2 && canEdit && (
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  {legacyActions(item)}
                </div>
              )}
              {d2 &&
                canEdit &&
                !restricted &&
                (onExcerptNote !== undefined || deleteEntryVisible) && (
                  <div className="flex shrink-0 items-start gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {deleteEntryVisible && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={t('research.notes.deleteDialog.entry')}
                        title={t('research.notes.deleteDialog.entry')}
                        onClick={() => onRequestDelete?.(item)}
                        data-testid={`note-delete-${item.note_id}`}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    )}
                    {onExcerptNote !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`note-excerpt-${item.note_id}`}
                        onClick={() => onExcerptNote(item)}
                      >
                        {t('research.notes.excerpt.entry')}
                      </Button>
                    )}
                  </div>
                )}
            </li>
          )
        })}
      </ul>

      {visibleItems.length < items.length && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setVisibleCount((count) => count + pageSize)}
        >
          {t('research.pagination.loadMore')}
        </Button>
      )}
    </div>
  )
}
