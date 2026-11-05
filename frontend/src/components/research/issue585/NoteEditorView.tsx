'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MarkdownEditor } from '@/components/ui/markdown-editor'
import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
} from '@/lib/research/issue585/types'
import { NoteCapabilityBlocked } from './NoteCapabilityBlocked'
import { NoteConflictDialog } from './NoteConflictDialog'
import { NoteDraftRecoveryBanner } from './NoteDraftRecoveryBanner'
import { NoteLeaveGuardDialog } from './NoteLeaveGuardDialog'
import { NoteSaveStatus } from './NoteSaveStatus'
import { blockReasonLabelKey } from './note-ui-labels'

type ViewMode = 'edit' | 'split' | 'preview'

/**
 * 终态阻断原因：出现这些机器码时编辑器不再展示可编辑表单（保留取回入口），
 * 与 saveStatus 的瞬时态（failed/unknown 可重试）区分。
 */
const TERMINAL_BLOCK_REASONS = new Set<string>([
  'note_not_found',
  'note_access_restricted',
  'note_edit_schema_unsupported',
  'note_dependency_unavailable',
  'note_snapshot_unavailable',
  'note_store_unavailable',
  'capability_unknown',
  'disabled_by_flag',
  'not_ready',
])

const PREVIEW_BY_MODE: Record<ViewMode, 'edit' | 'live' | 'preview'> = {
  edit: 'edit',
  split: 'live',
  preview: 'preview',
}

export interface NoteEditorViewProps {
  /** `useNoteEditor` 返回的只读状态（方案 §4.1）。 */
  state: NoteEditorState
  /** `useNoteEditor` 返回的动作（全部不抛异常）。 */
  actions: NoteEditorActions
  /** 服务端能力投影；null 时 fail-closed（不得退回旧表单）。 */
  capabilities: NoteCapabilities | null
  /** Admin 只读：不提供任何写入入口。 */
  isAdminReadonly?: boolean
  /** 请求关闭编辑器（父层调用 closeEditor；被离开保护阻断时 state 驱动对话框）。 */
  onRequestClose: () => void
  /** 受保护另存成功后的新 note_id（父层刷新目录并切换文档）。 */
  onCopySaved?: (noteId: string) => void
  /** 打开失败（可重试错误）时重试当前 note；父层持有 note_id。 */
  onRetryOpen?: () => void
  /** 能力读取失败/能力不可用时刷新服务端能力投影（fail-closed 恢复路径）。 */
  onRetryCapabilities?: () => void
}

/**
 * Markdown Note 编辑器（Issue #1046 PR4，方案 §4.1—§4.4）。
 *
 * 标题 + Markdown 编辑/预览（复用 `MarkdownEditor`：sanitize + KaTeX，不改
 * 该文件）+ 保存状态 + 撤销 + 草稿恢复横幅 + 手动保存/重试；冲突与离开保护
 * 由 state 驱动对话框。能力/权限/删除阻断时渲染阻断态并保留可取回文本，
 * **绝不**退回无 revision 的旧表单（旧表单只服务 `edit_schema=null` 的旧
 * 未保护 Note，由 NotesPanel 分流）。
 */
export function NoteEditorView({
  state,
  actions,
  capabilities,
  isAdminReadonly = false,
  onRequestClose,
  onCopySaved,
  onRetryOpen,
  onRetryCapabilities,
}: NoteEditorViewProps) {
  const { t } = useTranslation()
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const [leaveCopyState, setLeaveCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const [saveAsCopyBusy, setSaveAsCopyBusy] = useState(false)
  const [saveAsCopyFailed, setSaveAsCopyFailed] = useState(false)
  const [conflictDismissed, setConflictDismissed] = useState(false)
  const [leaveDismissed, setLeaveDismissed] = useState(false)
  const [recoveryDismissed, setRecoveryDismissed] = useState(false)

  // 新冲突出现时重新打开对话框；冲突消失后复位“继续编辑”状态。
  useEffect(() => {
    setConflictDismissed(false)
    setSaveAsCopyFailed(false)
    setCopyState('idle')
  }, [state.conflict])

  // 新的离开阻断出现时重新弹出离开保护（用户“留下”后不反复打扰）。
  useEffect(() => {
    if (state.leaveBlockReason !== null) {
      setLeaveDismissed(false)
      setLeaveCopyState('idle')
    }
  }, [state.leaveBlockReason])

  // 新的草稿恢复发生时重新展示横幅。
  useEffect(() => {
    if (state.restoredFromCache) setRecoveryDismissed(false)
  }, [state.restoredFromCache])

  /**
   * 每次显式关闭都先复位“留在当前文档”的本地忽略状态：否则用户点过一次
   * 离开保护的“留下”后，下一次被阻断的关闭不会重新弹出对话框（静默导航
   * 风险）。冲突对话框用状态条上的“查看冲突”重新打开，同理复位。
   */
  function handleRequestClose() {
    setLeaveDismissed(false)
    onRequestClose()
  }

  const capabilityBlockReason =
    capabilities === null
      ? 'capability_unknown'
      : capabilities.noteEditorExisting.available
        ? null
        : (capabilities.noteEditorExisting.reason ?? 'capability_unknown')

  const terminalBlockReason =
    state.blockReason !== null && TERMINAL_BLOCK_REASONS.has(state.blockReason)
  const isBlocked =
    capabilityBlockReason !== null ||
    state.saveStatus === 'blocked' ||
    state.saveStatus === 'restricted' ||
    terminalBlockReason ||
    (state.status === 'error' && state.note === null)

  const blockedReason =
    state.blockReason ??
    (state.saveStatus === 'restricted' ? 'note_access_restricted' : null) ??
    capabilityBlockReason ??
    state.error?.code ??
    null

  async function handleCopyLocal() {
    setCopyState('copying')
    try {
      await actions.copyLocalContent()
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  async function handleLeaveCopyLocal() {
    setLeaveCopyState('copying')
    try {
      await actions.copyLocalContent()
      setLeaveCopyState('copied')
    } catch {
      setLeaveCopyState('failed')
    }
  }

  async function handleSaveAsCopy() {
    setSaveAsCopyBusy(true)
    setSaveAsCopyFailed(false)
    try {
      const newNoteId = await actions.saveAsCopy()
      if (newNoteId !== null) {
        onCopySaved?.(newNoteId)
      } else {
        setSaveAsCopyFailed(true)
      }
    } catch {
      setSaveAsCopyFailed(true)
    } finally {
      setSaveAsCopyBusy(false)
    }
  }

  if (state.status === 'loading') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="note-editor-loading">
        {t('common.loading')}
      </p>
    )
  }

  if (isBlocked) {
    // 审查 A HIGH-1：阻断态也必须能离开/切换。
    // - 本地有未保存文本 → 关闭前二次确认（确认后 discardLocal + closeEditor，
    //   绝不静默丢弃）；
    // - 能力故障/打开失败（可重试）→ 提供重试入口（刷新能力或重试打开当前 note）；
    // - 受限/删除 → 保留 copy/download 取回入口 + 关闭（无本地文本时直接关）。
    const hasLocalText = state.title.trim().length > 0 || state.content.trim().length > 0
    const capabilityRelatedBlock =
      capabilityBlockReason !== null ||
      state.blockReason === 'capability_unknown' ||
      state.blockReason === 'note_store_unavailable' ||
      state.blockReason === 'not_ready'
    const blockedRetry =
      capabilityRelatedBlock && onRetryCapabilities !== undefined
        ? onRetryCapabilities
        : state.error?.retryable === true && onRetryOpen !== undefined
          ? onRetryOpen
          : undefined
    const handleBlockedClose = () => {
      // 关闭阻断视图 = 显式放弃本地编辑（二次确认由 NoteCapabilityBlocked 负责）。
      actions.discardLocal()
      handleRequestClose()
    }
    return (
      <div className="space-y-3" data-testid="note-editor">
        <NoteCapabilityBlocked
          reason={blockedReason}
          canEditExisting={capabilities?.noteEditorExisting.available === true}
          onRetry={blockedRetry}
          onCopyLocal={
            hasLocalText
              ? () => {
                  void actions.copyLocalContent()
                }
              : undefined
          }
          onDownloadLocalMarkdown={
            hasLocalText ? () => actions.downloadLocalMarkdown() : undefined
          }
          onClose={handleBlockedClose}
          closeNeedsConfirm={hasLocalText}
        />
        {/* 兜底：即使 machine 仍拒绝关闭（例如并发语义未就绪），也给出
            离开保护出口，避免阻断态成为死胡同。 */}
        <NoteLeaveGuardDialog
          open={state.leaveBlockReason !== null && !leaveDismissed}
          reason={state.leaveBlockReason}
          copyState={leaveCopyState}
          onRetrySave={() => void actions.retrySave()}
          onCopyLocal={() => void handleLeaveCopyLocal()}
          onDownloadLocalMarkdown={() => actions.downloadLocalMarkdown()}
          onDiscardAndLeave={() => {
            actions.discardLocal()
            handleRequestClose()
          }}
          onStay={() => setLeaveDismissed(true)}
        />
      </div>
    )
  }

  // 冲突与离开保护同时成立时（例如另存失败）先让用户处理冲突，避免两个
  // 模态框叠加；冲突对话框关闭后再展示离开保护。
  const conflictDialogOpen = state.conflict !== null && !conflictDismissed
  const revision = state.note?.revision ?? null

  return (
    <div className="space-y-3" data-testid="note-editor" data-save-status={state.saveStatus}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">
            {state.title.trim() || t('research.notes.editor.untitled')}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('research.notes.editor.heading')}</span>
            {revision !== null && (
              <span className="text-xs text-muted-foreground" data-testid="note-editor-revision">
                {t('research.notes.editor.revision', { revision })}
              </span>
            )}
            {state.blockReason !== null && (
              <span className="text-xs text-destructive" data-testid="note-editor-block-reason">
                {t(blockReasonLabelKey(state.blockReason))}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.undo()}
            disabled={!state.canUndo}
            data-testid="note-editor-undo"
          >
            {t('research.notes.editor.undo')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void actions.saveNow()}
            disabled={isAdminReadonly || state.saveStatus === 'saving'}
            data-testid="note-editor-save-now"
          >
            {t('research.notes.editor.saveNow')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRequestClose}
            aria-label={t('research.notes.editor.close')}
            data-testid="note-editor-close"
          >
            {t('common.close')}
          </Button>
        </div>
      </div>

      <NoteSaveStatus
        saveStatus={state.saveStatus}
        error={state.error}
        cacheStatus={state.cacheStatus}
        pendingMutationId={state.pendingMutationId}
        onRetry={() => void actions.retrySave()}
        onConfirmPending={() => void actions.confirmPendingMutation()}
        onReviewConflict={() => setConflictDismissed(false)}
      />

      {!recoveryDismissed && (
        <NoteDraftRecoveryBanner
          restoredFromCache={state.restoredFromCache}
          cacheStatus={state.cacheStatus}
          onDismiss={() => setRecoveryDismissed(true)}
        />
      )}

      <div className="space-y-1">
        <Label htmlFor="note-editor-title">{t('research.notes.titleLabel')}</Label>
        <Input
          id="note-editor-title"
          data-testid="note-editor-title"
          value={state.title}
          onChange={(event) => actions.setTitle(event.target.value)}
          onCompositionStart={() => actions.beginComposition()}
          onCompositionEnd={() => actions.endComposition()}
          placeholder={t('research.notes.editor.titlePlaceholder')}
          disabled={isAdminReadonly}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('research.notes.editor.heading')}>
        {(['edit', 'split', 'preview'] as const).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant={viewMode === mode ? 'default' : 'ghost'}
            aria-pressed={viewMode === mode}
            onClick={() => setViewMode(mode)}
            data-testid={
              mode === 'preview'
                ? 'note-editor-preview'
                : `note-editor-view-${mode}`
            }
          >
            {t(
              mode === 'edit'
                ? 'research.notes.editor.viewEdit'
                : mode === 'split'
                  ? 'research.notes.editor.viewSplit'
                  : 'research.notes.editor.viewPreview',
            )}
          </Button>
        ))}
      </div>

      {/* IME composition 事件从内部 textarea 冒泡到这里：期间不提交中间态。 */}
      <div
        className="min-w-0"
        onCompositionStart={() => actions.beginComposition()}
        onCompositionEnd={() => actions.endComposition()}
        data-testid="note-editor-content"
      >
        <MarkdownEditor
          value={state.content}
          onChange={(value) => actions.setContent(value ?? '')}
          preview={PREVIEW_BY_MODE[viewMode]}
          height={320}
          textareaId="note-editor-markdown"
          placeholder={t('research.notes.editor.contentPlaceholder')}
        />
      </div>

      <NoteConflictDialog
        open={conflictDialogOpen}
        conflict={state.conflict}
        localContent={state.content}
        busy={saveAsCopyBusy}
        copyState={copyState}
        saveAsCopyError={saveAsCopyFailed ? 'failed' : null}
        onCopyLocal={() => void handleCopyLocal()}
        onSaveAsCopy={() => void handleSaveAsCopy()}
        onLoadLatest={() => void actions.loadLatest()}
        onKeepEditing={() => setConflictDismissed(true)}
      />

      <NoteLeaveGuardDialog
        open={
          state.leaveBlockReason !== null && !leaveDismissed && !conflictDialogOpen
        }
        reason={state.leaveBlockReason}
        copyState={leaveCopyState}
        onRetrySave={() => void actions.retrySave()}
        onCopyLocal={() => void handleLeaveCopyLocal()}
        onDownloadLocalMarkdown={() => actions.downloadLocalMarkdown()}
        onDiscardAndLeave={() => {
          actions.discardLocal()
          handleRequestClose()
        }}
        onStay={() => setLeaveDismissed(true)}
      />
    </div>
  )
}
