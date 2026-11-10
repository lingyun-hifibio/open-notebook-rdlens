'use client'

/**
 * Issue #1047 PR5（D2-B3）：摘入选段对话框。
 *
 * 两段式确认（方案 §5/§5.1）：
 * 1) **原始 Markdown 确认层**：textarea 里的文本就是服务端将解析的快照原串
 *    （source = markdown_chunks join；note/回答 = content 原串）。用户在其中
 *    选择 UTF-16 半开区间；渲染 DOM 偏移不作为 Markdown 偏移。
 * 2) **目标选择**：当前打开的 d2-v1 文档 / 目录中的已有 Note（点击后必须
 *    `GET /notes/{id}` 取新鲜正文+revision 再确认目标位置）/ 新建 Note 标题。
 *
 * 插入前先 flush 当前草稿（保存失败/冲突/未知结果不发插入）；目标为“已有
 * Note（非当前打开）”时用刚 GET 的 revision 作为 expected_revision，409 后
 * 暂停并重新 GET 让用户重选（不自动覆盖）。结果未知保留同一 mutation_id 与
 * 完整请求，仅提供显式「重试确认」。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import {
  createNoteFragmentD2,
  getNoteD2,
  insertNoteFragmentD2,
  newNoteMutationId,
  normalizeNoteApiError,
} from '@/lib/research/issue585/note-client'
import {
  buildFragmentSource,
  buildFragmentTarget,
  computeInsertedRange,
  resolveExcerptSelection,
} from '@/lib/research/issue585/excerpt'
import { useNoteCatalog } from '@/lib/research/issue585/use-note-catalog'
import type {
  NoteD2FragmentInsertRequest,
  NoteD2FragmentCreateRequest,
  NoteErrorCode,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import { noteErrorLabelKey } from './note-ui-labels'
import type {
  ExcerptSourcePayload,
  NoteWorkspaceEditorHandle,
} from './NoteWorkspaceProvider'

export interface ExcerptInsertDialogProps {
  source: ExcerptSourcePayload | null
  editor: NoteWorkspaceEditorHandle | null
  onClose: () => void
  onInserted: (
    noteId: string,
    selection: { start: number; end: number } | null,
  ) => void
}

type TargetKind = 'current' | 'existing' | 'new'

interface FreshTarget {
  readonly note: ResearchNoteD2
  readonly selection: { start: number; end: number }
}

interface PendingInsert {
  /** machine = 当前打开文档（同 mutation 确认必须走编辑器状态机）；其余为直连目标。 */
  readonly kind: 'machine' | 'existing' | 'new'
  readonly noteId: string | null
  readonly request: NoteD2FragmentInsertRequest | NoteD2FragmentCreateRequest
}

const SELECTION_ERROR_KEYS: Record<string, string> = {
  out_of_bounds: 'research.notes.excerpt.errors.outOfBounds',
  invalid_range: 'research.notes.excerpt.errors.invalidRange',
  empty_selection: 'research.notes.excerpt.errors.empty',
  surrogate_split: 'research.notes.excerpt.errors.surrogateSplit',
  too_large: 'research.notes.excerpt.errors.tooLarge',
  invalid_source_version: 'research.notes.excerpt.errors.invalidSourceVersion',
  quote_not_found: 'research.notes.excerpt.errors.quoteNotFound',
  ambiguous_quote: 'research.notes.excerpt.errors.ambiguousQuote',
  cross_chunk: 'research.notes.excerpt.errors.crossChunk',
}

function sourceKindLabelKey(kind: ExcerptSourcePayload['sourceKind']): string {
  if (kind === 'source') return 'research.notes.excerpt.sourceKinds.source'
  if (kind === 'chat_message') return 'research.notes.excerpt.sourceKinds.answer'
  if (kind === 'note') return 'research.notes.excerpt.sourceKinds.note'
  return 'research.notes.excerpt.sourceKinds.insight'
}

export function ExcerptInsertDialog({
  source,
  editor,
  onClose,
  onInserted,
}: ExcerptInsertDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const catalog = useNoteCatalog({ projectId, search: '' })

  const editorRef = useRef<NoteWorkspaceEditorHandle | null>(null)
  editorRef.current = editor
  const [selection, setSelection] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  })
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [targetKind, setTargetKind] = useState<TargetKind>('new')
  const [chosenNoteId, setChosenNoteId] = useState<string | null>(null)
  const [freshTarget, setFreshTarget] = useState<FreshTarget | null>(null)
  const [targetSelection, setTargetSelection] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  })
  const [newTitle, setNewTitle] = useState('')
  const [targetError, setTargetError] = useState<NoteErrorCode | 'editor_not_saved' | null>(null)
  const [loadingTarget, setLoadingTarget] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pendingInsert, setPendingInsert] = useState<PendingInsert | null>(null)
  // 新建目标：create 已成功但 read-back 失败时保留 note_id，重试只做读回，
  // 绝不以新 mutation 再建第二份文档（review LOW-5）。
  const createdNoteIdRef = useRef<string | null>(null)

  const currentNote = editor?.state.note ?? null
  const currentContent = editor?.state.content ?? ''

  // 打开新来源时复位（对话框不跨来源复用状态）。
  useEffect(() => {
    if (source === null) return
    const initial = source.initialSelection
    const fallbackEnd = source.text.length
    if (initial !== null && initial !== undefined && initial.end > initial.start) {
      setSelection({ start: initial.start, end: initial.end })
    } else {
      setSelection({ start: 0, end: fallbackEnd })
    }
    setSelectionError(null)
    setTargetError(null)
    setPendingInsert(null)
    createdNoteIdRef.current = null
    setChosenNoteId(null)
    setFreshTarget(null)
    setBusy(false)
    setTargetKind(currentNote !== null ? 'current' : 'new')
    setTargetSelection({ start: currentContent.length, end: currentContent.length })
    setNewTitle((source.title || t('research.notes.excerpt.defaultTitle')).slice(0, 80))
    // 只在来源变化时复位；当前文档内容后续变化不影响已打开的确认层。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // “当前打开文档”目标默认在末尾；正文变化时收敛到新的末尾。
  useEffect(() => {
    if (targetKind !== 'current') return
    setTargetSelection({ start: currentContent.length, end: currentContent.length })
  }, [targetKind, currentContent.length])

  const resolvedSelection = useMemo(() => {
    if (source === null) return null
    if (selection.end <= selection.start) return null
    return resolveExcerptSelection(source.text, {
      kind: 'range',
      start_utf16: selection.start,
      end_utf16: selection.end,
    })
  }, [selection.end, selection.start, source])

  const excerptPreview =
    resolvedSelection !== null && resolvedSelection.ok ? resolvedSelection.excerpt : ''

  async function loadFreshTarget(noteId: string): Promise<void> {
    setLoadingTarget(true)
    setTargetError(null)
    setFreshTarget(null)
    setChosenNoteId(noteId)
    try {
      // 目标目录行只用于选目标；必须 GET 新鲜正文+revision+hash 才能计算目标位置。
      const note = await getNoteD2(projectId, noteId)
      if (note.revision === null || note.snapshot_hash === null) {
        setTargetError('note_snapshot_unavailable')
        return
      }
      if (note.access_state === 'restricted') {
        setTargetError('note_access_restricted')
        return
      }
      setFreshTarget({
        note,
        selection: { start: note.content.length, end: note.content.length },
      })
      setTargetSelection({ start: note.content.length, end: note.content.length })
    } catch (error) {
      setTargetError(normalizeNoteApiError(error).code)
    } finally {
      setLoadingTarget(false)
    }
  }

  function handleTargetKindChange(kind: TargetKind): void {
    setTargetKind(kind)
    setTargetError(null)
    setPendingInsert(null)
    createdNoteIdRef.current = null
    if (kind !== 'existing') {
      setChosenNoteId(null)
      setFreshTarget(null)
    }
  }

  /** 目标文档的“新鲜”正文（当前 = 编辑器内容；已有 = 刚 GET 的快照）。 */
  function targetContent(): string | null {
    if (targetKind === 'current') return currentContent
    if (targetKind === 'existing') return freshTarget?.note.content ?? null
    return null
  }

  function targetLabel(): string {
    if (targetKind === 'current') {
      return t('research.notes.excerpt.target.currentLabel', {
        title: currentNote?.title ?? '',
      })
    }
    if (targetKind === 'existing' && freshTarget !== null) {
      return t('research.notes.excerpt.target.existingLabel', {
        title: freshTarget.note.title,
        revision: freshTarget.note.revision ?? '-',
      })
    }
    return t('research.notes.excerpt.target.newLabel')
  }

  async function handleInsert(): Promise<void> {
    if (source === null || busy) return
    setTargetError(null)
    const built = buildFragmentSource({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sourceVersion: source.sourceVersion,
      text: source.text,
      selection: { kind: 'range', start_utf16: selection.start, end_utf16: selection.end },
    })
    if (!built.ok) {
      setSelectionError(SELECTION_ERROR_KEYS[built.reason] ?? 'research.notes.excerpt.errors.empty')
      return
    }
    setSelectionError(null)
    if (isAdminReadonly) return

    if (targetKind !== 'current' && editor !== null && editor.state.status === 'ready') {
      // 插入前 flush 当前草稿：保存失败/冲突/未知结果一律不发插入（新/已有目标同规则）。
      const flush =
        editor.actions.flushForInsert ?? editor.actions.flushBeforeLeave
      const blocked = await flush()
      if (blocked !== null) {
        setTargetError(
          blocked === 'conflict'
            ? 'note_revision_conflict'
            : blocked === 'restricted'
              ? 'note_access_restricted'
              : blocked === 'unknown'
                ? 'note_store_unavailable'
                : 'editor_not_saved',
        )
        return
      }
    }

    if (targetKind === 'new') {
      const title = newTitle.trim()
      if (title.length === 0) {
        setTargetError('note_request_invalid')
        return
      }
      const request: NoteD2FragmentCreateRequest = {
        mutation_id: newNoteMutationId(),
        title,
        fragment: { source: built.source },
      }
      const pending: PendingInsert = { kind: 'new', noteId: null, request }
      setPendingInsert(pending)
      await sendPending(pending)
      return
    }

    const content = targetContent()
    if (content === null) return
    const target = buildFragmentTarget(content, targetSelection)
    if (target === null) {
      setTargetError('note_request_invalid')
      return
    }

    if (targetKind === 'current') {
      if (editor?.actions.insertFragment === undefined || editor.state.note === null) {
        setTargetError('note_edit_schema_unsupported')
        return
      }
      setBusy(true)
      try {
        const result = await editor.actions.insertFragment(
          { target, source: built.source },
          { start: targetSelection.start, end: targetSelection.end },
        )
        if (result.ok) {
          onInserted(editor.state.note.note_id, {
            start: result.insertedRange.end,
            end: result.insertedRange.end,
          })
          toast({ title: t('research.notes.excerpt.inserted') })
          onClose()
          return
        }
        setTargetError(result.code)
        if (result.retryable) {
          // 当前文档的未知结果只能由编辑器状态机用同一 mutation 确认；
          // 对话框不能另造一条直连写入。
          setPendingInsert({
            kind: 'machine',
            noteId: editor.state.note.note_id,
            request: {
              mutation_id: result.pendingMutationId ?? newNoteMutationId(),
              expected_revision: editor.state.baseRevision ?? 1,
              target,
              source: built.source,
            },
          })
        }
      } finally {
        setBusy(false)
      }
      return
    }

    // 已有 Note（非当前打开）：必须先用刚 GET 的 revision 作为 expected_revision。
    if (freshTarget === null) return
    const request: NoteD2FragmentInsertRequest = {
      mutation_id: newNoteMutationId(),
      expected_revision: freshTarget.note.revision ?? 1,
      target,
      source: built.source,
    }
    const pending: PendingInsert = { kind: 'existing', noteId: freshTarget.note.note_id, request }
    setPendingInsert(pending)
    await sendPending(pending)
  }

  async function sendPending(pending: PendingInsert): Promise<void> {
    setBusy(true)
    setTargetError(null)
    try {
      if (pending.kind === 'new') {
        const request = pending.request as NoteD2FragmentCreateRequest
        // 已有 create 成功记录时只重做读回（同 mutation 的 create 不会产生第二份）。
        const noteId =
          createdNoteIdRef.current ?? (await createNoteFragmentD2(projectId, request)).note_id
        if (createdNoteIdRef.current === null) createdNoteIdRef.current = noteId
        const fresh = await readBack(noteId)
        onInserted(noteId, {
          start: fresh.content.length,
          end: fresh.content.length,
        })
        toast({ title: t('research.notes.excerpt.inserted') })
        onClose()
        return
      }
      const noteId = pending.noteId
      if (noteId === null) return
      const request = pending.request as NoteD2FragmentInsertRequest
      await insertNoteFragmentD2(projectId, noteId, request)
      const fresh = await readBack(noteId)
      const before = freshTarget?.note.content ?? ''
      const inserted = computeInsertedRange(before, fresh.content)
      onInserted(noteId, {
        start: inserted?.end ?? fresh.content.length,
        end: inserted?.end ?? fresh.content.length,
      })
      // 回执应用后读投影已刷新：保持对话框状态一致（后续再插入可用新 revision）。
      setFreshTarget({
        note: fresh,
        selection: { start: fresh.content.length, end: fresh.content.length },
      })
      toast({ title: t('research.notes.excerpt.inserted') })
      onClose()
    } catch (error) {
      const apiError = normalizeNoteApiError(error)
      setTargetError(apiError.code)
      if (!apiError.retryable) {
        setPendingInsert(null)
        // create 已成功的读回失败：保留 createdNoteId，下一次 Insert 只读回该文档。
        if (pending.kind === 'new' && createdNoteIdRef.current !== null) return
        createdNoteIdRef.current = null
        if (apiError.code === 'note_revision_conflict' && pending.kind === 'existing' && pending.noteId !== null) {
          // 409：暂停，重新 GET 让用户重选（不自动覆盖、不自动重试）。
          const noteId = pending.noteId
          setPendingInsert(null)
          await loadFreshTarget(noteId)
          setTargetError('note_revision_conflict')
        }
      }
    } finally {
      setBusy(false)
    }
  }

  async function readBack(noteId: string): Promise<ResearchNoteD2> {
    return getNoteD2(projectId, noteId)
  }

  if (source === null) return null

  const targetOptions = catalog.items.filter(
    (item) => item.note_id !== currentNote?.note_id && item.access_state !== 'restricted',
  )
  const errorKey = selectionError
  const targetErrorKey =
    targetError === null
      ? null
      : targetError === 'editor_not_saved'
        ? 'research.notes.excerpt.errors.editorNotSaved'
        : noteErrorLabelKey(targetError)

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      data-testid="excerpt-insert-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={t('research.notes.excerpt.title')}
    >
      <div className="my-4 w-full max-w-3xl space-y-4 rounded-lg border bg-background p-4 shadow-lg">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t('research.notes.excerpt.title')}</h3>
            <p className="truncate text-xs text-muted-foreground" data-testid="excerpt-source-label">
              {t(sourceKindLabelKey(source.sourceKind))} · {source.title}
              {source.sourceVersion !== null ? ` · ${source.sourceVersion}` : ''}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
            data-testid="excerpt-cancel"
          >
            {t('common.cancel')}
          </Button>
        </div>

        {/* 1. 原始 Markdown 确认层 */}
        <section className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t('research.notes.excerpt.stepSource')}
          </p>
          <Textarea
            readOnly
            value={source.text}
            rows={8}
            className="font-mono text-xs"
            data-testid="excerpt-source-text"
            aria-label={t('research.notes.excerpt.sourceAria')}
            onSelect={(event) => {
              const target = event.currentTarget
              setSelection({ start: target.selectionStart ?? 0, end: target.selectionEnd ?? 0 })
            }}
          />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span data-testid="excerpt-selection-range">
              {t('research.notes.excerpt.selectionRange', {
                start: selection.start,
                end: selection.end,
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelection({ start: 0, end: source.text.length })}
              data-testid="excerpt-select-all"
            >
              {t('research.notes.excerpt.selectAll')}
            </Button>
            <span className="text-muted-foreground">
              {t('research.notes.excerpt.utf16Hint')}
            </span>
          </div>
          {errorKey !== null && (
            <p className="text-xs text-destructive" role="alert" data-testid="excerpt-selection-error">
              {t(errorKey)}
            </p>
          )}
          <div className="rounded border bg-muted/40 p-2 text-xs" data-testid="excerpt-preview">
            <p className="mb-1 font-medium">{t('research.notes.excerpt.preview')}</p>
            <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
              {excerptPreview.length > 0 ? excerptPreview : '—'}
            </p>
          </div>
        </section>

        {/* 2. 目标选择 */}
        <section className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t('research.notes.excerpt.stepTarget')}
          </p>
          <div className="space-y-1">
            {currentNote !== null && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="excerpt-target"
                  checked={targetKind === 'current'}
                  onChange={() => handleTargetKindChange('current')}
                  data-testid="excerpt-target-current"
                />
                <span className="min-w-0">
                  {t('research.notes.excerpt.target.current', {
                    title: currentNote.title,
                    revision: currentNote.revision ?? '-',
                  })}
                </span>
              </label>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="excerpt-target"
                checked={targetKind === 'new'}
                onChange={() => handleTargetKindChange('new')}
                data-testid="excerpt-target-new"
              />
              <span>{t('research.notes.excerpt.target.new')}</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="excerpt-target"
                checked={targetKind === 'existing'}
                onChange={() => handleTargetKindChange('existing')}
                data-testid="excerpt-target-existing"
              />
              <span>{t('research.notes.excerpt.target.existing')}</span>
            </label>
          </div>

          {targetKind === 'new' && (
            <div className="space-y-1">
              <Label htmlFor="excerpt-new-title">{t('research.notes.titleLabel')}</Label>
              <Input
                id="excerpt-new-title"
                data-testid="excerpt-new-title"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder={t('research.notes.excerpt.newTitlePlaceholder')}
              />
            </div>
          )}

          {targetKind === 'existing' && (
            <div className="space-y-2">
              {catalog.isLoading && (
                <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
              )}
              <ul className="max-h-40 divide-y overflow-y-auto rounded border text-sm">
                {targetOptions.map((item) => (
                  <li key={item.note_id}>
                    <button
                      type="button"
                      className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-accent/60${
                        chosenNoteId === item.note_id ? ' bg-accent/40' : ''
                      }`}
                      onClick={() => void loadFreshTarget(item.note_id)}
                      data-testid={`excerpt-target-note-${item.note_id}`}
                    >
                      <span className="truncate">{item.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {item.revision !== null
                          ? t('research.notes.editor.revision', { revision: item.revision })
                          : t('research.notes.catalog.legacyBadge')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {loadingTarget && (
                <p className="text-xs text-muted-foreground" data-testid="excerpt-target-loading">
                  {t('common.loading')}
                </p>
              )}
            </div>
          )}

          {/* 目标位置（在目标文档中的光标/选区；默认末尾，可选中文本替换）。 */}
          {(targetKind === 'current' || freshTarget !== null) && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground" data-testid="excerpt-target-label">
                {targetKind === 'current'
                  ? t('research.notes.excerpt.target.appendHint')
                  : t('research.notes.excerpt.target.existingHint')}
              </p>
              <Textarea
                readOnly
                value={targetContent() ?? ''}
                rows={4}
                className="font-mono text-xs"
                data-testid="excerpt-target-text"
                aria-label={t('research.notes.excerpt.target.targetAria')}
                onSelect={(event) => {
                  const target = event.currentTarget
                  setTargetSelection({
                    start: target.selectionStart ?? 0,
                    end: target.selectionEnd ?? 0,
                  })
                }}
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground" data-testid="excerpt-target-summary">
            {t('research.notes.excerpt.target.targetSummary', { target: targetLabel() })}
          </p>
        </section>

        {targetErrorKey !== null && (
          <div className="space-y-2" role="alert" data-testid="excerpt-target-error">
            <p className="text-xs text-destructive">{t(targetErrorKey)}</p>
            {pendingInsert !== null && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (pendingInsert.kind === 'machine') {
                    void (async () => {
                      setBusy(true)
                      await editorRef.current?.actions.confirmPendingMutation()
                      setBusy(false)
                      const latest = editorRef.current
                      if (
                        latest !== null &&
                        latest.state.saveStatus === 'saved' &&
                        latest.state.pendingMutationId === null &&
                        latest.state.note !== null
                      ) {
                        onInserted(latest.state.note.note_id, null)
                        toast({ title: t('research.notes.excerpt.inserted') })
                        onClose()
                      }
                    })()
                    return
                  }
                  const built = buildFragmentSource({
                    sourceKind: source.sourceKind,
                    sourceId: source.sourceId,
                    sourceVersion: source.sourceVersion,
                    text: source.text,
                    selection: {
                      kind: 'range',
                      start_utf16: selection.start,
                      end_utf16: selection.end,
                    },
                  })
                  if (!built.ok) return
                  void sendPending(pendingInsert)
                }}
                data-testid="excerpt-retry-same-mutation"
              >
                {t('research.notes.excerpt.retrySameMutation')}
              </Button>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            disabled={busy}
            data-testid="excerpt-close"
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleInsert()}
            disabled={
              busy ||
              isAdminReadonly ||
              excerptPreview.length === 0 ||
              (targetKind === 'existing' && freshTarget === null) ||
              (targetKind === 'new' && newTitle.trim().length === 0)
            }
            data-testid="excerpt-insert"
          >
            {busy ? t('research.notes.excerpt.inserting') : t('research.notes.excerpt.insert')}
          </Button>
        </div>
      </div>
    </div>
  )
}
