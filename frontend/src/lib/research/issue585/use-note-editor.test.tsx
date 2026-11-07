/**
 * 单文档编辑器 hook 单测（Issue #1046 PR4 / D2-B2）。
 *
 * 覆盖：冻结签名接线（open/save/状态）、能力与只读矩阵同步、身份代际同步、
 * beforeunload 仅在未完成保存时提示、pagehide 同步持久化草稿。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { noteApiClient } from './note-client'
import { useNoteEditor } from './use-note-editor'
import { NOTE_DRAFT_CACHE_PREFIX } from './note-draft-cache'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  NoteReceipt,
  ResearchNoteD2,
} from './types'

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

const mockedGet = vi.mocked(noteApiClient.getNote)
const mockedSave = vi.mocked(noteApiClient.saveNote)
const mockedCreate = vi.mocked(noteApiClient.createNote)
const PROJECT = 'proj_1'
const HASH = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)

const CAPS_READY: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function note(overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: 'n1',
    project_id: PROJECT,
    title: '原标题',
    content: '服务端正文',
    note_type: 'human',
    created_at: null,
    updated_at: null,
    revision: 1,
    snapshot_hash: HASH,
    edit_schema: 'd2-v1',
    access_state: 'visible',
    ...overrides,
  }
}

function receipt(overrides: Partial<NoteReceipt> = {}): NoteReceipt {
  return {
    note_id: 'n1',
    mutation_id: 'nm1',
    applied_revision: 2,
    snapshot_hash: HASH2,
    saved_at: '2026-11-05T00:00:00.000Z',
    replayed: false,
    ...overrides,
  }
}

let generation = 1

function Wrapper({ children }: { children: ReactNode }): ReactNode {
  return (
    <ResearchWorkspaceProvider
      projectId={PROJECT}
      role="owner"
      userId="7"
      authGeneration={generation}
    >
      {children}
    </ResearchWorkspaceProvider>
  )
}

/**
 * StrictMode 回归 Harness：StrictMode 必须是渲染根元素的直接子树才会触发
 * effect 的 setup→cleanup→setup 双调用（嵌套在普通 wrapper 内不会触发）。
 */
function StrictHarness({
  bind,
}: {
  bind: (value: { state: NoteEditorState; actions: NoteEditorActions }) => void
}): ReactNode {
  const result = useNoteEditor({
    projectId: PROJECT,
    capabilities: CAPS_READY,
    isAdminReadonly: false,
  })
  bind(result)
  return <div data-testid="editor-content">{result.state.content}</div>
}

function strictRoot(
  bind: (value: { state: NoteEditorState; actions: NoteEditorActions }) => void,
): ReactNode {
  return (
    <StrictMode>
      <ResearchWorkspaceProvider
        projectId={PROJECT}
        role="owner"
        userId="7"
        authGeneration={generation}
      >
        <StrictHarness bind={bind} />
      </ResearchWorkspaceProvider>
    </StrictMode>
  )
}

function renderEditor(
  initial: { capabilities?: NoteCapabilities | null; isAdminReadonly?: boolean } = {},
) {
  return renderHook(
    ({
      capabilities,
      isAdminReadonly,
    }: {
      capabilities: NoteCapabilities | null
      isAdminReadonly: boolean
    }) => useNoteEditor({ projectId: PROJECT, capabilities, isAdminReadonly }),
    {
      wrapper: Wrapper,
      initialProps: {
        capabilities: (initial.capabilities ?? CAPS_READY) as NoteCapabilities | null,
        isAdminReadonly: initial.isAdminReadonly ?? false,
      },
    },
  )
}

function storedDraftKeys(): string[] {
  const keys: string[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key !== null && key.startsWith(`${NOTE_DRAFT_CACHE_PREFIX}.`)) keys.push(key)
  }
  return keys
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  generation = 1
  mockedGet.mockReset()
  mockedSave.mockReset()
})

describe('useNoteEditor', () => {
  it('exposes the frozen result shape and opens a note through actions', async () => {
    mockedGet.mockResolvedValue(note())
    const { result } = renderEditor()
    expect(result.current.state).toMatchObject({
      status: 'idle',
      saveStatus: 'idle',
      authGeneration: 1,
    })
    await act(async () => {
      await result.current.actions.openNote('n1')
    })
    expect(result.current.state).toMatchObject({
      status: 'ready',
      title: '原标题',
      content: '服务端正文',
      saveStatus: 'saved',
    })
    expect(mockedGet).toHaveBeenCalledWith(PROJECT, 'n1')
  })

  it('saves the current text through saveNow and settles to saved', async () => {
    mockedGet.mockResolvedValue(note())
    mockedSave.mockResolvedValue(receipt())
    const { result } = renderEditor()
    await act(async () => {
      await result.current.actions.openNote('n1')
    })
    act(() => {
      result.current.actions.setContent('本地编辑')
    })
    expect(result.current.state.saveStatus).toBe('pending')
    await act(async () => {
      await result.current.actions.saveNow()
    })
    expect(mockedSave).toHaveBeenCalledTimes(1)
    expect(mockedSave.mock.calls[0][2]).toMatchObject({
      expected_revision: 1,
      content: '本地编辑',
    })
    expect(result.current.state.saveStatus).toBe('saved')
  })

  it('syncs capabilities into the machine (fail-closed block, then recover)', async () => {
    mockedGet.mockResolvedValue(note())
    const { result, rerender } = renderEditor()
    await act(async () => {
      await result.current.actions.openNote('n1')
    })
    rerender({ capabilities: null, isAdminReadonly: false })
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        saveStatus: 'blocked',
        blockReason: 'capability_unknown',
      }),
    )
    rerender({ capabilities: CAPS_READY, isAdminReadonly: false })
    await waitFor(() => expect(result.current.state.saveStatus).not.toBe('blocked'))
  })

  it('respects isAdminReadonly (read-only restricted, no writes)', async () => {
    mockedGet.mockResolvedValue(note())
    const { result } = renderEditor({ isAdminReadonly: true })
    await act(async () => {
      await result.current.actions.openNote('n1')
    })
    expect(result.current.state).toMatchObject({
      saveStatus: 'restricted',
      blockReason: 'note_access_restricted',
    })
    await act(async () => {
      await result.current.actions.saveNow()
    })
    expect(mockedSave).not.toHaveBeenCalled()
  })

  it('updates authGeneration in state when the workspace generation changes', async () => {
    mockedGet.mockResolvedValue(note())
    const { result, rerender } = renderEditor()
    await act(async () => {
      await result.current.actions.openNote('n1')
    })
    generation = 2
    rerender({ capabilities: CAPS_READY, isAdminReadonly: false })
    await waitFor(() => expect(result.current.state.authGeneration).toBe(2))
    // 同 viewer 的代际变化保留本地编辑。
    expect(result.current.state.content).toBe('服务端正文')
  })

  it('prompts beforeunload only while a save is unfinished', async () => {
    mockedGet.mockResolvedValue(note())
    const { result } = renderEditor()
    await act(async () => {
      await result.current.actions.openNote('n1')
    })
    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)

    act(() => {
      result.current.actions.setContent('未保存正文')
    })
    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyEvent)
    expect(dirtyEvent.defaultPrevented).toBe(true)
    expect(result.current.state.saveStatus).toBe('pending')
  })

  it('persists the local draft synchronously on pagehide', async () => {
    mockedGet.mockResolvedValue(note())
    const { result } = renderEditor()
    await act(async () => {
      await result.current.actions.openNote('n1')
    })
    act(() => {
      result.current.actions.setContent('pagehide 草稿')
    })
    expect(storedDraftKeys().length).toBeGreaterThan(0)
    window.dispatchEvent(new Event('pagehide'))
    const keys = storedDraftKeys()
    expect(keys.length).toBeGreaterThan(0)
    const raw = window.localStorage.getItem(keys[0])
    expect(raw).toContain('pagehide 草稿')
  })

  it('stays fully usable after StrictMode setup→cleanup→setup (no permanent dispose)', async () => {
    mockedGet.mockResolvedValue(note())
    mockedSave.mockResolvedValue(receipt())
    let latest: { state: NoteEditorState; actions: NoteEditorActions } | null = null
    render(strictRoot((value) => {
      latest = value
    }))
    // 若 cleanup 永久 dispose 了同一 machine，openNote 会静默 no-op、不发 GET。
    await act(async () => {
      await latest!.actions.openNote('n1')
    })
    expect(mockedGet).toHaveBeenCalledTimes(1)
    expect(latest!.state).toMatchObject({
      status: 'ready',
      content: '服务端正文',
      saveStatus: 'saved',
    })
    act(() => {
      latest!.actions.setContent('StrictMode 后仍可编辑')
    })
    await act(async () => {
      await latest!.actions.saveNow()
    })
    expect(mockedSave).toHaveBeenCalledTimes(1)
    expect(mockedSave.mock.calls[0][2]).toMatchObject({
      expected_revision: 1,
      content: 'StrictMode 后仍可编辑',
    })
    expect(latest!.state.saveStatus).toBe('saved')
  })

  it('createBlankNote still POSTs after StrictMode setup→cleanup→setup', async () => {
    mockedCreate.mockResolvedValue(
      receipt({ note_id: 'new_1', applied_revision: 1 }),
    )
    mockedGet.mockResolvedValue(
      note({ note_id: 'new_1', title: '未命名成果', content: '' }),
    )
    let latest: { state: NoteEditorState; actions: NoteEditorActions } | null = null
    render(strictRoot((value) => {
      latest = value
    }))
    let noteId: string | null = null
    await act(async () => {
      noteId = await latest!.actions.createBlankNote()
    })
    expect(noteId).toBe('new_1')
    expect(mockedCreate).toHaveBeenCalledTimes(1)
    expect(mockedCreate.mock.calls[0][1]).toEqual({ mutation_id: expect.any(String) })
    expect(latest!.state).toMatchObject({ status: 'ready', saveStatus: 'saved' })
  })
})
