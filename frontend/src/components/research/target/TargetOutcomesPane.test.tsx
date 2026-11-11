/**
 * TargetOutcomesPane（Issue #1191 W3-G1；UI 规格 v1 §5.6 UI-14）组件测试。
 *
 * 右栏面板只渲染目录与入口；目录/能力/删除/启用/恢复草稿来自常驻
 * `TargetNotesWorkspaceProvider`。本测试注入 fake context value（不触网），
 * 覆盖：目录/新建/打开、Admin 只读、能力阻断、空态复用、受限行脱敏、
 * 旧未保护行的「启用受保护编辑」入口与恢复草稿入口。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type {
  NoteCapabilities,
  NoteCapabilitiesResult,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import {
  TargetNotesWorkspaceContext,
  type TargetNotesWorkspaceValue,
} from './TargetNotesWorkspace'
import { TargetOutcomesPane } from './TargetOutcomesPane'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

const capabilities: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

const noteD2: ResearchNoteD2 = {
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

const legacyNote: ResearchNoteD2 = {
  ...noteD2,
  note_id: 'note_legacy',
  title: '旧未保护笔记',
  edit_schema: null,
  revision: null,
  snapshot_hash: null,
}

const restrictedNote: ResearchNoteD2 = {
  ...noteD2,
  note_id: 'note_restricted',
  title: '受限标题不得展示',
  access_state: 'restricted',
}

function makeState(overrides: Partial<NoteEditorState> = {}): NoteEditorState {
  return {
    status: 'idle',
    note: null,
    title: '',
    content: '',
    saveStatus: 'idle',
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

function makeActions(): NoteEditorActions {
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
  }
}

type MutableWorkspace = {
  -readonly [K in keyof TargetNotesWorkspaceValue]: TargetNotesWorkspaceValue[K]
}

function fakeWorkspace(
  overrides: Partial<TargetNotesWorkspaceValue> = {},
): MutableWorkspace {
  const capabilitiesResult: NoteCapabilitiesResult = {
    capabilities,
    isLoading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  }
  const actions = makeActions()
  return {
    projectId: 'proj_1',
    isAdminReadonly: false,
    catalog: {
      items: [noteD2],
      isLoading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    },
    capabilities: capabilitiesResult,
    editor: { state: makeState(), actions },
    search: '',
    setSearch: vi.fn(),
    revealId: null,
    revealNoteInCatalog: vi.fn(),
    canCreate: true,
    createBlockedReason: null,
    createPending: false,
    onCreateBlank: vi.fn(),
    onOpenNote: vi.fn(),
    excerptAvailable: true,
    onExcerptNote: vi.fn(),
    canDeleteNote: () => true,
    onRequestDelete: vi.fn(),
    editorDeleteAvailable: false,
    onRequestDeleteEditor: vi.fn(),
    canEnableProtected: true,
    onRequestEnable: vi.fn(),
    recoverableDrafts: [],
    restrictedNoteIds: new Set<string>(),
    onOpenRecovery: vi.fn(),
    onCopyRecovery: vi.fn(),
    onDownloadRecovery: vi.fn(),
    editorRequest: null,
    openEditor: vi.fn(),
    requestCloseEditor: vi.fn(async () => true),
    takeEditorTrigger: vi.fn(() => null),
    retryOpenNoteId: null,
    retryOpenEditor: vi.fn(),
    refreshCatalog: vi.fn(async () => undefined),
    refreshCapabilities: vi.fn(),
    onEditorCopySaved: vi.fn(),
    ...overrides,
  }
}

function renderPane(value: TargetNotesWorkspaceValue) {
  return render(
    <TargetNotesWorkspaceContext.Provider value={value}>
      <TargetOutcomesPane />
    </TargetNotesWorkspaceContext.Provider>,
  )
}

afterEach(() => cleanup())

describe('TargetOutcomesPane（UI-14）', () => {
  it('渲染 d2-v1 目录行；新建/打开走 context 动作（搜索词由 provider 持有）', () => {
    const workspace = fakeWorkspace()
    renderPane(workspace)
    expect(screen.getByTestId('rdlens-target-outcomes-panel')).toBeInTheDocument()
    expect(screen.getByTestId('note-catalog')).toBeInTheDocument()
    expect(screen.getByTestId('note-catalog-new')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('note-catalog-new'))
    expect(workspace.onCreateBlank).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('note-open-note_d2'))
    expect(workspace.onOpenNote).toHaveBeenCalledWith('note_d2')
    // 目录搜索由 provider 持有：输入直接回调 setSearch。
    fireEvent.change(screen.getByTestId('note-catalog-search'), {
      target: { value: 'abc' },
    })
    expect(workspace.setSearch).toHaveBeenCalledWith('abc')
  })

  it('Admin 只读：显示横幅、无搜索/新建/编辑入口', () => {
    renderPane(fakeWorkspace({ isAdminReadonly: true, canCreate: false }))
    expect(screen.getByTestId('admin-readonly-banner')).toBeInTheDocument()
    expect(screen.queryByTestId('note-catalog-search')).toBeNull()
    expect(screen.queryByTestId('note-catalog-new')).toBeNull()
    // d2 行在只读时不是可点击打开按钮（仍可见标题）。
    expect(screen.queryByTestId('note-open-note_d2')).toBeNull()
    expect(screen.getByText('受保护笔记')).toBeInTheDocument()
  })

  it('能力读取失败：呈现 outcomesUnavailable + 可重试阻断态', () => {
    const workspace = fakeWorkspace()
    workspace.capabilities = {
      capabilities: null,
      isLoading: false,
      error: { code: 'note_store_unavailable', message: 'x', status: 503, retryable: true },
      refresh: vi.fn(async () => undefined),
    }
    renderPane(workspace)
    expect(screen.getByTestId('rdlens-target-outcomes-unavailable')).toHaveTextContent(
      'research.target.rightPane.outcomesUnavailable',
    )
    expect(screen.getByTestId('note-capability-blocked')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('note-capability-retry'))
    expect(workspace.refreshCapabilities).toHaveBeenCalledTimes(1)
  })

  it('空目录：复用 outcomesEmpty/outcomesHint 文案', () => {
    const workspace = fakeWorkspace()
    workspace.catalog = { ...workspace.catalog, items: [] }
    renderPane(workspace)
    const empty = screen.getByTestId('rdlens-target-outcomes-empty')
    expect(empty).toHaveTextContent('research.target.rightPane.outcomesEmpty')
    expect(empty).toHaveTextContent('research.target.rightPane.outcomesHint')
  })

  it('旧未保护行只提供「启用受保护编辑」入口（无旧表单编辑入口）', () => {
    const workspace = fakeWorkspace()
    workspace.catalog = { ...workspace.catalog, items: [legacyNote] }
    renderPane(workspace)
    const enable = screen.getByTestId('note-enable-note_legacy')
    fireEvent.click(enable)
    expect(workspace.onRequestEnable).toHaveBeenCalledWith('note_legacy')
    expect(screen.queryByRole('button', { name: 'research.notes.edit' })).toBeNull()
  })

  it('受限行不渲染标题正文（只显示受限占位）', () => {
    const workspace = fakeWorkspace()
    workspace.catalog = { ...workspace.catalog, items: [restrictedNote] }
    renderPane(workspace)
    expect(screen.queryByText('受限标题不得展示')).toBeNull()
    expect(screen.getByTestId('note-catalog-restricted-note_restricted')).toHaveTextContent(
      'research.notes.catalog.restricted',
    )
  })

  it('可恢复草稿入口在编辑器 idle 时展示并可打开', () => {
    const workspace = fakeWorkspace({
      recoverableDrafts: [
        { noteId: 'note_d2', title: '草稿标题', savedAt: '2026-11-11T00:00:00Z' },
      ],
    })
    renderPane(workspace)
    fireEvent.click(screen.getByTestId('note-recovery-open-note_d2'))
    expect(workspace.onOpenRecovery).toHaveBeenCalledWith('note_d2')
  })
})
