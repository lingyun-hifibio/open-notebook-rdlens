'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import {
  useCreateResearchNote,
  useDeleteResearchNote,
  useResearchNotes,
  useUpdateResearchNote,
} from '@/lib/hooks/use-research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import type { ResearchNote } from '@/lib/types/research'

/**
 * Notes 工作台（UI-02，REQ-SCOPE-04/REQ-API-01/REQ-DIS-01，设计 §4.4）。
 *
 * Owner：创建/编辑/删除（保存载荷仅 title/content，永不触发
 * Embedding，REQ-DIS-01）；Admin：只读列表 + 提示横幅，无写入口；即使
 * 写请求意外发出，后端 403 也会由 hook 以 toast 呈现（禁用入口不替代
 * 后端授权）。搜索为 Gateway 词法搜索（?q=，项目过滤后执行，不生成向量）。
 */
export function NotesPanel() {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const [search, setSearch] = useState('')
  const { data, isLoading, isError } = useResearchNotes(projectId, search)
  const createMutation = useCreateResearchNote(projectId)
  const updateMutation = useUpdateResearchNote(projectId)
  const deleteMutation = useDeleteResearchNote(projectId)

  const [showForm, setShowForm] = useState(false)
  const [editingNote, setEditingNote] = useState<ResearchNote | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')

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

  return (
    <div className="space-y-3">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {!isAdminReadonly && (
        <div className="flex items-center justify-between gap-2">
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
      {isError && <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>}

      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.notes.empty')}</p>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <Card key={item.note_id}>
            <CardContent className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {item.content}
                </p>
              </div>
              {!isAdminReadonly && (
                <>
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
                        onClick={() => deleteMutation.mutate(item.note_id)}
                      >
                        {t('common.confirm')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
