'use client'

import { useEffect, useState } from 'react'
import { useDebounce } from 'use-debounce'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchScope } from '@/lib/research/scope'
import {
  useCreateResearchNote,
  useDeleteResearchNote,
  useResearchNotes,
  useUpdateResearchNote,
} from '@/lib/hooks/use-research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import type { ResearchNote } from '@/lib/types/research'

const DISPLAY_PAGE_SIZE = 20

/**
 * Notes 工作台（UI-02，REQ-SCOPE-04/REQ-API-01/REQ-DIS-01，设计 §4.4）。
 *
 * Owner：创建/编辑/删除（保存载荷仅 title/content，永不触发
 * Embedding，REQ-DIS-01）；Admin：只读列表 + 提示横幅，无写入口；即使
 * 写请求意外发出，后端 403 也会由 hook 以 toast 呈现（禁用入口不替代
 * 后端授权）。搜索为 Gateway 词法搜索（?q=，项目过滤后执行，不生成向量）。
 *
 * RWV2-13（Issue #34）：行首复选框承担 Note 的 Scope 选择（唯一编辑面；
 * 写入根级 provider，与右栏摘要即时同步）；**搜索过滤只改变可见行，隐藏
 * 选择保留在 provider**（AC：Search/filter/tab 变化不得清空隐藏选择）；
 * Edit/Delete 与选择互不干扰。
 */
export function NotesPanel() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const {
    mode,
    selectedSourceIds,
    selectedNoteIds,
    toggleNote,
    removeNote,
  } = useResearchScope()
  const selectedCount = selectedSourceIds.length + selectedNoteIds.length
  const [search, setSearch] = useState('')
  const [debouncedSearch] = useDebounce(search, 300)
  const { data, isLoading, isError, refetch } = useResearchNotes(projectId, debouncedSearch)
  const createMutation = useCreateResearchNote(projectId)
  const updateMutation = useUpdateResearchNote(projectId)
  const deleteMutation = useDeleteResearchNote(projectId)

  const [showForm, setShowForm] = useState(false)
  const [editingNote, setEditingNote] = useState<ResearchNote | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [visibleCount, setVisibleCount] = useState(DISPLAY_PAGE_SIZE)

  useEffect(() => {
    setVisibleCount(DISPLAY_PAGE_SIZE)
  }, [debouncedSearch, projectId])

  const startEdit = (note: ResearchNote) => {
    setEditingNote(note)
    setTitle(note.title)
    setContent(note.content)
    setShowForm(true)
  }

  const submitCreate = () => {
    if (!title.trim() || !content.trim()) return
    createMutation.mutate({ title: title.trim(), content: content.trim() })
    setTitle('')
    setContent('')
    setShowForm(false)
  }

  const submitUpdate = () => {
    if (!editingNote || !title.trim() || !content.trim()) return
    updateMutation.mutate({
      noteId: editingNote.note_id,
      input: { title: title.trim(), content: content.trim() },
    })
    setEditingNote(null)
    setTitle('')
    setContent('')
    setShowForm(false)
  }

  const items = data?.items ?? []
  const visibleItems = items.slice(0, visibleCount)

  const deleteSelectedNote = (noteId: string) => {
    deleteMutation.mutate(noteId, {
      onSuccess: () => {
        if (removeNote(noteId)) {
          toast({
            title: t('research.layout.scope.modeLabel'),
            description: t('research.layout.scope.reconciled'),
          })
        }
      },
    })
  }

  return (
    <div className="space-y-3">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {!isAdminReadonly && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <Input
            placeholder={t('research.notes.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-xs"
            aria-label="search"
          />
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {t('research.notes.newNote')}
          </Button>
        </div>
      )}

      {showForm && !isAdminReadonly && (
        <Card>
          <CardContent className="space-y-3 p-3">
            <div className="space-y-1">
              <Label htmlFor="note-title">{t('research.notes.titleLabel')}</Label>
              <Input
                id="note-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="note-content">{t('research.notes.contentLabel')}</Label>
              <Textarea
                id="note-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={4}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={editingNote ? submitUpdate : submitCreate}
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {t('research.notes.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                {t('research.notes.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            {t('research.retry')}
          </Button>
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.notes.empty')}</p>
      )}

      <ul className="divide-y divide-border" data-testid="note-list-rows">
        {visibleItems.map((item) => (
          <li
            key={item.note_id}
            className="group flex items-start gap-2 rounded px-2 py-1.5 hover:bg-accent/60"
          >
            <Checkbox
              checked={selectedNoteIds.includes(item.note_id)}
              onCheckedChange={() => toggleNote(item.note_id)}
              disabled={
                mode === 'selected' &&
                selectedCount === 1 &&
                selectedNoteIds.includes(item.note_id)
              }
              aria-label={t('research.notes.scopeSelect', { title: item.title })}
              data-testid={`note-scope-${item.note_id}`}
              className="mt-0.5 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.title}</p>
              <p className="truncate text-xs text-muted-foreground">{item.content}</p>
            </div>
            {!isAdminReadonly && (
              <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <Button size="sm" variant="ghost" onClick={() => startEdit(item)}>
                  {t('research.notes.edit')}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" aria-label={t('research.notes.delete')}>
                      {t('research.notes.delete')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('research.notes.confirmDelete')}</AlertDialogTitle>
                      <AlertDialogDescription>{item.title}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('research.notes.cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteSelectedNote(item.note_id)}
                      >
                        {t('common.confirm')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </li>
        ))}
      </ul>
      {visibleItems.length < items.length && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setVisibleCount((count) => count + DISPLAY_PAGE_SIZE)}
        >
          {t('research.pagination.loadMore')}
        </Button>
      )}
    </div>
  )
}
