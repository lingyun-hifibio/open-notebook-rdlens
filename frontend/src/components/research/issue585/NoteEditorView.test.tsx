/**
 * NoteEditorView 组件测试（Issue #1046 PR4，方案 §4.1—§4.4）。
 *
 * 用 props 注入 state/actions（不触网、不依赖 core hooks）覆盖：标题/
 * Markdown 编辑与预览、保存状态、撤销、手动保存/重试、IME composition、
 * 草稿恢复横幅、冲突对话框三选项、离开保护、能力/权限/删除阻断态。
 * MarkdownEditor 用轻量替身（其 sanitize/KaTeX 行为由
 * `components/ui/markdown-editor.test.tsx` 独立覆盖）。
 */
import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NoteEditorView } from './NoteEditorView'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'

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

const readyCapabilities: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function renderEditor(
  stateOverrides: Partial<NoteEditorState> = {},
  actionOverrides: Partial<NoteEditorActions> = {},
  props: Partial<React.ComponentProps<typeof NoteEditorView>> = {},
) {
  const actions = makeActions(actionOverrides)
  const state = makeState(stateOverrides)
  const utils = render(
    <NoteEditorView
      state={state}
      actions={actions}
      capabilities={readyCapabilities}
      onRequestClose={vi.fn()}
      {...props}
    />,
  )
  return { ...utils, state, actions }
}

describe('NoteEditorView', () => {
  it('渲染标题/Markdown 编辑器/版本号与已保存状态', () => {
    renderEditor()
    expect(screen.getByLabelText('research.notes.titleLabel')).toHaveValue('受保护笔记')
    expect(screen.getByTestId('markdown-editor')).toHaveValue('正文 A')
    expect(screen.getByTestId('note-editor-revision')).toHaveTextContent('4')
    expect(screen.getByTestId('note-save-status-label')).toHaveTextContent(
      'research.notes.editor.saveStatus.saved',
    )
  })

  it('标题与正文输入分别调用 setTitle/setContent', () => {
    const { actions } = renderEditor()
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: '新标题' },
    })
    expect(actions.setTitle).toHaveBeenCalledWith('新标题')
    fireEvent.change(screen.getByTestId('markdown-editor'), {
      target: { value: '新正文' },
    })
    expect(actions.setContent).toHaveBeenCalledWith('新正文')
  })

  it('IME composition 开始/结束通知状态机（期间不提交中间态）', () => {
    const { actions } = renderEditor()
    fireEvent.compositionStart(screen.getByTestId('note-editor-content'))
    fireEvent.compositionEnd(screen.getByTestId('note-editor-content'))
    expect(actions.beginComposition).toHaveBeenCalledTimes(1)
    expect(actions.endComposition).toHaveBeenCalledTimes(1)
  })

  it('撤销按钮按 canUndo 启用并调用 undo', () => {
    const { actions } = renderEditor({ canUndo: false })
    expect(screen.getByTestId('note-editor-undo')).toBeDisabled()
    cleanup()

    const enabled = renderEditor({ canUndo: true })
    fireEvent.click(screen.getByTestId('note-editor-undo'))
    expect(enabled.actions.undo).toHaveBeenCalledTimes(1)
    expect(actions.undo).not.toHaveBeenCalled()
  })

  it('手动保存调用 saveNow；保存中禁用', () => {
    const { actions } = renderEditor({ saveStatus: 'pending' })
    fireEvent.click(screen.getByTestId('note-editor-save-now'))
    expect(actions.saveNow).toHaveBeenCalledTimes(1)
    cleanup()

    renderEditor({ saveStatus: 'saving' })
    expect(screen.getByTestId('note-editor-save-now')).toBeDisabled()
  })

  it('保存失败显示重试并调用 retrySave（含映射后的错误文案）', () => {
    const { actions } = renderEditor({
      saveStatus: 'failed',
      error: { code: 'network_error', message: 'raw', retryable: true, status: 0 },
    })
    expect(screen.getByTestId('note-save-status-error')).toHaveTextContent(
      'research.notes.editor.errors.network_error',
    )
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.editor.retrySave' }))
    expect(actions.retrySave).toHaveBeenCalledTimes(1)
  })

  it('未知结果先确认原 mutation（不提供新写入的假成功）', () => {
    const { actions } = renderEditor({
      saveStatus: 'unknown',
      pendingMutationId: 'mut_1',
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.editor.confirmPending' }),
    )
    expect(actions.confirmPendingMutation).toHaveBeenCalledTimes(1)
  })

  it('三种预览模式切换（edit/split/preview）', () => {
    renderEditor()
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-preview', 'live')
    fireEvent.click(screen.getByTestId('note-editor-view-edit'))
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-preview', 'edit')
    fireEvent.click(screen.getByTestId('note-editor-preview'))
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-preview', 'preview')
  })

  it('冲突状态弹出冲突对话框：复制本地内容 / 受保护另存 / 加载最新版', async () => {
    const onCopySaved = vi.fn()
    const saveAsCopy = vi.fn(async () => 'note_copy')
    const { actions } = renderEditor(
      { saveStatus: 'conflict', conflict: { currentRevision: 9, currentSnapshotHash: 'h9' } },
      { saveAsCopy },
      { onCopySaved },
    )
    expect(screen.getByTestId('note-conflict-dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('note-conflict-copy-local'))
    await waitFor(() => expect(actions.copyLocalContent).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('note-conflict-save-as-copy'))
    await waitFor(() => expect(saveAsCopy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onCopySaved).toHaveBeenCalledWith('note_copy'))

    fireEvent.click(screen.getByTestId('note-conflict-load-latest'))
    fireEvent.click(
      screen.getByRole('button', {
        name: 'research.notes.conflict.loadLatestConfirmAction',
      }),
    )
    expect(actions.loadLatest).toHaveBeenCalledTimes(1)
  })

  it('另存失败不假装成功（不调用 onCopySaved）', async () => {
    const onCopySaved = vi.fn()
    renderEditor(
      { saveStatus: 'conflict', conflict: { currentRevision: 9, currentSnapshotHash: 'h9' } },
      { saveAsCopy: vi.fn(async () => null) },
      { onCopySaved },
    )
    fireEvent.click(screen.getByTestId('note-conflict-save-as-copy'))
    await waitFor(() =>
      expect(screen.getByTestId('note-conflict-save-as-copy-failed')).toBeInTheDocument(),
    )
    expect(onCopySaved).not.toHaveBeenCalled()
  })

  it('离开保护：重试保存/复制/下载/确认放弃（先 discard 再关闭）', async () => {
    const onRequestClose = vi.fn()
    const { actions } = renderEditor(
      { leaveBlockReason: 'unknown', saveStatus: 'unknown' },
      {},
      { onRequestClose },
    )
    expect(screen.getByTestId('note-leave-guard-dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('note-leave-retry'))
    expect(actions.retrySave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('note-leave-download'))
    expect(actions.downloadLocalMarkdown).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('note-leave-discard'))
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.leave.discardConfirmAction' }),
    )
    expect(actions.discardLocal).toHaveBeenCalledTimes(1)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('草稿恢复横幅可忽略；缓存降级提示本地恢复不可用', () => {
    renderEditor({ restoredFromCache: true, cacheStatus: 'memory_only' })
    expect(screen.getByTestId('note-draft-restored')).toBeInTheDocument()
    expect(screen.getByTestId('note-cache-degraded')).toHaveTextContent(
      'research.notes.editor.cache.memoryOnly',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.editor.recovery.dismiss' }),
    )
    expect(screen.queryByTestId('note-draft-restored')).toBeNull()
  })

  it('能力故障（note_editor_existing 不可用）时渲染阻断态，不渲染编辑表单', () => {
    renderEditor(
      { status: 'ready' },
      {},
      {
        capabilities: {
          ...readyCapabilities,
          noteEditorExisting: { available: false, reason: 'note_store_unavailable' },
        },
      },
    )
    expect(screen.getByTestId('note-capability-blocked')).toHaveAttribute(
      'data-reason',
      'note_store_unavailable',
    )
    expect(screen.queryByLabelText('research.notes.titleLabel')).toBeNull()
    expect(screen.queryByTestId('markdown-editor')).toBeNull()
  })

  it('capabilities=null 时 fail-closed 阻断（绝不退回旧表单）', () => {
    renderEditor({}, {}, { capabilities: null })
    expect(screen.getByTestId('note-capability-blocked')).toHaveAttribute(
      'data-reason',
      'capability_unknown',
    )
    expect(screen.queryByLabelText('research.notes.contentLabel')).toBeNull()
  })

  it('删除/权限受限（saveStatus=blocked）显示阻断原因并保留本地取回入口', () => {
    const { actions } = renderEditor({
      saveStatus: 'blocked',
      blockReason: 'note_not_found',
      content: '本地可取回文本',
    })
    expect(screen.getByTestId('note-capability-reason')).toHaveTextContent(
      'research.notes.editor.errors.note_not_found',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.capability.copyLocal' }),
    )
    expect(actions.copyLocalContent).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.capability.downloadMarkdown' }),
    )
    expect(actions.downloadLocalMarkdown).toHaveBeenCalledTimes(1)
  })

  it('关闭按钮调用 onRequestClose（离开保护由 state 驱动）', () => {
    const onRequestClose = vi.fn()
    renderEditor({}, {}, { onRequestClose })
    fireEvent.click(screen.getByTestId('note-editor-close'))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('Admin 只读：标题与保存入口禁用', () => {
    renderEditor({}, {}, { isAdminReadonly: true })
    expect(screen.getByLabelText('research.notes.titleLabel')).toBeDisabled()
    expect(screen.getByTestId('note-editor-save-now')).toBeDisabled()
  })

  it('加载中显示 loading（不渲染编辑表单）', () => {
    renderEditor({ status: 'loading', note: null, title: '', content: '' })
    expect(screen.getByTestId('note-editor-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-editor')).toBeNull()
  })
})
