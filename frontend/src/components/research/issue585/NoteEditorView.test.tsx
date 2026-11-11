/**
 * NoteEditorView 组件测试（Issue #1046 PR4，方案 §4.1—§4.4）。
 *
 * 用 props 注入 state/actions（不触网、不依赖 core hooks）覆盖：标题/
 * Markdown 编辑与预览、保存状态、撤销、手动保存/重试、IME composition、
 * 草稿恢复横幅、冲突对话框三选项、离开保护、能力/权限/删除阻断态。
 * MarkdownEditor 用轻量替身（其 sanitize/KaTeX 行为由
 * `components/ui/markdown-editor.test.tsx` 独立覆盖）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NoteEditorView } from './NoteEditorView'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'

const workspaceMock = vi.hoisted(() => ({ current: null as unknown as Record<string, unknown> | null }))
vi.mock('./NoteWorkspaceProvider', () => ({
  useNoteWorkspaceOptional: () => workspaceMock.current,
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
    // 默认 split：左侧原始编辑区（preview=edit）+ 右侧独立装饰预览子树。
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-preview', 'edit')
    expect(screen.getByTestId('note-editor-split-preview')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('note-editor-view-edit'))
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-preview', 'edit')
    expect(screen.queryByTestId('note-editor-split-preview')).toBeNull()
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

  it('权限受限（saveStatus=restricted）渲染阻断态，不展示编辑表单', () => {
    renderEditor({
      saveStatus: 'restricted',
      blockReason: 'note_access_restricted',
      content: '',
    })
    expect(screen.getByTestId('note-capability-blocked')).toHaveAttribute(
      'data-reason',
      'note_access_restricted',
    )
    expect(screen.queryByTestId('markdown-editor')).toBeNull()
    expect(screen.queryByLabelText('research.notes.titleLabel')).toBeNull()
  })

  it('已打开文档被删除（404 终态）渲染阻断态并保留本地文本取回入口', () => {
    const { actions } = renderEditor({
      saveStatus: 'failed',
      blockReason: 'note_not_found',
      content: '删除前本地文本',
    })
    expect(screen.getByTestId('note-capability-reason')).toHaveTextContent(
      'research.notes.editor.errors.note_not_found',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.capability.copyLocal' }),
    )
    expect(actions.copyLocalContent).toHaveBeenCalledTimes(1)
  })

  it('冲突与离开阻断同时成立时先展示冲突对话框（不叠加模态框）', () => {
    renderEditor({
      status: 'ready',
      note,
      saveStatus: 'unknown',
      conflict: { currentRevision: 9, currentSnapshotHash: 'h9' },
      leaveBlockReason: 'unknown',
    })
    expect(screen.getByTestId('note-conflict-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('note-leave-guard-dialog')).toBeNull()

    fireEvent.click(screen.getByTestId('note-conflict-keep-editing'))
    expect(screen.getByTestId('note-leave-guard-dialog')).toBeInTheDocument()
  })

  it('阻断态有本地文本：关闭先二次确认，确认后 discardLocal + 关闭（不静默丢弃）', () => {
    const onRequestClose = vi.fn()
    const { actions } = renderEditor(
      { saveStatus: 'blocked', blockReason: 'note_not_found', content: '本地可取回文本' },
      {},
      { onRequestClose },
    )
    fireEvent.click(screen.getByTestId('note-capability-close'))
    expect(actions.discardLocal).not.toHaveBeenCalled()
    expect(onRequestClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('note-capability-close-confirm-action'))
    expect(actions.discardLocal).toHaveBeenCalledTimes(1)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('阻断态无本地文本：关闭直接可用（阻断态不是死胡同）', () => {
    const onRequestClose = vi.fn()
    const { actions } = renderEditor(
      { saveStatus: 'restricted', blockReason: 'note_access_restricted', title: '', content: '' },
      {},
      { onRequestClose },
    )
    fireEvent.click(screen.getByTestId('note-capability-close'))
    expect(screen.queryByTestId('note-capability-close-confirm')).toBeNull()
    expect(actions.discardLocal).toHaveBeenCalledTimes(1)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('能力故障阻断态提供重试能力入口（fail-closed 可恢复）', () => {
    const onRetryCapabilities = vi.fn()
    renderEditor(
      { status: 'ready' },
      {},
      {
        capabilities: {
          ...readyCapabilities,
          noteEditorExisting: { available: false, reason: 'note_store_unavailable' },
        },
        onRetryCapabilities,
      },
    )
    fireEvent.click(screen.getByTestId('note-capability-retry'))
    expect(onRetryCapabilities).toHaveBeenCalledTimes(1)
  })

  it('打开失败（可重试网络错误）提供重试打开入口', () => {
    const onRetryOpen = vi.fn()
    renderEditor(
      {
        status: 'error',
        note: null,
        saveStatus: 'failed',
        error: { code: 'network_error', message: 'down', retryable: true, status: 0 },
      },
      {},
      { onRetryOpen },
    )
    fireEvent.click(screen.getByTestId('note-capability-retry'))
    expect(onRetryOpen).toHaveBeenCalledTimes(1)
  })

  it('删除（404，不可重试）不提供重试入口，只保留取回与关闭', () => {
    renderEditor(
      {
        status: 'error',
        note: null,
        saveStatus: 'failed',
        blockReason: 'note_not_found',
        error: { code: 'note_not_found', message: 'gone', retryable: false, status: 404 },
      },
      {},
      { onRetryOpen: vi.fn(), onRetryCapabilities: vi.fn() },
    )
    expect(screen.queryByTestId('note-capability-retry')).toBeNull()
    expect(screen.getByTestId('note-capability-close')).toBeInTheDocument()
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


// ── Issue #1047 PR5（D3）：引用 marker / 引用列表 / 摘入入口 / 位置恢复 ──

const citationNote: ResearchNoteD2 = {
  ...note,
  content: '正文[[cite:cb_1]] 结束[[cite:cb_missing]]',
  revision: 4,
  snapshot_hash: 'd'.repeat(64),
  citation_bindings: [
    {
      binding_id: 'cb_1',
      source_kind: 'source',
      source_id: 'src_1',
      source_version: 'docv_1',
      locator: { document_version: 'docv_1', start_utf16: 0, end_utf16: 3 },
      unresolved: false,
    },
  ],
}

afterEach(() => {
  workspaceMock.current = null
})

describe('NoteEditorView citations / excerpt entry (PR5/B3)', () => {
  it('renders citation markers as clickable numbered references and reports unknown markers', () => {
    workspaceMock.current = { openCitation: vi.fn() }
    renderEditor({ note: citationNote, content: citationNote.content })
    expect(screen.getByTestId('note-citation-list')).toBeInTheDocument()
    expect(screen.getByTestId('note-citation-cb_1')).toHaveTextContent('[1]')
    expect(screen.getByTestId('note-citation-unknown')).toBeInTheDocument()
  })

  it('opens the citation reader with the current editor selection and scroll position', () => {
    const openCitation = vi.fn()
    workspaceMock.current = { openCitation }
    renderEditor({ note: citationNote, content: citationNote.content })
    const textarea = screen.getByTestId('markdown-editor') as HTMLTextAreaElement
    textarea.setSelectionRange(1, 3)
    fireEvent.click(screen.getByTestId('note-citation-cb_1'))
    expect(openCitation).toHaveBeenCalledWith(
      expect.objectContaining({ binding_id: 'cb_1', source_id: 'src_1' }),
      { start: 1, end: 3 },
      null,
    )
  })

  it('decorates markers into numbered preview anchors only in preview mode', () => {
    workspaceMock.current = { openCitation: vi.fn() }
    renderEditor({ note: citationNote, content: citationNote.content })
    fireEvent.click(screen.getByTestId('note-editor-preview'))
    expect(screen.getByTestId('markdown-editor')).toHaveValue(
      '正文[1](#cite-cb_1) 结束[[cite:cb_missing]]',
    )
    fireEvent.click(screen.getByTestId('note-editor-view-edit'))
    expect(screen.getByTestId('markdown-editor')).toHaveValue(citationNote.content)
  })

  it('opens the excerpt dialog for the note source with the frozen version', () => {
    const openExcerptInsert = vi.fn()
    workspaceMock.current = { openExcerptInsert, insertionAvailable: true }
    renderEditor({ note: citationNote, content: '正文 A' })
    fireEvent.click(screen.getByTestId('note-editor-excerpt'))
    expect(openExcerptInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'note',
        sourceId: 'note_d2',
        sourceVersion: `4:${'d'.repeat(64)}`,
        text: '正文 A',
        title: '受保护笔记',
      }),
    )
  })

  it('hides the excerpt entry without a workspace provider (fail-safe)', () => {
    workspaceMock.current = null
    renderEditor({ note: citationNote, content: citationNote.content })
    expect(screen.queryByTestId('note-editor-excerpt')).toBeNull()
    expect(screen.queryByTestId('note-citation-list')).not.toBeNull()
  })

  it('renders clickable numbered citations in the default split preview', () => {
    const openCitation = vi.fn()
    workspaceMock.current = { openCitation }
    renderEditor({ note: citationNote, content: citationNote.content })
    const preview = screen.getByTestId('note-editor-split-preview')
    const anchor = preview.querySelector('a[href="#cite-cb_1"]')
    expect(anchor).not.toBeNull()
    expect(anchor?.textContent).toBe('1')
    fireEvent.click(anchor as HTMLElement)
    const openCitationMock = vi.mocked(openCitation)
    expect(openCitationMock.mock.calls[0]?.[0]).toMatchObject({ binding_id: 'cb_1' })
  })

  it('pauses the editor body (inert + readOnly + no-op change) while an insertion is in progress', () => {
    const { actions } = renderEditor({ inserting: true })
    expect(screen.getByTestId('note-editor')).toHaveAttribute('data-inserting', 'true')
    expect(screen.getByTestId('note-editor-inserting')).toBeInTheDocument()
    const content = screen.getByTestId('note-editor-content')
    expect(content.className).toContain('pointer-events-none')
    expect(content).toHaveAttribute('inert')
    expect(content).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('note-editor-title')).toHaveAttribute('readonly')
    fireEvent.change(screen.getByTestId('markdown-editor'), {
      target: { value: '插入中键入的内容' },
    })
    fireEvent.change(screen.getByTestId('note-editor-title'), {
      target: { value: '插入中改标题' },
    })
    expect(actions.setContent).not.toHaveBeenCalled()
    expect(actions.setTitle).not.toHaveBeenCalled()
  })

  // Issue #1134：编辑器工具栏的删除入口（父层判定可见性后以 onRequestDelete 注入）。
  it('renders the delete entry only when onRequestDelete is provided and calls it', () => {
    const onRequestDelete = vi.fn()
    renderEditor({}, {}, { onRequestDelete })
    const entry = screen.getByTestId('note-editor-delete')
    expect(entry).toHaveAttribute('aria-label', 'research.notes.deleteDialog.entry')
    expect(entry).toHaveAttribute('title', 'research.notes.deleteDialog.entry')
    fireEvent.click(entry)
    expect(onRequestDelete).toHaveBeenCalledTimes(1)
  })

  it('hides the delete entry without onRequestDelete (legacy/Admin/能力不可用)', () => {
    renderEditor()
    expect(screen.queryByTestId('note-editor-delete')).toBeNull()
  })

  it('disables the delete entry while saving or while an insertion is in progress', () => {
    renderEditor({ saveStatus: 'saving' }, {}, { onRequestDelete: vi.fn() })
    expect(screen.getByTestId('note-editor-delete')).toBeDisabled()
    cleanup()

    renderEditor({ inserting: true }, {}, { onRequestDelete: vi.fn() })
    expect(screen.getByTestId('note-editor-delete')).toBeDisabled()
  })

  it('does not render the delete entry in terminal blocked states', () => {
    renderEditor(
      { blockReason: 'note_access_restricted', saveStatus: 'restricted' },
      {},
      { onRequestDelete: vi.fn() },
    )
    expect(screen.queryByTestId('note-editor-delete')).toBeNull()
  })

  it('applies a selection-restore request to the editor textarea exactly once', () => {
    const { rerender, state, actions } = renderEditor()
    const textarea = screen.getByTestId('markdown-editor') as HTMLTextAreaElement
    rerender(
      <NoteEditorView
        state={{ ...state, selectionRequest: { selection: { start: 1, end: 3 }, scrollTop: null, seq: 1 } }}
        actions={actions}
        capabilities={readyCapabilities}
        onRequestClose={vi.fn()}
      />,
    )
    expect(textarea.selectionStart).toBe(1)
    expect(textarea.selectionEnd).toBe(3)
  })
})
