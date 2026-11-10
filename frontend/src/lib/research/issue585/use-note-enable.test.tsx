/**
 * 启用受保护编辑 hook 单测（Issue #1135）。
 *
 * 覆盖：冻结签名接线（state/actions）、actions 引用稳定、capabilities 变化
 * 同步、projectId/身份变化重置状态机、StrictMode 双挂载不销毁状态机、
 * 卸载安全（在途请求结束后不抛异常）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { noteApiClient } from './note-client'
import { useNoteEnable, type UseNoteEnableOptions } from './use-note-enable'
import type { NoteCapabilities, NoteReceipt, ResearchNoteD2 } from './types'

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
  }
  return { ...original, noteApiClient: mockClient }
})

const mockedEnable = vi.mocked(noteApiClient.enableNoteEditing)
const PROJECT = 'proj_1'
const NOTE = 'note_legacy'
const HASH = 'a'.repeat(64)

const CAPS_READY: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function note(overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: NOTE,
    project_id: PROJECT,
    title: '旧笔记',
    content: '旧正文',
    note_type: 'human',
    created_at: null,
    updated_at: '2026-11-05T00:00:00.000Z',
    revision: 3,
    snapshot_hash: HASH,
    edit_schema: 'd2-v1',
    access_state: 'visible',
    ...overrides,
  }
}

function receipt(overrides: Partial<NoteReceipt> = {}): NoteReceipt {
  return {
    note_id: NOTE,
    mutation_id: 'nm1',
    applied_revision: 4,
    snapshot_hash: HASH,
    saved_at: '2026-11-05T00:00:00.000Z',
    replayed: false,
    ...overrides,
  }
}

let generation = 1
let workspaceProjectId = PROJECT

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

function renderEnable(initial: Partial<UseNoteEnableOptions> = {}) {
  return renderHook(
    (props: UseNoteEnableOptions) => useNoteEnable(props),
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

describe('useNoteEnable', () => {
  beforeEach(() => {
    generation = 1
    workspaceProjectId = PROJECT
    mockedEnable.mockReset()
  })

  it('初始 idle；requestEnable → confirming；confirm 成功返回 note_id 并回 idle', async () => {
    mockedEnable.mockResolvedValue({ note: note(), receipt: receipt() })
    const { result } = renderEnable()

    expect(result.current.state.phase).toBe('idle')
    act(() => result.current.actions.requestEnable(NOTE))
    expect(result.current.state.phase).toBe('confirming')

    let confirmed: string | null = null
    await act(async () => {
      confirmed = await result.current.actions.confirmEnable()
    })
    expect(confirmed).toBe(NOTE)
    expect(result.current.state.phase).toBe('idle')
    expect(mockedEnable).toHaveBeenCalledWith(PROJECT, NOTE, { mutation_id: expect.any(String) })
  })

  it('actions 引用在同一状态机生命周期内稳定（不随 state 变化重建）', () => {
    const { result, rerender } = renderEnable()
    const first = result.current.actions

    act(() => result.current.actions.requestEnable(NOTE))
    rerender({ projectId: PROJECT, capabilities: CAPS_READY, isAdminReadonly: false })

    expect(result.current.actions).toBe(first)
  })

  it('capabilities 变化同步进状态机（能力恢复后守卫放行）', async () => {
    const { result, rerender } = renderEnable({ capabilities: null })

    act(() => result.current.actions.requestEnable(NOTE))
    expect(result.current.state.blockReason).toBe('capability_unknown')
    expect(mockedEnable).not.toHaveBeenCalled()

    rerender({ projectId: PROJECT, capabilities: CAPS_READY, isAdminReadonly: false })
    await waitFor(() => expect(result.current.state.phase).toBe('error'))
    act(() => result.current.actions.dismiss())
    act(() => result.current.actions.requestEnable(NOTE))
    expect(result.current.state.phase).toBe('confirming')
  })

  it('projectId 变化重置状态机（对话框状态作废）', () => {
    const { result, rerender } = renderEnable()
    act(() => result.current.actions.requestEnable(NOTE))
    expect(result.current.state.phase).toBe('confirming')

    workspaceProjectId = 'proj_2'
    rerender({ projectId: 'proj_2', capabilities: CAPS_READY, isAdminReadonly: false })

    expect(result.current.state.phase).toBe('idle')
    expect(result.current.state.noteId).toBeNull()
  })

  it('身份代际变化重置状态机', () => {
    const { result, rerender } = renderEnable()
    act(() => result.current.actions.requestEnable(NOTE))
    expect(result.current.state.phase).toBe('confirming')

    generation = 2
    rerender({ projectId: PROJECT, capabilities: CAPS_READY, isAdminReadonly: false })

    expect(result.current.state.phase).toBe('idle')
  })

  it('StrictMode 双挂载不销毁状态机：confirm 仍可用', async () => {
    mockedEnable.mockResolvedValue({ note: note(), receipt: null })
    const { result } = renderHook(
      (props: UseNoteEnableOptions) => useNoteEnable(props),
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

    act(() => result.current.actions.requestEnable(NOTE))
    await act(async () => {
      await result.current.actions.confirmEnable()
    })
    expect(mockedEnable).toHaveBeenCalledTimes(1)
    expect(result.current.state.phase).toBe('idle')
  })

  it('卸载安全：在途请求结束后不抛异常', async () => {
    let resolveEnable!: (value: { note: ResearchNoteD2; receipt: NoteReceipt | null }) => void
    mockedEnable.mockReturnValue(
      new Promise((resolve) => {
        resolveEnable = resolve
      }),
    )
    const { result, unmount } = renderEnable()

    act(() => result.current.actions.requestEnable(NOTE))
    let inFlight: Promise<string | null> | null = null
    act(() => {
      inFlight = result.current.actions.confirmEnable()
    })
    unmount()

    await act(async () => {
      resolveEnable({ note: note(), receipt: null })
      if (inFlight !== null) await inFlight
    })
  })
})
