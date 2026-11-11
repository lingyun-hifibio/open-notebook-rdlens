'use client'

/**
 * 目标壳右栏成果目录面板（Issue #1191 W3-G1；UI 规格 v1 §5.6 UI-14）。
 *
 * 只做呈现与入口：目录数据/编辑器/删除/启用/恢复草稿全部来自常驻的
 * `TargetNotesWorkspaceProvider`（右栏关闭不卸载编排层，编辑器 overlay 在右栏
 * 关闭时仍能使用同一删除/启用状态机）。不注入第二套 Scope 编辑面，也不做
 * 旧未保护行的旧表单编辑（旧表单属旧壳过渡；目标壳旧行只提供「启用受保护
 * 编辑」）。
 */

import { ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { ResearchNoteD2 } from '@/lib/research/issue585/types'
import { AdminReadOnlyBanner } from '../AdminReadOnlyBanner'
import { NoteCapabilityBlocked } from '../issue585/NoteCapabilityBlocked'
import { NoteCatalog } from '../issue585/NoteCatalog'
import { NoteRecoveryInbox } from '../issue585/NoteRecoveryInbox'
import { useTargetNotesWorkspace } from './TargetNotesWorkspace'

/**
 * 右栏成果目录：目录 + 新建/打开/删除/启用入口 + 恢复草稿入口。
 *
 * 能力语义以 host 契约为准（`note_editor` 只控制新建/首次启用；
 * `note_editor_existing` 不受开关影响），全部 fail-closed：
 * - Admin 只读：只读横幅，无任何写入口；
 * - 能力读取失败：可重试阻断态，不退回旧表单；
 * - 受限行：只显示「内容受限」占位（NoteCatalog 内处理，不渲染标题正文）。
 */
export function TargetOutcomesPane() {
  const { t } = useTranslation()
  const workspace = useTargetNotesWorkspace()
  const editorState = workspace.editor.state
  const capabilities = workspace.capabilities
  const editorVisible = editorState.note !== null || editorState.status !== 'idle'
  const showRecoveryInbox =
    !workspace.isAdminReadonly &&
    editorState.note === null &&
    (editorState.status === 'idle' || editorState.status === 'error')
  // 目录级能力阻断提示只在编辑器未打开时展示；编辑器打开后由 NoteEditorView
  // 自己渲染阻断态（避免重复的 note-capability-blocked）。
  const showCapabilityAlert =
    !workspace.isAdminReadonly && capabilities.error !== null && !editorVisible
  const empty =
    !workspace.catalog.isLoading &&
    workspace.catalog.error === null

  return (
    <div className="space-y-3 px-5 py-4" data-testid="rdlens-target-outcomes-panel">
      {workspace.isAdminReadonly && <AdminReadOnlyBanner />}

      {showCapabilityAlert && capabilities.error !== null && (
        <>
          <p
            className="text-sm"
            role="alert"
            style={{ color: 'var(--rdlens-warning)' }}
            data-testid="rdlens-target-outcomes-unavailable"
          >
            {t('research.target.rightPane.outcomesUnavailable')}
          </p>
          <NoteCapabilityBlocked
            reason={capabilities.error.code}
            canEditExisting={capabilities.capabilities?.noteEditorExisting.available === true}
            onRetry={workspace.refreshCapabilities}
          />
        </>
      )}

      {/* Issue #1136：服务端保存未完成时显式列出可恢复草稿（右栏关闭时不显示，
          从顶栏成果入口重新打开后可见；编辑器 overlay 关闭后的续写恢复走同一
          入口）。打开失败（status=error）也保留。 */}
      {showRecoveryInbox && (
        <NoteRecoveryInbox
          drafts={workspace.recoverableDrafts}
          restrictedNoteIds={workspace.restrictedNoteIds}
          onOpen={workspace.onOpenRecovery}
          onCopyLocal={workspace.onCopyRecovery}
          onDownloadLocal={workspace.onDownloadRecovery}
        />
      )}

      {/* 空态提示复用既有 outcomesEmpty/outcomesHint 文案（目录自身的空态行
          仍由 NoteCatalog 渲染，保证搜索/新建入口在空目录时可用）。 */}
      {empty && workspace.catalog.items.length === 0 && (
        <div className="space-y-0.5" data-testid="rdlens-target-outcomes-empty">
          <p className="text-sm" style={{ color: 'var(--rdlens-ink-muted)' }}>
            {t('research.target.rightPane.outcomesEmpty')}
          </p>
          <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
            {t('research.target.rightPane.outcomesHint')}
          </p>
        </div>
      )}

      <NoteCatalog
        items={workspace.catalog.items}
        isLoading={workspace.catalog.isLoading}
        error={workspace.catalog.error}
        search={workspace.search}
        onSearchChange={workspace.setSearch}
        canCreate={workspace.canCreate}
        createBlockedReason={workspace.isAdminReadonly ? null : workspace.createBlockedReason}
        createPending={workspace.createPending}
        onCreateBlank={workspace.onCreateBlank}
        canEdit={!workspace.isAdminReadonly}
        activeNoteId={editorState.note?.note_id ?? null}
        onOpenNote={workspace.onOpenNote}
        onExcerptNote={workspace.excerptAvailable ? workspace.onExcerptNote : undefined}
        onRequestDelete={workspace.onRequestDelete}
        canDeleteNote={workspace.canDeleteNote}
        onRefresh={() => void workspace.refreshCatalog()}
        revealId={workspace.revealId}
        legacyActions={(item: ResearchNoteD2) =>
          workspace.canEnableProtected &&
          item.edit_schema === null &&
          item.access_state !== 'restricted' ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t('research.notes.catalog.enableProtected')}
              title={t('research.notes.catalog.enableProtected')}
              onClick={() => workspace.onRequestEnable(item.note_id)}
              data-testid={`note-enable-${item.note_id}`}
            >
              <ShieldCheck aria-hidden="true" />
            </Button>
          ) : null
        }
      />
    </div>
  )
}
