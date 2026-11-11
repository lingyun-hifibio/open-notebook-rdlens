/**
 * TargetEditorFocus（Issue #1191 W3-G1；UI 规格 v1 §5.8 UI-19）组件测试。
 *
 * 只测 overlay 形态/a11y/布局与既有编辑器组件复用；编辑器状态机与打开/关闭
 * 语义（closeEditor true/false、pendingOpenNote、identity 收敛）由
 * `TargetNotesWorkspace.test.tsx` 与 `TargetShell.test.tsx` 覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import { TargetEditorFocus } from './TargetEditorFocus'

vi.mock('./issue585/NoteWorkspaceProvider', () => ({
  useNoteWorkspaceOptional: () => null,
}))

vi.mock('../issue585/NoteWorkspaceProvider', () => ({
  useNoteWorkspaceOptional: () => null,
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

vi.mock('@/components/ui/markdown-editor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    preview,
  }: {
    value?: string
    onChange?: (value?: string) => void
    preview?: string
  }) => (
    <textarea
      data-testid="markdown-editor"
      data-preview={preview}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}))

const note: ResearchNoteD2 = {
  note_id: 'note_d2',
  project_id: 'proj_1',
  title: '受保护笔记',
  content: '正文 A',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
  revision: 4,
  snapshot_hash: 'hash-4',
  edit_schema: 'd2-v1',
  access_state: 'visible',
}

const readyCapabilities: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function makeState(overrides: Partial<NoteEditorState> = {}): NoteEditorState {
  return {
    status: 'ready',
    note,
    title: '受保护笔记',
    content: '正文 A',
    saveStatus: 'saved',
    conflict: null,
    pendingMutationId: null,
    cacheStatus: 'ok',
    restoredFromCache: false,
    canUndo: false,
    blockReason: null,
    error: null,
    authGeneration: 0,
    leaveBlockReason: null,
    ...overrides,
  }
}

function makeActions(overrides: Partial<NoteEditorActions> = {}): NoteEditorActions {
  return {
    openNote: vi.fn(async () => undefined),
    createBlankNote: vi.fn(async () => null),
    closeEditor: vi.fn(async () => true),
    setTitle: vi.fn(),
    setContent: vi.fn(),
    beginComposition: vi.fn(),
    endComposition: vi.fn(),
    saveNow: vi.fn(async () => undefined),
    retrySave: vi.fn(async () => undefined),
    confirmPendingMutation: vi.fn(async () => undefined),
    undo: vi.fn(),
    copyLocalContent: vi.fn(async () => undefined),
    downloadLocalMarkdown: vi.fn(),
    saveAsCopy: vi.fn(async () => null),
    loadLatest: vi.fn(async () => undefined),
    discardLocal: vi.fn(),
    flushBeforeLeave: vi.fn(async () => null),
    ...overrides,
  }
}

function renderFocus(
  overrides: {
    state?: Partial<NoteEditorState>
    actions?: Partial<NoteEditorActions>
    viewportWidth?: number
    onRequestClose?: () => void
    onRequestDelete?: () => void
  } = {},
) {
  const actions = makeActions(overrides.actions)
  const state = makeState(overrides.state)
  const onRequestClose = overrides.onRequestClose ?? vi.fn()
  const utils = render(
    <TargetEditorFocus
      state={state}
      actions={actions}
      capabilities={readyCapabilities}
      isAdminReadonly={false}
      viewportWidth={overrides.viewportWidth ?? 1440}
      onRequestClose={onRequestClose}
      onRetryCapabilities={vi.fn()}
      onRequestDelete={overrides.onRequestDelete}
    />,
  )
  return { ...utils, state, actions, onRequestClose }
}

afterEach(() => cleanup())

describe('TargetEditorFocus（UI-19）', () => {
  it('渲染 overlay 与既有 note-editor（标题/保存状态/正文），返回按钮打开即聚焦', async () => {
    renderFocus()
    const dialog = screen.getByTestId('rdlens-target-editor')
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByTestId('rdlens-target-editor-title')).toHaveTextContent('受保护笔记')
    expect(screen.getByTestId('rdlens-target-editor-revision')).toHaveTextContent('4')
    expect(screen.getByTestId('note-editor')).toBeInTheDocument()
    expect(screen.getAllByTestId('note-save-status')[0]).toHaveAttribute('data-status', 'saved')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('rdlens-target-editor-back')),
    )
  })

  it('Esc 关闭（调用 onRequestClose）；嵌套 role=dialog 内的 Esc 让位不关闭', async () => {
    const onRequestClose = vi.fn()
    renderFocus({ onRequestClose })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRequestClose).toHaveBeenCalledTimes(1)

    // 嵌套弹层（离开保护）已处理 Esc：defaultPrevented → 不再关闭。
    onRequestClose.mockClear()
    const nested = document.createElement('div')
    nested.setAttribute('role', 'dialog')
    nested.setAttribute('data-state', 'open')
    document.body.appendChild(nested)
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    event.preventDefault()
    document.dispatchEvent(event)
    expect(onRequestClose).not.toHaveBeenCalled()
    nested.remove()
  })

  it('存在嵌套模态（overlay 内打开的 dialog）时暂停 Tab 焦点陷阱', () => {
    renderFocus()
    const overlay = screen.getByTestId('rdlens-target-editor')
    const nested = document.createElement('div')
    nested.setAttribute('role', 'dialog')
    nested.setAttribute('data-state', 'open')
    overlay.appendChild(nested)
    // 焦点置于 overlay 之外（陷阱原本会把焦点拉回 overlay 内）。
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    const notPrevented = document.dispatchEvent(event)
    expect(notPrevented).toBe(true)
    nested.remove()
  })

  it('引用阅读打开时 Esc 不关闭编辑器', () => {
    const onRequestClose = vi.fn()
    renderFocus({ onRequestClose })
    const reader = document.createElement('div')
    reader.setAttribute('data-testid', 'note-citation-reader')
    document.body.appendChild(reader)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onRequestClose).not.toHaveBeenCalled()
    reader.remove()
  })

  it('1440：aside 恒显示 330，正文列 max-width 970', () => {
    renderFocus({ viewportWidth: 1440 })
    expect(screen.getByTestId('rdlens-target-editor-aside')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-editor-body-column')).toHaveStyle({
      maxWidth: '970px',
    })
  })

  it('1024：aside 默认折叠，可展开且展开后正文让宽到 694（不覆盖正文）', () => {
    renderFocus({ viewportWidth: 1024 })
    expect(screen.queryByTestId('rdlens-target-editor-aside')).toBeNull()
    const toggle = screen.getByTestId('rdlens-target-editor-toggle-aside')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('rdlens-target-editor-body-column')).toHaveStyle({
      maxWidth: '970px',
    })
    fireEvent.click(toggle)
    expect(screen.getByTestId('rdlens-target-editor-aside')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-editor-body-column')).toHaveStyle({
      maxWidth: '694px',
    })
    expect(screen.getByTestId('rdlens-target-editor-toggle-aside')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('关闭被离开保护阻断时 overlay 保持并呈现 note-leave-guard-dialog（不丢正文）', () => {
    renderFocus({ state: { leaveBlockReason: 'unsaved' } })
    expect(screen.getByTestId('rdlens-target-editor')).toBeInTheDocument()
    expect(screen.getByTestId('note-leave-guard-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('note-editor')).toBeInTheDocument()
  })

  it('保存失败：failed 状态可见且正文保留（不静默关闭/卸载）', () => {
    renderFocus({
      state: {
        saveStatus: 'failed',
        error: {
          code: 'note_store_unavailable',
          message: 'boom',
          status: 503,
          retryable: true,
        },
      },
    })
    expect(screen.getAllByTestId('note-save-status')[0]).toHaveAttribute('data-status', 'failed')
    expect(screen.getByTestId('markdown-editor')).toHaveValue('正文 A')
  })

  it('删除入口只在父层提供 onRequestDelete 时渲染', () => {
    const first = renderFocus()
    expect(screen.queryByTestId('note-editor-delete')).toBeNull()
    first.unmount()
    renderFocus({ onRequestDelete: vi.fn() })
    expect(screen.getByTestId('note-editor-delete')).toBeInTheDocument()
  })
})
