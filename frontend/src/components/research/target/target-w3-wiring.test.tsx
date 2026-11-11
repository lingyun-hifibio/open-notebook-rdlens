/**
 * target-w3-wiring（Issue #1191 W3-G1，壳级集成）：**真 provider + mock
 * note-client/listModels**。
 *
 * 覆盖：目标壳 Notes 编排 provider（真 `NoteWorkspaceProvider` +
 * `TargetNotesWorkspaceProvider`）→ 右栏成果目录（d2-v1 行）→ 打开编辑器
 * overlay（真 `TargetEditorFocus`/`NoteEditorView`）→ 关闭 → overlay 消失。
 * 网络边界只 mock `listNotesD2`/`getNoteD2`/`listModels`；不 mock 被测 provider
 * 与目录/编辑器组件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import type { ResearchNoteD2 } from '@/lib/research/issue585/types'
import { NoteWorkspaceProvider } from '../issue585/NoteWorkspaceProvider'
import {
  TargetNotesWorkspaceProvider,
  useTargetNotesWorkspace,
} from './TargetNotesWorkspace'
import { TargetOutcomesPane } from './TargetOutcomesPane'
import { TargetEditorFocus } from './TargetEditorFocus'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
    language: 'zh-CN',
    setLanguage: vi.fn(),
  }),
}))

vi.mock('@/components/ui/markdown-editor', () => ({
  MarkdownEditor: ({ value }: { value?: string }) => (
    <textarea data-testid="markdown-editor" value={value ?? ''} readOnly />
  ),
}))

const noteD2: ResearchNoteD2 = {
  note_id: 'note_1',
  project_id: 'proj_1',
  title: 'W3 受保护笔记',
  content: '正文 A',
  note_type: 'human',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  revision: 3,
  snapshot_hash: 'a'.repeat(64),
  edit_schema: 'd2-v1',
  access_state: 'visible',
}

const clientMock = vi.hoisted(() => ({
  listNotesD2: vi.fn(),
  getNoteD2: vi.fn(),
}))

vi.mock('@/lib/research/issue585/note-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/issue585/note-client')>()
  return {
    ...actual,
    listNotesD2: clientMock.listNotesD2,
    getNoteD2: clientMock.getNoteD2,
    // 状态机通过可注入的 `noteApiClient` 读取（生产默认纯转发），这里替换
    // 对应方法以保持 mock 一致。
    noteApiClient: {
      ...actual.noteApiClient,
      listNotes: clientMock.listNotesD2,
      getNote: clientMock.getNoteD2,
    },
  }
})

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    listModels: vi.fn(async () => ({
      models: [],
      capabilities: {
        note_editor: { available: true, reason: null },
        note_editor_existing: { available: true, reason: null },
        markdown_export: { available: true, reason: null },
        writing_local: { available: true, reason: null },
        writing_external: { available: false, reason: 'not_ready' },
      },
    })),
  }
})

function Harness() {
  const workspace = useTargetNotesWorkspace()
  return (
    <div>
      <TargetOutcomesPane />
      {workspace.editorRequest !== null && (
        <TargetEditorFocus
          state={workspace.editor.state}
          actions={workspace.editor.actions}
          capabilities={workspace.capabilities.capabilities}
          isAdminReadonly={false}
          viewportWidth={1440}
          onRequestClose={() => void workspace.requestCloseEditor()}
          onRetryCapabilities={workspace.refreshCapabilities}
          onRetryOpen={
            workspace.retryOpenNoteId !== null ? workspace.retryOpenEditor : undefined
          }
          onRequestDelete={
            workspace.editorDeleteAvailable ? workspace.onRequestDeleteEditor : undefined
          }
          onCopySaved={workspace.onEditorCopySaved}
        />
      )}
    </div>
  )
}

function renderWiring() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="user_1">
        <NoteWorkspaceProvider>
          <TargetNotesWorkspaceProvider>
            <Harness />
          </TargetNotesWorkspaceProvider>
        </NoteWorkspaceProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  clientMock.listNotesD2.mockResolvedValue({ items: [noteD2], next_cursor: null })
  clientMock.getNoteD2.mockResolvedValue(noteD2)
})

afterEach(() => {
  cleanup()
  clientMock.listNotesD2.mockClear()
  clientMock.getNoteD2.mockClear()
})

describe('target-w3-wiring（真 provider + mock 网络）', () => {
  it('成果目录加载 d2-v1 行；点击打开 → 编辑器 overlay（真 NoteEditorView）→ 返回关闭', async () => {
    renderWiring()
    await waitFor(() =>
      expect(screen.getByTestId('note-catalog-row-note_1')).toBeInTheDocument(),
    )
    expect(screen.getByText('W3 受保护笔记')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('note-open-note_1'))
    await waitFor(() => expect(clientMock.getNoteD2).toHaveBeenCalledWith('proj_1', 'note_1'))
    const overlay = await screen.findByTestId('rdlens-target-editor')
    expect(overlay).toBeInTheDocument()
    expect(screen.getByTestId('note-editor')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-editor-title')).toHaveTextContent('W3 受保护笔记')
    // 既有保护语义载体保留：保存状态/撤销/删除入口由 NoteEditorView 渲染。
    expect(screen.getAllByTestId('note-save-status').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('note-editor-undo')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('rdlens-target-editor-back'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-editor')).toBeNull())
    // overlay 关闭后目录仍在（右栏面板未卸载）。
    expect(screen.getByTestId('rdlens-target-outcomes-panel')).toBeInTheDocument()
  })

  it('provider 统一 openNote：目录请求不再二次打开（仅一次 GET）', async () => {
    renderWiring()
    await waitFor(() =>
      expect(screen.getByTestId('note-open-note_1')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId('note-open-note_1'))
    await screen.findByTestId('rdlens-target-editor')
    expect(clientMock.getNoteD2).toHaveBeenCalledTimes(1)
  })
})
