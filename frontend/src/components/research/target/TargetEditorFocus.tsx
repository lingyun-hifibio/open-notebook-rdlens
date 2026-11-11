'use client'

/**
 * 目标壳宽屏 Markdown 编辑器 overlay（Issue #1191 W3-G1；UI 规格 v1 §5.8 UI-19 /
 * §3.2 / BEH-11；实施计划 §2.1.3）。
 *
 * - 覆盖工作台（`fixed inset-0`，不新增路由、不卸载 shell）：对话/右栏/草稿
 *   保持挂载；工作台 `inert`/`aria-hidden` 由 shell 统一设置；
 * - 返回条 65px（沿用 UI-18 阅读器先例；UI-19 未单独规定）：返回（打开即聚焦）、
 *   文档标题只读展示；右侧动作区由 PR-B 追加单份 Markdown 导出；
 * - 正文列最大 970px（§3.2），内嵌既有 `NoteEditorView`（标题/正文/预览/保存
 *   状态/撤销/删除/摘入/写作入口全部复用既有组件与 slot state/actions）；
 * - aside 固定 330px：保存状态摘要 + 引用列表 + 上下文说明；≥1280 恒显示，
 *   1024–1279 默认折叠为可展开开关，展开时正文让宽、不产生整页横向滚动；
 * - `Esc` 关闭但先让位给嵌套层（Radix 弹层已处理 / 引用阅读打开时）；
 *   Tab 焦点陷阱在存在嵌套模态/引用阅读时暂停；关闭后由 shell 把焦点还给触发
 *   控件（不在此组件内猜父层状态）。
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
} from '@/lib/research/issue585/types'
import { NoteEditorView } from '../issue585/NoteEditorView'
import { NoteSaveStatus } from '../issue585/NoteSaveStatus'
import { useNoteWorkspaceOptional } from '../issue585/NoteWorkspaceProvider'
import {
  TARGET_EDITOR_BACK_BAR_HEIGHT,
  resolveTargetEditorLayout,
} from './target-layout'

/** 标题元素 id（`aria-labelledby` 指向它，不依赖可见文案）。 */
const EDITOR_TITLE_ID = 'rdlens-target-editor-title'
/** aside 面板 id（供折叠开关 `aria-controls` 指向）。 */
const EDITOR_ASIDE_ID = 'rdlens-target-editor-aside-panel'

/** 可聚焦元素选择器（与阅读器/shell 既有 a11y 约定一致）。 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  )
}

export interface TargetEditorFocusProps {
  state: NoteEditorState
  actions: NoteEditorActions
  capabilities: NoteCapabilities | null
  isAdminReadonly: boolean
  /** 视口宽度（shell 传入；1024–1279 aside 折叠判定）。 */
  viewportWidth: number
  /** 请求关闭：shell/provider 调 `closeEditor()`，返回 false 时 overlay 保持。 */
  onRequestClose: () => void
  /** 能力读取失败/不可用时重试。 */
  onRetryCapabilities: () => void
  /** 打开失败时重试当前 note（父层持有 note_id）。 */
  onRetryOpen?: () => void
  /** 删除当前打开的 d2-v1 文档（未提供时不渲染删除入口）。 */
  onRequestDelete?: () => void
  /** 受保护另存成功后的新 note_id（父层刷新目录）。 */
  onCopySaved?: (noteId: string) => void
}

/**
 * UI-19 宽屏编辑器覆盖层。只负责 overlay 形态/a11y/布局与复用既有编辑器组件；
 * 编辑器状态机与打开/关闭语义由 `TargetNotesWorkspaceProvider`/shell 持有。
 */
export function TargetEditorFocus({
  state,
  actions,
  capabilities,
  isAdminReadonly,
  viewportWidth,
  onRequestClose,
  onRetryCapabilities,
  onRetryOpen,
  onRequestDelete,
  onCopySaved,
}: TargetEditorFocusProps) {
  const { t } = useTranslation()
  const noteWorkspace = useNoteWorkspaceOptional()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const backRef = useRef<HTMLButtonElement | null>(null)
  // aside 展开态只属于当前 overlay（不影响工作台/右栏）；换文档时复位。
  const [asideExpanded, setAsideExpanded] = useState(false)
  const noteId = state.note?.note_id ?? null

  useEffect(() => {
    setAsideExpanded(false)
  }, [noteId])

  // UI-19：打开即聚焦返回按钮（关闭后由 shell 恢复焦点到触发控件）。
  useEffect(() => {
    backRef.current?.focus()
  }, [])

  // Esc 关闭；Tab 焦点陷阱。监听在 document 上但不捕获：Radix 弹层已处理过的
  // Esc（defaultPrevented）不再重复关闭；嵌套弹层/引用阅读打开时让位。
  useEffect(() => {
    const hasNestedLayer = (): boolean => {
      if (typeof document === 'undefined') return false
      if (document.querySelector('[data-testid="note-citation-reader"]') !== null) return true
      const openDialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        ),
      )
      const root = dialogRef.current
      // 任何嵌套且打开中的 dialog/alertdialog 都暂停 overlay 的 Tab 焦点陷阱
      // （Radix 模态自身管理焦点；overlay 内打开的离开保护/冲突对话框同样适用）。
      return openDialogs.some((node) => node !== root)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const root = dialogRef.current
      if (root === null) return
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        // 最近的可交互弹层不是 overlay 根 → 让该层处理（离开保护/冲突/引用阅读）。
        const target = event.target
        if (target instanceof Element) {
          const closestDialog = target.closest('[role="dialog"], [role="alertdialog"]')
          if (closestDialog !== null && closestDialog !== root) return
        }
        if (hasNestedLayer()) return
        event.stopPropagation()
        onRequestClose()
        return
      }
      if (event.key !== 'Tab') return
      if (hasNestedLayer()) return
      const focusable = focusableWithin(root)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const inside = active !== null && root.contains(active)
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onRequestClose])

  const layout = resolveTargetEditorLayout({ viewportWidth, asideExpanded })
  const title =
    state.title.trim().length > 0 ? state.title : t('research.target.editor.titleFallback')
  const revision = state.note?.revision ?? null
  const citationBindings = state.note?.citation_bindings ?? []

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={EDITOR_TITLE_ID}
      aria-label={t('research.target.editor.dialogAria')}
      data-testid="rdlens-target-editor"
      data-editor-status={state.status}
      data-save-status={state.saveStatus}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
      style={{
        background: 'var(--rdlens-paper)',
        color: 'var(--rdlens-ink)',
      }}
    >
      <header
        className="flex shrink-0 items-center gap-3 border-b px-4"
        style={{
          height: TARGET_EDITOR_BACK_BAR_HEIGHT,
          borderColor: 'var(--rdlens-line)',
          background: 'var(--rdlens-surface)',
        }}
      >
        <button
          ref={backRef}
          type="button"
          onClick={onRequestClose}
          aria-label={t('research.target.editor.backAria')}
          data-testid="rdlens-target-editor-back"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-[3px]"
          style={{ borderColor: 'var(--rdlens-line-control)', color: 'var(--rdlens-ink)' }}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('research.target.editor.back')}
        </button>

        <div className="min-w-0 flex-1">
          <h2
            id={EDITOR_TITLE_ID}
            className="truncate text-sm font-semibold"
            data-testid="rdlens-target-editor-title"
            title={title}
          >
            {title}
          </h2>
          <p
            className="rdlens-mono truncate text-xs"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-editor-revision"
          >
            {revision === null
              ? t('research.notes.editor.heading')
              : t('research.notes.editor.revision', { revision })}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {layout.asideCollapsible && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="rdlens-target-editor-toggle-aside"
              aria-expanded={layout.asideVisible}
              aria-controls={layout.asideVisible ? EDITOR_ASIDE_ID : undefined}
              aria-label={t('research.target.editor.toggleAsideAria')}
              onClick={() => setAsideExpanded((previous) => !previous)}
            >
              {t('research.target.editor.toggleAside')}
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
          <div
            className="w-full px-6 py-4"
            style={{ maxWidth: layout.bodyColumnWidth }}
            data-testid="rdlens-target-editor-body-column"
          >
            <NoteEditorView
              state={state}
              actions={actions}
              capabilities={capabilities}
              isAdminReadonly={isAdminReadonly}
              onRequestClose={onRequestClose}
              onCopySaved={onCopySaved}
              onRetryOpen={onRetryOpen}
              onRetryCapabilities={onRetryCapabilities}
              onRequestDelete={onRequestDelete}
            />
          </div>
        </div>
        {layout.asideVisible && (
          <div
            id={EDITOR_ASIDE_ID}
            className="shrink-0 space-y-4 overflow-y-auto border-l p-4"
            style={{
              width: layout.asideWidth,
              borderColor: 'var(--rdlens-line)',
            }}
            data-testid="rdlens-target-editor-aside"
          >
            <div>
              <h3 className="text-xs font-medium" style={{ color: 'var(--rdlens-ink-muted)' }}>
                {t('research.target.editor.asideTitle')}
              </h3>
              <p className="mt-1 text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
                {t('research.target.editor.contextNote')}
              </p>
              {noteWorkspace?.writingDraftPending === true && (
                <p
                  className="mt-2 text-xs"
                  role="status"
                  data-testid="rdlens-target-editor-writing-draft-pending"
                >
                  {t('research.notes.writing.entry.draftPending')}
                </p>
              )}
            </div>

            <div data-testid="rdlens-target-editor-save-status">
              <NoteSaveStatus
                saveStatus={state.saveStatus}
                error={state.error}
                cacheStatus={state.cacheStatus}
                pendingMutationId={state.pendingMutationId}
                onRetry={() => void actions.retrySave()}
                onConfirmPending={() => void actions.confirmPendingMutation()}
              />
            </div>

            {citationBindings.length > 0 && (
              <div>
                <p className="text-xs font-medium" style={{ color: 'var(--rdlens-ink-muted)' }}>
                  {t('research.notes.citation.listTitle')}
                </p>
                <ul className="mt-1 space-y-1">
                  {citationBindings.map((binding) => (
                    <li key={binding.binding_id}>
                      <button
                        type="button"
                        className="w-full truncate text-left text-xs underline-offset-2 hover:underline"
                        onClick={() =>
                          noteWorkspace?.openCitation(binding, null, null)
                        }
                        data-testid={`rdlens-target-editor-citation-${binding.binding_id}`}
                        data-source-kind={binding.source_kind}
                      >
                        {binding.source_id}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
