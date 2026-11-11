'use client'

/**
 * Issue #1048 PR7（D2-B4）：本地写作入口对话框（方案 §6.1—§6.5）。
 *
 * 流程：
 * 1. 输入选择确认：全文/选区 + 显式 history_mode（none/current）+ 容量说明
 *    （超限 422 时可见说明，不静默截断或改选全文）；
 * 2. 会话：当前会话或新建会话（创建/打开只显示，不自动发送；新建会话客户端
 *    预生成并持久保存 session_id，失败同 id 重试）；
 * 3. 提交：composer 身份桥接（保存 ACK 后取 editor_revision/intent/hash）→
 *    writing_intent_hash（独立对象）→ POST .../writing（两步传输）；
 * 4. 结果与实际输入回看：writing-contexts 投影 + writing_checks 缺失引用
 *    提示；生成结果**手工**摘入 Note（复用 #1047 摘入确认层，不自动写回）。
 *
 * 能力门控：`writing_local.available=false`（默认关闭）时入口不渲染；Admin
 * 只读不渲染；能力读取失败按不可用处理（fail-closed）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { useResearchEditor } from '@/lib/hooks/use-research-editor'
import {
  selectedWritingText,
  writingUtf8Bytes,
} from '@/lib/research/issue585/writing-intent'
import { locateWritingResultMessage } from '@/lib/research/issue585/writing-client'
import { saveWritingComposer } from '@/lib/research/issue585/writing-composer'
import { useWritingCompose } from '@/lib/research/issue585/use-writing-compose'
import type {
  WritingHistoryMode,
  WritingSelection,
} from '@/lib/research/issue585/writing-types'
import { useWritingLaunchOptional } from '@/lib/research/issue585/writing-launch'
import {
  composeErrorLabelKey,
  composeStageLabelKey,
  writingApiErrorLabelKey,
} from '@/lib/research/issue585/writing-ui-labels'
import { useNoteWorkspaceOptional } from './NoteWorkspaceProvider'
import { WritingContextPanel } from './WritingContextPanel'

/** 对话框打开时捕获的 Note 快照（发送前不再静默改读当前正文）。 */
export interface WritingDialogNoteSnapshot {
  readonly noteId: string
  readonly title: string
  readonly revision: number
  readonly snapshotHash: string
  readonly content: string
  /** 打开时捕获的 d2-v1 access_state（用于缓存授权；恢复前还会服务端重查）。 */
  readonly accessState: 'visible' | 'restricted' | 'unknown'
}

export interface WritingComposeDialogProps {
  open: boolean
  onClose: () => void
  /** 打开时已 flush 并捕获的 Note 快照（revision > 0 的 d2-v1 文档）。 */
  note: WritingDialogNoteSnapshot | null
  /** 入口捕获的选区（全文或 UTF-16 区间）。 */
  initialSelection: WritingSelection
  /** 服务端能力 `writing_local.available`；false 时整体不渲染。 */
  writingAvailable: boolean
  isAdminReadonly?: boolean
}

const SEND_DISABLED_STAGES = new Set([
  'preparing_session',
  'preparing_composer',
  'submitting',
  'streaming',
  'fetching_context',
])

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function WritingComposeDialog({
  open,
  onClose,
  note,
  initialSelection,
  writingAvailable,
  isAdminReadonly = false,
}: WritingComposeDialogProps) {
  const { t, language } = useTranslation()
  const workspace = useResearchWorkspace()
  const launch = useWritingLaunchOptional()
  const noteWorkspace = useNoteWorkspaceOptional()
  const model = useResearchGlobalModel()
  const [insertError, setInsertError] = useState<string | null>(null)
  const [insertBusy, setInsertBusy] = useState(false)
  const [resultMessageId, setResultMessageId] = useState<string | null>(null)
  const [showSelectedText, setShowSelectedText] = useState(false)
  const dialogNote = useMemo(() => {
    if (note === null) return null
    return {
      noteId: note.noteId,
      revision: note.revision,
      snapshotHash: note.snapshotHash,
      content: note.content,
    }
  }, [note])

  const compose = useWritingCompose({
    projectId: workspace.projectId,
    viewerUserId: workspace.userId ?? null,
    authGeneration: workspace.authGeneration ?? 0,
    language,
    modelId: model.confirmedModelId,
    currentRef: launch?.currentRef ?? null,
    sourceId: launch?.sourceId ?? null,
    currentNote: dialogNote,
    notePermission:
      note === null
        ? 'unknown'
        : note.accessState === 'restricted'
          ? 'restricted'
          : note.accessState === 'unknown'
            ? 'unknown'
            : 'visible',
    initialSelection,
    openSession: launch?.openSession,
  })

  const targetRef = compose.targetRef
  const editor = useResearchEditor({
    kind: targetRef?.kind ?? 'global',
    sessionId: targetRef?.sessionId ?? '',
    sourceId: targetRef?.kind === 'source' ? (targetRef.sourceId ?? null) : null,
    enabled: open && targetRef !== null,
  })
  const editorRef = useRef(editor)
  editorRef.current = editor

  // 关闭时重置编排态（不丢弃缓存中的未发送选择；下次打开会重新检查）。
  // 只在 open true→false 的边沿执行，避免每次 render 都 setState 形成循环。
  const previousOpenRef = useRef(open)
  const composeRef = useRef(compose)
  composeRef.current = compose
  useEffect(() => {
    if (previousOpenRef.current !== open) {
      previousOpenRef.current = open
      setInsertError(null)
      setInsertBusy(false)
      setResultMessageId(null)
      if (!open) composeRef.current.reset()
    }
  }, [open])

  const writingBlockedReason = !writingAvailable
    ? 'research.notes.writing.entry.disabled'
    : isAdminReadonly
      ? 'research.notes.writing.entry.adminReadonly'
      : null

  const selectedText =
    note === null ? '' : selectedWritingText(note.content, compose.selection)
  const queryBytes = writingUtf8Bytes(compose.query)
  const sendDisabled =
    note === null ||
    writingBlockedReason !== null ||
    SEND_DISABLED_STAGES.has(compose.submission.stage) ||
    compose.targetRef === null ||
    model.confirmedModelId === null ||
    compose.query.trim().length === 0 ||
    compose.capacity.overLimit ||
    // 已提交未结算（恢复 unknown，或本次提交为可重试的传输/结果未知错误）：
    // 只能走「原身份重试」，避免 composer flush('submit')=skipped 被误显示为
    // composerFailed（review round-3 MEDIUM-4）。
    compose.recovery?.kind === 'unknown' ||
    (compose.submission.stage === 'error' &&
      compose.submission.error?.retryable === true)

  const handleSend = useCallback((): void => {
    setInsertError(null)
    setResultMessageId(null)
    void compose.submit((query) => saveWritingComposer(editorRef.current.controller, query))
  }, [compose])

  /**
   * 关闭路径显式 reset：reset 会把当前输入（含 query）立即落盘，避免
   * 「输入后在 debounce 窗口内关闭」丢掉最新指令（review round-2 MEDIUM-2）。
   * 组件在关闭时由父级卸载，因此必须在 onClose 之前同步执行。
   */
  const handleClose = useCallback((): void => {
    compose.reset()
    onClose()
  }, [compose, onClose])

  const handleRetrySame = useCallback((): void => {
    void compose.retrySameSubmission()
  }, [compose])

  const handleCreateSession = useCallback((): void => {
    void compose.createSession()
  }, [compose])

  const handleInsertExcerpt = useCallback((): void => {
    const answer = compose.submission.answer
    const target = compose.targetRef
    if (answer.length === 0 || target === null) {
      // #1190（W3-G14）：不静默 no-op。结果或目标会话缺失时给出可读原因，
      // 而不是直接 return（原实现点击后无对话框/无请求/无错误提示）。
      setInsertError(t('research.notes.writing.result.insertUnavailable'))
      return
    }
    if (noteWorkspace === null || !noteWorkspace.insertionAvailable) {
      setInsertError(t('research.notes.writing.result.insertUnavailable'))
      return
    }
    setInsertBusy(true)
    setInsertError(null)
    void (async () => {
      let messageId = resultMessageId
      if (messageId === null) {
        // 按 generation_id 精确定位耐久 message_id（不按正文/序号猜）。
        const generationId = compose.submission.generationId
        const located = await locateWritingResultMessage(
          workspace.projectId,
          target,
          generationId,
          answer,
        )
        if (!located.ok) {
          setInsertBusy(false)
          setInsertError(t('research.notes.writing.result.insertUnavailable'))
          return
        }
        messageId = located.messageId
        setResultMessageId(messageId)
      }
      setInsertBusy(false)
      // #1190（W3-G14）：摘入确认层必须让用户看得见。写作对话框与确认层同为
      // z-50，而 Radix Dialog 的 portal 在 DOM 中位于应用根之后，确认层会被
      // 写作对话框盖住（点击「摘入笔记」于是表现为静默 no-op，确认层既不可
      // 见也不可点）。这里按单模态交接：先关闭写作对话框（未发送选择/指令
      // 照常落缓存），再打开 #1047 的摘入确认层。
      handleClose()
      noteWorkspace.openExcerptInsert({
        sourceKind: 'chat_message',
        sourceId: messageId,
        sourceVersion: null,
        text: answer,
        title: note?.title ?? t('research.notes.writing.result.title'),
        initialSelection: null,
      })
    })()
  }, [
    compose.submission.answer,
    compose.submission.generationId,
    compose.targetRef,
    noteWorkspace,
    resultMessageId,
    workspace.projectId,
    note?.title,
    handleClose,
    t,
  ])

  if (writingBlockedReason !== null) return null

  const submission = compose.submission
  const busy = SEND_DISABLED_STAGES.has(submission.stage)
  const currentMissing = launch === null || launch.currentRef === null
  const createdSession = compose.createdSession
  const targetLabel =
    targetRef === null
      ? null
      : targetRef.kind === 'source'
        ? `${targetRef.sessionId} (${targetRef.sourceId ?? ''})`
        : targetRef.sessionId
  const terminalLabel =
    submission.terminal === 'error'
      ? t(writingApiErrorLabelKey(submission.error?.code ?? 'unknown_error'))
      : null

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : handleClose())}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="writing-compose-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('research.notes.writing.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('research.notes.writing.dialog.description')}
          </DialogDescription>
        </DialogHeader>

        {compose.recovery !== null && (
          <div role="status" className="rounded-md border p-2 text-xs" data-testid="writing-recovery">
            <p className="font-medium">
              {compose.recovery.kind === 'unsent'
                ? t('research.notes.writing.recovery.unsent')
                : compose.recovery.kind === 'stale'
                  ? t(
                      compose.recovery.cause === 'session'
                        ? 'research.notes.writing.recovery.sessionChanged'
                        : 'research.notes.writing.recovery.stale',
                    )
                  : compose.recovery.kind === 'restricted'
                    ? t('research.notes.writing.recovery.restricted')
                    : compose.recovery.kind === 'unavailable'
                      ? t('research.notes.writing.recovery.unavailable')
                      : t('research.notes.writing.recovery.unknown')}
            </p>
            {compose.recovery.kind !== 'unsent' && (
              <div className="mt-1 flex flex-wrap gap-2">
                {compose.recovery.submission !== null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleRetrySame}
                    data-testid="writing-recovery-retry"
                  >
                    {t('research.notes.writing.recovery.retry')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => compose.discardRecovery()}
                  data-testid="writing-recovery-discard"
                >
                  {t('research.notes.writing.recovery.discard')}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 1) 输入选择确认（全文/选区 + 容量） */}
        <section className="space-y-2" data-testid="writing-scope-section">
          <h3 className="text-sm font-semibold">{t('research.notes.writing.scope.title')}</h3>
          <p className="text-xs text-muted-foreground" data-testid="writing-scope-note">
            {note !== null
              ? t('research.notes.writing.scope.noteMeta', {
                  noteId: note.noteId,
                  revision: note.revision,
                })
              : ''}
          </p>
          <RadioGroup
            value={compose.selection.kind}
            onValueChange={(value) => {
              if (value === 'full') {
                compose.setSelection({ kind: 'full' })
                return
              }
              if (initialSelection.kind === 'range') {
                compose.setSelection(initialSelection)
              }
            }}
            className="gap-2"
            aria-label={t('research.notes.writing.scope.title')}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="full" id="writing-scope-full" data-testid="writing-scope-full" />
              <Label htmlFor="writing-scope-full">{t('research.notes.writing.scope.full')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value="range"
                id="writing-scope-range"
                data-testid="writing-scope-range"
                disabled={initialSelection.kind !== 'range'}
              />
              <Label htmlFor="writing-scope-range">
                {initialSelection.kind === 'range'
                  ? t('research.notes.writing.scope.range', {
                      start: initialSelection.start_utf16,
                      end: initialSelection.end_utf16,
                    })
                  : t('research.notes.writing.scope.rangeUnavailable')}
              </Label>
            </div>
          </RadioGroup>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowSelectedText((value) => !value)}
            data-testid="writing-scope-preview-toggle"
          >
            {t('research.notes.writing.scope.previewTitle')}
          </Button>
          {showSelectedText && (
            <pre
              className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px]"
              data-testid="writing-scope-preview"
            >
              {truncate(selectedText, 4000)}
            </pre>
          )}
          <p className="text-xs text-muted-foreground" data-testid="writing-capacity">
            {t('research.notes.writing.capacity.value', {
              chars: compose.capacity.selectedTextChars,
              bytes: compose.capacity.selectedTextBytes,
              limit: compose.capacity.envelopeLimitBytes,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('research.notes.writing.capacity.limits', {
              envelopeLimit: Math.floor(compose.capacity.envelopeLimitBytes / 1024),
              queryLimit: Math.floor(compose.capacity.queryLimitBytes / 1024),
              queryBytes,
            })}
          </p>
          {compose.capacity.overLimit && (
            <p className="text-xs text-destructive" role="alert" data-testid="writing-capacity-over">
              {t('research.notes.writing.capacity.overLimit')}
              {compose.capacity.overLimitParts.includes('document_context') && (
                <> {t('research.notes.writing.capacity.overLimitPartDocument')}</>
              )}
              {compose.capacity.overLimitParts.includes('query') && (
                <> {t('research.notes.writing.capacity.overLimitPartQuery')}</>
              )}
            </p>
          )}
        </section>

        {/* 2) 历史范围显式选择 */}
        <section className="space-y-2" data-testid="writing-history-section">
          <h3 className="text-sm font-semibold">{t('research.notes.writing.history.title')}</h3>
          <RadioGroup
            value={compose.historyMode}
            onValueChange={(value) => compose.setHistoryMode(value as WritingHistoryMode)}
            className="gap-2"
            aria-label={t('research.notes.writing.history.title')}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="none" id="writing-history-none" data-testid="writing-history-none" />
              <Label htmlFor="writing-history-none">{t('research.notes.writing.history.none')}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value="current"
                id="writing-history-current"
                data-testid="writing-history-current"
              />
              <Label htmlFor="writing-history-current">
                {t('research.notes.writing.history.current')}
              </Label>
            </div>
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            {compose.historyMode === 'current'
              ? t('research.notes.writing.history.currentHint')
              : t('research.notes.writing.history.noneHint')}
          </p>
        </section>

        {/* 3) 会话：当前 / 新建（创建不自动发送） */}
        <section className="space-y-2" data-testid="writing-session-section">
          <h3 className="text-sm font-semibold">{t('research.notes.writing.session.title')}</h3>
          <RadioGroup
            value={compose.sessionChoiceKind}
            onValueChange={(value) => compose.setSessionChoice(value as 'current' | 'new')}
            className="gap-2"
            aria-label={t('research.notes.writing.session.title')}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value="current"
                id="writing-session-current"
                data-testid="writing-session-current"
                disabled={currentMissing}
              />
              <Label htmlFor="writing-session-current">
                {launch?.currentRef != null
                  ? t('research.notes.writing.session.current', {
                      sessionId: launch.currentRef.sessionId,
                    })
                  : t('research.notes.writing.session.noCurrent')}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem
                value="new"
                id="writing-session-new"
                data-testid="writing-session-new"
              />
              <Label htmlFor="writing-session-new">{t('research.notes.writing.session.new')}</Label>
            </div>
          </RadioGroup>
          {launch?.currentRef != null && (
            <p className="text-xs text-muted-foreground">
              {t('research.notes.writing.session.currentHint')}
            </p>
          )}
          {compose.sessionChoiceKind === 'new' && (
            <div className="space-y-1 text-xs" data-testid="writing-new-session">
              <p className="text-muted-foreground">
                {t(
                  launch?.sourceId !== null && launch?.sourceId !== undefined
                    ? 'research.notes.writing.session.newSourceHint'
                    : 'research.notes.writing.session.newHint',
                )}
              </p>
              {createdSession === null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleCreateSession}
                  data-testid="writing-create-session"
                >
                  {t('research.notes.writing.session.create')}
                </Button>
              ) : (
                <p className="font-mono" data-testid="writing-created-session">
                  {t('research.notes.writing.session.created', { sessionId: createdSession.sessionId })}
                </p>
              )}
            </div>
          )}
          {targetLabel !== null && (
            <p className="text-xs text-muted-foreground" data-testid="writing-target-session">
              {targetLabel}
            </p>
          )}
        </section>

        {/* 4) 写作指令（将作为该会话 composer 草稿保存后再提交） */}
        <section className="space-y-2" data-testid="writing-query-section">
          <Label htmlFor="writing-query">{t('research.notes.writing.query.label')}</Label>
          <Textarea
            id="writing-query"
            data-testid="writing-query"
            value={compose.query}
            onChange={(event) => compose.setQuery(event.target.value)}
            placeholder={t('research.notes.writing.query.placeholder')}
            disabled={busy}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">{t('research.notes.writing.query.hint')}</p>
          {model.confirmedModelId === null && (
            <p className="text-xs text-destructive" role="alert" data-testid="writing-model-missing">
              {t('research.notes.writing.composeErrors.modelMissing')}
            </p>
          )}
        </section>

        {compose.composeError !== null && (
          <div role="alert" className="space-y-1 text-xs text-destructive" data-testid="writing-compose-error">
            <p className="font-medium">{t(composeStageLabelKey(compose.composeError.stage))}</p>
            <p>{t(composeErrorLabelKey(compose.composeError.code))}</p>
            {compose.composeError.apiError !== null && (
              <p className="text-muted-foreground">
                {t(writingApiErrorLabelKey(compose.composeError.apiError.code))}
              </p>
            )}
          </div>
        )}

        {submission.stage !== 'idle' && (
          <section className="space-y-2" data-testid="writing-result-section">
            <h3 className="text-sm font-semibold">{t('research.notes.writing.result.title')}</h3>
            {busy && submission.stage !== 'submitting' && submission.stage !== 'streaming' && (
              <p className="text-xs text-muted-foreground" role="status">
                {submission.stage === 'fetching_context'
                  ? t('research.notes.writing.stage.fetchingContext')
                  : t('research.notes.writing.stage.submitting')}
              </p>
            )}
            {submission.stage === 'submitting' && (
              <p className="text-xs text-muted-foreground" role="status">
                {t('research.notes.writing.stage.submitting')}
              </p>
            )}
            {submission.stage === 'streaming' && (
              <p className="text-xs text-muted-foreground" role="status">
                {t('research.notes.writing.stage.streaming')}
              </p>
            )}
            {submission.thinking.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary>{t('research.notes.writing.result.thinking')}</summary>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">
                  {submission.thinking}
                </pre>
              </details>
            )}
            {submission.answer.length > 0 && (
              <pre
                className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-xs"
                data-testid="writing-result-answer"
              >
                {submission.answer}
              </pre>
            )}
            {submission.stage === 'error' && (
              <div role="alert" className="space-y-1 text-xs text-destructive" data-testid="writing-submit-error">
                <p>
                  {terminalLabel ??
                    t(
                      writingApiErrorLabelKey(
                        submission.error?.code ?? 'unknown_error',
                      ),
                    )}
                </p>
                {submission.terminalErrorCode !== null && (
                  <p className="font-mono text-muted-foreground">
                    {t('research.notes.writing.result.errorTerminal', {
                      code: submission.terminalErrorCode,
                    })}
                  </p>
                )}
                {submission.error?.retryable === true && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleRetrySame}
                    data-testid="writing-retry-same"
                  >
                    {t('research.notes.writing.recovery.retry')}
                  </Button>
                )}
              </div>
            )}
            {(submission.stage === 'cancelled' || submission.detached) && (
              <p className="text-xs text-muted-foreground" role="status" data-testid="writing-detached">
                {t('research.notes.writing.stage.cancelled')} {t('research.notes.writing.cancelledHint')}
              </p>
            )}
            {submission.stage === 'fetching_context' && (
              <WritingContextPanel projection={null} error={null} loading />
            )}
            {(submission.context !== null || submission.contextError !== null) && (
              <WritingContextPanel
                projection={submission.context}
                error={submission.contextError}
                loading={false}
              />
            )}
            {submission.answer.length > 0 && !busy && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleInsertExcerpt}
                  disabled={insertBusy || noteWorkspace === null || !noteWorkspace.insertionAvailable}
                  data-testid="writing-insert-excerpt"
                >
                  {t('research.notes.writing.result.insert')}
                </Button>
                {targetRef !== null && launch !== null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => launch.openSession(targetRef)}
                    data-testid="writing-open-session"
                  >
                    {t('research.notes.writing.result.openSession')}
                  </Button>
                )}
              </div>
            )}
            {insertError !== null && (
              <p className="text-xs text-destructive" role="alert" data-testid="writing-insert-error">
                {insertError}
              </p>
            )}
            {resultMessageId !== null && (
              <p className="text-xs text-muted-foreground" data-testid="writing-result-message-id">
                {resultMessageId}
              </p>
            )}
          </section>
        )}

        {compose.cacheDegraded && (
          <p className="text-xs text-amber-700 dark:text-amber-500" role="status" data-testid="writing-cache-degraded">
            {t('research.notes.writing.cache.degraded')}
          </p>
        )}

        <DialogFooter className="flex-wrap gap-2">
          {busy ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => compose.cancel()}
              data-testid="writing-cancel-read"
            >
              {t('research.notes.writing.cancelRead')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleClose}
              data-testid="writing-close"
            >
              {t('research.notes.writing.close')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSend}
            disabled={sendDisabled}
            data-testid="writing-send"
          >
            {busy ? t('research.notes.writing.sending') : t('research.notes.writing.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
