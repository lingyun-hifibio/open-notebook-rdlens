'use client'

import { useEffect, useRef, useState } from 'react'
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
  useDeleteResearchNote,
  useUpdateResearchNote,
} from '@/lib/hooks/use-research'
import { useNoteCatalog } from '@/lib/research/issue585/use-note-catalog'
import { useNoteCapabilities } from '@/lib/research/issue585/use-note-capabilities'
import { useNoteEditor } from '@/lib/research/issue585/use-note-editor'
import type { ResearchNoteD2 } from '@/lib/research/issue585/types'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import { NoteCatalog } from './issue585/NoteCatalog'
import { NoteCapabilityBlocked } from './issue585/NoteCapabilityBlocked'
import { NoteEditorView } from './issue585/NoteEditorView'
import { blockReasonLabelKey, noteErrorLabelKey } from './issue585/note-ui-labels'

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
 *
 * Issue #1046 PR4（D2-B2）：目录改为 d2-v1 单源（`useNoteCatalog`，同时含
 * 旧未保护 Note 与 d2-v1 受保护 Note）：
 * - `edit_schema='d2-v1'` → 新 Markdown 编辑器（`useNoteEditor`），能力故障
 *   时渲染明确阻断态，**绝不**退回无 revision 旧表单；
 * - `edit_schema=null`（旧未保护 Note）→ 保持既有旧表单行为（PATCH
 *   updateNote / deleteNote），入口与搜索/Scope 选择不变；
 * - 空白新建入口只在 `capabilities.noteEditor.available` 时可用（开关只控制
 *   入口；已有 d2-v1 文档仍可打开并安全保存）。
 */
export function NotesPanel({
  revealId = null,
  revealSeq = null,
}: {
  /** RWV2-23（AC3）：保存为 Note 后的左栏高亮目标（行 ring） */
  revealId?: string | null
  /** RWV2-23：reveal 递增序号——触发清除活跃搜索词（否则过滤会隐藏新条目） */
  revealSeq?: number | null
}) {
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

  // 单一目录数据源：d2-v1 投影同时包含旧未保护行（edit_schema=null）。
  const catalog = useNoteCatalog({ projectId, search: debouncedSearch })
  const capabilitiesResult = useNoteCapabilities(projectId)
  const editor = useNoteEditor({
    projectId,
    capabilities: capabilitiesResult.capabilities,
    isAdminReadonly,
  })

  // 目录行点击后记录目标 note_id：打开失败/能力故障时供编辑器重试打开。
  const [requestedNoteId, setRequestedNoteId] = useState<string | null>(null)
  // 最新 editor 状态/动作引用：异步动作返回 null 后（闭包里的 state 已过期）
  // 仍能拿到真实失败原因；卸载 cleanup 也能触发最后一次 flush。
  const editorStateRef = useRef(editor.state)
  editorStateRef.current = editor.state
  const editorActionsRef = useRef(editor.actions)
  editorActionsRef.current = editor.actions

  // 审查 A M3（本 PR 最小缓解）：NotesPanel 因切 pane/项目卸载时尽力 flush
  // 未决保存并持久化草稿。父级导航（ResearchWorkbench.tsx）不在本 PR 白名单，
  // 无法在此阻断；此 cleanup 只保证不因卸载而丢失已编辑文本。
  useEffect(() => {
    return () => {
      void editorActionsRef.current.flushBeforeLeave()
    }
  }, [])

  // 旧未保护 Note 的旧表单（行为与 #1045 前一致；仅 edit_schema=null 行走这里）。
  const updateMutation = useUpdateResearchNote(projectId)
  const deleteMutation = useDeleteResearchNote(projectId)
  const [showLegacyForm, setShowLegacyForm] = useState(false)
  const [editingLegacyNote, setEditingLegacyNote] = useState<ResearchNoteD2 | null>(null)
  const [legacyTitle, setLegacyTitle] = useState('')
  const [legacyContent, setLegacyContent] = useState('')

  // RWV2-23（R2-5/R3-3）：reveal 时若存在活跃搜索词，新 Note 会被过滤而不
  // 可见——先复位搜索词（本地输入 + debounce 参数由同一 state 驱动）。
  useEffect(() => {
    if (revealSeq !== null && revealSeq !== undefined) {
      setSearch('')
    }
  }, [revealSeq])

  const startEditLegacy = (note: ResearchNoteD2) => {
    setEditingLegacyNote(note)
    setLegacyTitle(note.title)
    setLegacyContent(note.content)
    setShowLegacyForm(true)
  }

  const submitLegacyUpdate = () => {
    if (!editingLegacyNote || !legacyTitle.trim() || !legacyContent.trim()) return
    updateMutation.mutate({
      noteId: editingLegacyNote.note_id,
      input: { title: legacyTitle.trim(), content: legacyContent.trim() },
    })
    setEditingLegacyNote(null)
    setLegacyTitle('')
    setLegacyContent('')
    setShowLegacyForm(false)
  }

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

  const createBlankNote = async (): Promise<void> => {
    setShowLegacyForm(false)
    const noteId = await editor.actions.createBlankNote()
    if (noteId !== null) {
      await catalog.refresh()
      return
    }
    // 审查 A M2：新建失败不得静默回 idle——给出明确错误反馈（原因取最新
    // machine 状态：归一化错误码优先，其次阻断原因，最后通用“暂不可用”）。
    const latest = editorStateRef.current
    const description = latest.error?.code
      ? t(noteErrorLabelKey(latest.error.code))
      : latest.blockReason
        ? t(blockReasonLabelKey(latest.blockReason))
        : t('research.notes.catalog.createUnavailable')
    toast({ title: t('common.error'), description, variant: 'destructive' })
  }

  const openD2Note = async (noteId: string): Promise<void> => {
    setShowLegacyForm(false)
    setRequestedNoteId(noteId)
    await editor.actions.openNote(noteId)
  }

  const closeEditor = async (): Promise<void> => {
    const closed = await editor.actions.closeEditor()
    if (closed) setRequestedNoteId(null)
  }

  const canCreate = !isAdminReadonly && capabilitiesResult.capabilities?.noteEditor.available === true
  const createBlockedReason = capabilitiesResult.isLoading
    ? null
    : (capabilitiesResult.capabilities?.noteEditor.reason ??
      capabilitiesResult.error?.code ??
      'capability_unknown')

  const editorVisible = editor.state.note !== null || editor.state.status !== 'idle'
  // 目录级能力阻断提示只在编辑器未打开时展示；编辑器打开后由
  // NoteEditorView 自己渲染阻断态（避免重复的 note-capability-blocked）。
  const showCapabilityAlert =
    !isAdminReadonly && capabilitiesResult.error !== null && !editorVisible

  return (
    <div className="space-y-3">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {showCapabilityAlert && capabilitiesResult.error !== null && (
        <NoteCapabilityBlocked
          reason={capabilitiesResult.error.code}
          canEditExisting={capabilitiesResult.capabilities?.noteEditorExisting.available === true}
          onRetry={() => void capabilitiesResult.refresh()}
        />
      )}

      <NoteCatalog
        items={catalog.items}
        isLoading={catalog.isLoading}
        error={catalog.error}
        search={search}
        onSearchChange={setSearch}
        canCreate={canCreate}
        createBlockedReason={isAdminReadonly ? null : createBlockedReason}
        createPending={editor.state.status === 'loading' && editor.state.note === null}
        onCreateBlank={() => void createBlankNote()}
        canEdit={!isAdminReadonly}
        activeNoteId={editor.state.note?.note_id ?? null}
        onOpenNote={(noteId) => void openD2Note(noteId)}
        onRefresh={() => void catalog.refresh()}
        revealId={revealId}
        scopeControl={(item) => (
          <Checkbox
            checked={selectedNoteIds.includes(item.note_id)}
            onCheckedChange={() => toggleNote(item.note_id)}
            disabled={
              mode === 'selected' &&
              selectedCount === 1 &&
              selectedNoteIds.includes(item.note_id)
            }
            aria-label={t('research.notes.scopeSelect', {
              title:
                item.access_state === 'restricted'
                  ? t('research.notes.catalog.restricted')
                  : item.title,
            })}
            data-testid={`note-scope-${item.note_id}`}
            className="mt-0.5 shrink-0"
          />
        )}
        legacyActions={(item) => (
          <>
            <Button size="sm" variant="ghost" onClick={() => startEditLegacy(item)}>
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
                  <AlertDialogAction onClick={() => deleteSelectedNote(item.note_id)}>
                    {t('common.confirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      />

      {showLegacyForm && !isAdminReadonly && (
        <Card>
          <CardContent className="space-y-3 p-3">
            <p className="text-xs text-muted-foreground" data-testid="legacy-note-form-hint">
              {t('research.notes.catalog.legacyBadge')}
            </p>
            <div className="space-y-1">
              <Label htmlFor="note-title">{t('research.notes.titleLabel')}</Label>
              <Input
                id="note-title"
                value={legacyTitle}
                onChange={(event) => setLegacyTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="note-content">{t('research.notes.contentLabel')}</Label>
              <Textarea
                id="note-content"
                value={legacyContent}
                onChange={(event) => setLegacyContent(event.target.value)}
                rows={4}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submitLegacyUpdate} disabled={updateMutation.isPending}>
                {t('research.notes.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowLegacyForm(false)}>
                {t('research.notes.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {editorVisible && (
        <Card>
          <CardContent className="space-y-3 p-3">
            <NoteEditorView
              state={editor.state}
              actions={editor.actions}
              capabilities={capabilitiesResult.capabilities}
              isAdminReadonly={isAdminReadonly}
              onRequestClose={() => void closeEditor()}
              onCopySaved={() => void catalog.refresh()}
              onRetryOpen={
                requestedNoteId !== null
                  ? () => void editor.actions.openNote(requestedNoteId)
                  : undefined
              }
              onRetryCapabilities={() => void capabilitiesResult.refresh()}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
