/**
 * NoteWorkspaceProvider（Issue #1047 PR5 / D2-B3）组合根测试。
 *
 * 覆盖：无 provider 时入口 fail-closed（hook 返回 null 由消费方处理）、
 * registerEditor 窄接口、引用点击记录返回点并在关闭时仅按 localSeq 恢复、
 * 摘入对话框打开/插入回调后的 Notes pane 通知与打开请求。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useNoteWorkspaceOptional } from './NoteWorkspaceProvider'
import { NoteWorkspaceProvider } from './NoteWorkspaceProvider'
import type { NoteCitationBinding } from '@/lib/research/issue585/types'

const workspaceMock = vi.hoisted(() => ({
  projectId: 'p1',
  userId: 'u1',
  authGeneration: 0,
  isAdminReadonly: false,
}))
vi.mock('@/lib/embedded/workspace-context', () => ({
  useResearchWorkspace: () => ({ ...workspaceMock }),
}))

const editorHandleMock = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof makeHandle> }))
function makeHandle() {
  const state = {
    status: 'ready',
    note: {
      note_id: 'n1',
      project_id: 'p1',
      title: '文档',
      content: '正文',
      note_type: 'human',
      created_at: null,
      updated_at: null,
      revision: 3,
      snapshot_hash: 'a'.repeat(64),
      edit_schema: 'd2-v1',
      access_state: 'visible',
    },
    title: '文档',
    content: '正文',
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
    localSeq: 7,
    baseRevision: 3,
    inserting: false,
    selectionRequest: null,
  }
  const restoreEditorPosition = vi.fn(() => true)
  const actions = { restoreEditorPosition }
  return { state, actions, restoreEditorPosition }
}

vi.mock('@/lib/research/issue585/use-note-editor', () => ({
  useNoteEditor: () => ({ state: editorHandleMock.current.state, actions: editorHandleMock.current.actions }),
}))
vi.mock('@/lib/research/issue585/use-note-capabilities', () => ({
  useNoteCapabilities: () => ({
    capabilities: {
      noteEditor: { available: true, reason: null },
      noteEditorExisting: { available: true, reason: null },
      markdownExport: { available: false, reason: 'not_ready' },
      writingLocal: { available: false, reason: 'not_ready' },
      writingExternal: { available: false, reason: 'not_ready' },
    },
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

// 阅读器/对话框内部有网络读取；provider 测试用轻量替身只验证编排。
vi.mock('./NoteCitationReader', () => ({
  NoteCitationReader: ({
    request,
    onClose,
  }: {
    request: { binding: NoteCitationBinding } | null
    onClose: () => void
  }) =>
    request === null ? null : (
      <button type="button" data-testid="reader-stub-close" onClick={onClose}>
        {request.binding.binding_id}
      </button>
    ),
}))

vi.mock('./ExcerptInsertDialog', () => ({
  ExcerptInsertDialog: ({
    source,
    onClose,
    onInserted,
  }: {
    source: { title: string } | null
    onClose: () => void
    onInserted: (noteId: string, selection: { start: number; end: number } | null) => void
  }) =>
    source === null ? null : (
      <div data-testid="insert-stub">
        <span>{source.title}</span>
        <button type="button" data-testid="insert-stub-close" onClick={onClose}>
          close
        </button>
        <button
          type="button"
          data-testid="insert-stub-done"
          onClick={() => onInserted('n_new', { start: 2, end: 2 })}
        >
          done
        </button>
      </div>
    ),
}))

function Probe() {
  const workspace = useNoteWorkspaceOptional()
  return (
    <div>
      <button
        type="button"
        data-testid="citation"
        onClick={() =>
          workspace?.openCitation(
            {
              binding_id: 'cb_1',
              source_kind: 'source',
              source_id: 'src_1',
              source_version: 'docv_1',
              locator: null,
              unresolved: false,
            },
            { start: 1, end: 2 },
            33,
          )
        }
      >
        citation
      </button>
      <button
        type="button"
        data-testid="excerpt"
        onClick={() =>
          workspace?.openExcerptInsert({
            sourceKind: 'source',
            sourceId: 'src_1',
            sourceVersion: 'docv_1',
            text: '快照文本',
            title: '来源 A',
            initialSelection: null,
          })
        }
      >
        excerpt
      </button>
      <span data-testid="open-request">{workspace?.pendingOpenNote?.noteId ?? ''}</span>
    </div>
  )
}

beforeEach(() => {
  editorHandleMock.current = makeHandle()
})

describe('NoteWorkspaceProvider', () => {
  it('returns null without a provider (entries fail closed)', () => {
    render(<Probe />)
    fireEvent.click(screen.getByTestId('citation'))
    expect(screen.queryByTestId('reader-stub-close')).toBeNull()
    fireEvent.click(screen.getByTestId('excerpt'))
    expect(screen.queryByTestId('insert-stub')).toBeNull()
  })

  it('opens the citation reader and restores the recorded position only on close', () => {
    const handle = makeHandle()
    editorHandleMock.current = handle
    function ProbeInner() {
      const workspace = useNoteWorkspaceOptional()
      return (
        <button
          type="button"
          data-testid="citation"
          onClick={() =>
            workspace?.openCitation(
              {
                binding_id: 'cb_1',
                source_kind: 'source',
                source_id: 'src_1',
                source_version: 'docv_1',
                locator: null,
                unresolved: false,
              },
              { start: 1, end: 2 },
              33,
            )
          }
        >
          citation
        </button>
      )
    }
    render(
      <NoteWorkspaceProvider>
        <ProbeInner />
      </NoteWorkspaceProvider>,
    )
    fireEvent.click(screen.getByTestId('citation'))
    expect(screen.getByTestId('reader-stub-close')).toHaveTextContent('cb_1')
    expect(handle.restoreEditorPosition).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('reader-stub-close'))
    expect(handle.restoreEditorPosition).toHaveBeenCalledWith({
      noteId: 'n1',
      expectedLocalSeq: 7,
      selection: { start: 1, end: 2 },
      scrollTop: 33,
    })
  })

  it('opens the excerpt dialog, notifies the composition root and requests the target note', () => {
    const onNotesChanged = vi.fn()
    render(
      <NoteWorkspaceProvider onNotesChanged={onNotesChanged}>
        <Probe />
      </NoteWorkspaceProvider>,
    )
    fireEvent.click(screen.getByTestId('excerpt'))
    expect(screen.getByTestId('insert-stub')).toHaveTextContent('来源 A')
    fireEvent.click(screen.getByTestId('insert-stub-done'))
    expect(onNotesChanged).toHaveBeenCalledWith('n_new')
    expect(screen.getByTestId('open-request')).toHaveTextContent('n_new')
  })

  it('drops pending excerpt/citation state when the project identity changes', () => {
    workspaceMock.projectId = 'p1'
    function Trigger() {
      const workspace = useNoteWorkspaceOptional()
      return (
        <button
          type="button"
          data-testid="open-excerpt"
          onClick={() =>
            workspace?.openExcerptInsert({
              sourceKind: 'source',
              sourceId: 's1',
              sourceVersion: 'v1',
              text: 'raw',
              title: '来源',
              initialSelection: { start: 0, end: 3 },
            })
          }
        >
          open
        </button>
      )
    }
    const { rerender } = render(
      <NoteWorkspaceProvider>
        <Trigger />
      </NoteWorkspaceProvider>,
    )
    fireEvent.click(screen.getByTestId('open-excerpt'))
    expect(screen.getByTestId('insert-stub')).toBeInTheDocument()
    workspaceMock.projectId = 'p2'
    rerender(
      <NoteWorkspaceProvider>
        <Trigger />
      </NoteWorkspaceProvider>,
    )
    expect(screen.queryByTestId('insert-stub')).not.toBeInTheDocument()
  })
})
