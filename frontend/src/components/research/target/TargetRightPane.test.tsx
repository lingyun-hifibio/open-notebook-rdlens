/**
 * TargetRightPane（UI-12）增量测试：**outcomes 面板替换**（Issue #1191 W3-G1）。
 *
 * 旧只读 `OutcomesCatalog`（`useResearchNotes` 旧投影 + outcomesReadOnly 文案）
 * 随 W3 目录替换删除；其余四类面板行为不变。完整目录/编辑器行为由
 * `TargetOutcomesPane.test.tsx` 与 `TargetNotesWorkspace.test.tsx` 覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import {
  TargetNotesWorkspaceContext,
  type TargetNotesWorkspaceValue,
} from './TargetNotesWorkspace'
import { TargetRightPane } from './TargetRightPane'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
    language: 'zh-CN',
  }),
}))

vi.mock('@/lib/embedded/workspace-context', () => ({
  useResearchWorkspace: () => ({ projectId: 'proj_1', isAdminReadonly: false }),
}))

vi.mock('@/lib/hooks/use-research', () => ({
  useResearchSources: () => ({ data: { items: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
}))

const noteD2: ResearchNoteD2 = {
  note_id: 'note_1',
  project_id: 'proj_1',
  title: '笔记一',
  content: '正文',
  note_type: 'human',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  revision: 2,
  snapshot_hash: 'a'.repeat(64),
  edit_schema: 'd2-v1',
  access_state: 'visible',
}

function makeState(): NoteEditorState {
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

const capabilities: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function fakeWorkspace(): TargetNotesWorkspaceValue {
  return {
    projectId: 'proj_1',
    isAdminReadonly: false,
    catalog: {
      items: [noteD2],
      isLoading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    },
    capabilities: {
      capabilities,
      isLoading: false,
      error: null,
      refresh: vi.fn(async () => undefined),
    },
    editor: { state: makeState(), actions: makeActions() },
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
  }
}

function renderPane(kind: 'outcomes' | 'tasks') {
  return render(
    <TargetNotesWorkspaceContext.Provider value={fakeWorkspace()}>
      <TargetRightPane
        kind={kind}
        onClose={vi.fn()}
        citationPreview={null}
        sourceId={null}
        sessions={null}
        activeRef={null}
        onOpenSession={vi.fn()}
        onNewSession={vi.fn()}
        onAskThisSource={vi.fn()}
        jobs={[]}
        canPinSingleSource={false}
        readerReady={false}
        onOpenCitationOriginal={vi.fn()}
        onOpenSourceOriginal={vi.fn()}
      />
    </TargetNotesWorkspaceContext.Provider>,
  )
}

afterEach(() => cleanup())

describe('TargetRightPane outcomes 面板替换（#1191 W3-G1）', () => {
  it('outcomes 渲染 W3 目录面板（d2-v1 行），不再渲染旧只读列表/文案', () => {
    renderPane('outcomes')
    expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute(
      'data-pane-kind',
      'outcomes',
    )
    expect(screen.getByTestId('rdlens-target-outcomes-panel')).toBeInTheDocument()
    expect(screen.getByTestId('note-catalog-row-note_1')).toBeInTheDocument()
    expect(screen.queryByTestId('rdlens-target-outcome-item')).toBeNull()
    expect(screen.queryByText('research.target.rightPane.outcomesReadOnly')).toBeNull()
  })

  it('tasks 面板保持既有空态（未被 outcomes 替换影响）', () => {
    renderPane('tasks')
    expect(screen.getByTestId('rdlens-target-tasks-panel')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-pane-empty')).toBeInTheDocument()
  })
})
