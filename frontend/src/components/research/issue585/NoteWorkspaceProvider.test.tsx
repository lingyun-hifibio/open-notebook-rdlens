/**
 * NoteWorkspaceProvider（Issue #1047 PR5 / D2-B3）组合根测试。
 *
 * 覆盖：无 provider 时入口 fail-closed（hook 返回 null 由消费方处理）、
 * registerEditor 窄接口、引用点击记录返回点并在关闭时仅按 localSeq 恢复、
 * 摘入对话框打开/插入回调后的 Notes pane 通知与打开请求。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const actions: {
    restoreEditorPosition: ReturnType<typeof vi.fn>
    flushForInsert: () => Promise<
      'conflict' | 'unsaved' | 'failed' | 'unknown' | 'restricted' | null
    >
  } = {
    restoreEditorPosition,
    flushForInsert: vi.fn(async () => null),
  }
  return { state, actions, restoreEditorPosition }
}

vi.mock('@/lib/research/issue585/use-note-editor', () => ({
  useNoteEditor: () => ({ state: editorHandleMock.current.state, actions: editorHandleMock.current.actions }),
}))
const capabilitiesMock = vi.hoisted(() => ({ writingLocalAvailable: false }))
vi.mock('@/lib/research/issue585/use-note-capabilities', () => ({
  useNoteCapabilities: () => ({
    capabilities: {
      noteEditor: { available: true, reason: null },
      noteEditorExisting: { available: true, reason: null },
      markdownExport: { available: false, reason: 'not_ready' },
      writingLocal: {
        available: capabilitiesMock.writingLocalAvailable,
        reason: capabilitiesMock.writingLocalAvailable ? null : 'not_ready',
      },
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

vi.mock('./WritingComposeDialog', () => ({
  WritingComposeDialog: ({
    open,
    note,
    initialSelection,
  }: {
    open: boolean
    note: { noteId: string; revision: number } | null
    initialSelection: { kind: string }
  }) =>
    open && note !== null ? (
      <div data-testid="writing-dialog-stub">
        {note.noteId}:{note.revision}:{initialSelection.kind}
      </div>
    ) : null,
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
  capabilitiesMock.writingLocalAvailable = false
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


describe('写作入口 flush 编排（review round-2 HIGH-3）', () => {
  function WritingProbe() {
    const workspace = useNoteWorkspaceOptional()
    return (
      <div>
        <button
          type="button"
          data-testid="open-writing"
          onClick={() => void workspace?.openWriting({ kind: 'full' })}
        >
          open
        </button>
        <span data-testid="writing-block">{workspace?.writingBlockReason ?? ''}</span>
      </div>
    )
  }

  it('dirty Note 慢 flush：保存完成后首击仍会打开对话框（不静默）', async () => {
    capabilitiesMock.writingLocalAvailable = true
    const handle = makeHandle()
    handle.state.saveStatus = 'dirty'
    let resolveFlush: (
      value: 'conflict' | 'unsaved' | 'failed' | 'unknown' | 'restricted' | null,
    ) => void = () => {}
    let flushCalls = 0
    handle.actions.flushForInsert = () => {
      flushCalls += 1
      return new Promise<'conflict' | 'unsaved' | 'failed' | 'unknown' | 'restricted' | null>(
        (resolve) => {
          resolveFlush = resolve
        },
      )
    }
    editorHandleMock.current = handle
    render(
      <NoteWorkspaceProvider>
        <WritingProbe />
      </NoteWorkspaceProvider>,
    )
    fireEvent.click(screen.getByTestId('open-writing'))
    // flush 在途：尚未打开，但也不是静默结束（处于等待）。
    expect(screen.queryByTestId('writing-dialog-stub')).toBeNull()

    // 保存完成（dirty → saved）后 flush 成功返回：effect 应重新评估并打开。
    await act(async () => {
      handle.state.saveStatus = 'saved'
      resolveFlush(null)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('writing-dialog-stub')).toHaveTextContent('n1:3:full'),
    )
    expect(flushCalls).toBe(1)
  })

  it('flush 被阻断（conflict）→ 不打开对话框，显示可见 block reason', async () => {
    capabilitiesMock.writingLocalAvailable = true
    const handle = makeHandle()
    handle.state.saveStatus = 'dirty'
    handle.actions.flushForInsert = async () => 'conflict'
    editorHandleMock.current = handle
    render(
      <NoteWorkspaceProvider>
        <WritingProbe />
      </NoteWorkspaceProvider>,
    )
    fireEvent.click(screen.getByTestId('open-writing'))
    await waitFor(() => expect(screen.getByTestId('writing-block')).toHaveTextContent('conflict'))
    expect(screen.queryByTestId('writing-dialog-stub')).toBeNull()
  })

  it('缺少 flush 能力 → unsaved block reason（不静默）', async () => {
    capabilitiesMock.writingLocalAvailable = true
    const handle = makeHandle()
    const partialHandle = { state: handle.state, actions: { restoreEditorPosition: handle.restoreEditorPosition } }
    editorHandleMock.current = partialHandle as unknown as typeof handle
    render(
      <NoteWorkspaceProvider>
        <WritingProbe />
      </NoteWorkspaceProvider>,
    )
    fireEvent.click(screen.getByTestId('open-writing'))
    await waitFor(() => expect(screen.getByTestId('writing-block')).toHaveTextContent('unsaved'))
    expect(screen.queryByTestId('writing-dialog-stub')).toBeNull()
  })
})
