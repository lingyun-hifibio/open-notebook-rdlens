/**
 * 删除 Note hook 单测（Issue #1134）。
 *
 * 覆盖：冻结签名接线（state/actions）、actions 引用稳定、capabilities 变化
 * 同步、projectId/身份变化重置状态机、StrictMode 双挂载不销毁状态机、
 * 卸载安全（在途请求结束后不抛异常）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { noteApiClient } from './note-client'
import { useNoteDelete, type UseNoteDeleteOptions } from './use-note-delete'
import type { NoteCapabilities, NoteReceipt } from './types'

vi.mock('./note-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('./note-client')>()
  const mockClient = {
    listNotes: vi.fn(),
    getNote: vi.fn(),
    createNote: vi.fn(),
    saveNote: vi.fn(),
    deleteNote: vi.fn(),
    enableNoteEditing: vi.fn(),
    copyNote: vi.fn(),
    insertFragment: vi.fn(),
    createNoteFragment: vi.fn(),
  }
  return { ...original, noteApiClient: mockClient }
})

const mockedDelete = vi.mocked(noteApiClient.deleteNote)
const PROJECT = 'proj_1'
const NOTE = 'note_d2'

const CAPS_READY: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function receipt(overrides: Partial<NoteReceipt> = {}): NoteReceipt {
  return {
    note_id: NOTE,
    mutation_id: 'nm1',
    applied_revision: 3,
    snapshot_hash: null,
    saved_at: '2026-11-10T00:00:00.000Z',
    replayed: false,
    ...overrides,
  }
}

let generation = 1
let workspaceProjectId = PROJECT

/** 回显请求的 mutation_id/expected_revision（删除回执契约：applied_revision=删除前 revision）。 */
function echoDeleteReceipt(
  _projectId: string,
  _noteId: string,
  body: { mutation_id: string; expected_revision: number },
): NoteReceipt {
  return receipt({ mutation_id: body.mutation_id, applied_revision: body.expected_revision })
}

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  return (
    <ResearchWorkspaceProvider
      projectId={workspaceProjectId}
      role="owner"
      userId="7"
      authGeneration={generation}
    >
      {children}
    </ResearchWorkspaceProvider>
  )
}

function renderDelete(initial: Partial<UseNoteDeleteOptions> = {}) {
  return renderHook(
    (props: UseNoteDeleteOptions) => useNoteDelete(props),
    {
      wrapper: Wrapper,
      initialProps: {
        projectId: PROJECT,
        capabilities: CAPS_READY,
        isAdminReadonly: false,
        ...initial,
      },
    },
  )
}

describe('useNoteDelete', () => {
  beforeEach(() => {
    generation = 1
    workspaceProjectId = PROJECT
    mockedDelete.mockReset()
  })

  it('初始 idle；requestDelete → confirming；confirm 成功返回 note_id 并回 idle', async () => {
    mockedDelete.mockImplementation(async (project, note, body) =>
      echoDeleteReceipt(project, note, body),
    )
    const { result } = renderDelete()

    expect(result.current.state.phase).toBe('idle')
    act(() => result.current.actions.requestDelete(NOTE, 3, '受保护笔记'))
    expect(result.current.state.phase).toBe('confirming')
    expect(result.current.state.expectedRevision).toBe(3)

    let confirmed: string | null = null
    await act(async () => {
      confirmed = await result.current.actions.confirmDelete()
    })
    expect(confirmed).toBe(NOTE)
    expect(result.current.state.phase).toBe('idle')
    expect(mockedDelete).toHaveBeenCalledWith(PROJECT, NOTE, {
      mutation_id: expect.any(String),
      expected_revision: 3,
    })
  })

  it('actions 引用在同一状态机生命周期内稳定（不随 state 变化重建）', () => {
    const { result, rerender } = renderDelete()
    const first = result.current.actions

    act(() => result.current.actions.requestDelete(NOTE, 3))
    rerender({ projectId: PROJECT, capabilities: CAPS_READY, isAdminReadonly: false })

    expect(result.current.actions).toBe(first)
  })

  it('capabilities 变化同步进状态机（能力恢复后守卫放行）', () => {
    const { result, rerender } = renderDelete({ capabilities: null })

    act(() => result.current.actions.requestDelete(NOTE, 3))
    expect(result.current.state.blockReason).toBe('capability_unknown')
    expect(mockedDelete).not.toHaveBeenCalled()

    rerender({ projectId: PROJECT, capabilities: CAPS_READY, isAdminReadonly: false })
    act(() => result.current.actions.dismiss())
    act(() => result.current.actions.requestDelete(NOTE, 3))
    expect(result.current.state.phase).toBe('confirming')
  })

  it('Admin 只读守卫：error/restricted，不发请求', () => {
    const { result } = renderDelete({ isAdminReadonly: true })
    act(() => result.current.actions.requestDelete(NOTE, 3))

    expect(result.current.state.failureKind).toBe('restricted')
    expect(result.current.state.blockReason).toBe('admin_readonly')
    expect(mockedDelete).not.toHaveBeenCalled()
  })

  it('projectId 变化重置状态机（对话框状态作废）', () => {
    const { result, rerender } = renderDelete()
    act(() => result.current.actions.requestDelete(NOTE, 3))
    expect(result.current.state.phase).toBe('confirming')

    workspaceProjectId = 'proj_2'
    rerender({ projectId: 'proj_2', capabilities: CAPS_READY, isAdminReadonly: false })

    expect(result.current.state.phase).toBe('idle')
    expect(result.current.state.noteId).toBeNull()
  })

  it('身份代际变化重置状态机', () => {
    const { result, rerender } = renderDelete()
    act(() => result.current.actions.requestDelete(NOTE, 3))
    expect(result.current.state.phase).toBe('confirming')

    generation = 2
    rerender({ projectId: PROJECT, capabilities: CAPS_READY, isAdminReadonly: false })

    expect(result.current.state.phase).toBe('idle')
  })

  it('StrictMode 双挂载不销毁状态机：confirm 仍可用', async () => {
    mockedDelete.mockImplementation(async (project, note, body) =>
      echoDeleteReceipt(project, note, body),
    )
    const { result } = renderHook(
      (props: UseNoteDeleteOptions) => useNoteDelete(props),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>
            <Wrapper>{children}</Wrapper>
          </StrictMode>
        ),
        initialProps: {
          projectId: PROJECT,
          capabilities: CAPS_READY,
          isAdminReadonly: false,
        },
      },
    )

    act(() => result.current.actions.requestDelete(NOTE, 3))
    await act(async () => {
      await result.current.actions.confirmDelete()
    })
    expect(mockedDelete).toHaveBeenCalledTimes(1)
    expect(result.current.state.phase).toBe('idle')
  })

  it('卸载安全：在途请求结束后不抛异常', async () => {
    let resolveDelete!: (value: NoteReceipt) => void
    mockedDelete.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve
      }),
    )
    const { result, unmount } = renderDelete()

    act(() => result.current.actions.requestDelete(NOTE, 3))
    let inFlight: Promise<string | null> | null = null
    act(() => {
      inFlight = result.current.actions.confirmDelete()
    })
    unmount()

    await act(async () => {
      resolveDelete(receipt())
      if (inFlight !== null) await inFlight
    })
  })
})
