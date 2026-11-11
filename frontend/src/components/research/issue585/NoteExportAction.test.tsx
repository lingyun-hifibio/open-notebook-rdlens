/**
 * NoteExportAction 组件测试（Issue #1191 PR-B，计划 §2.2.1/§5.1）。
 *
 * 契约（NORMATIVE，P-E 的 S10 只用这三个 testid）：
 * - 入口按钮 `data-testid="note-export-markdown"`；
 * - 导出中状态 `role="status"` + `data-testid="note-export-status"`；
 * - 失败条 `role="alert"` + `data-testid="note-export-error"`。
 *
 * 覆盖：入口可达（键盘/aria）、能力/Admin/保护格式不可用时渲染 null、导出中
 * 禁用与播报、成功文案、失败呈现（不显示“已导出”、无原始错误正文）、
 * 单在途。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { downloadNoteExportFile, requestNoteExportD2 } from '@/lib/research/issue585/note-client'
import { expectedExportDownloadPath } from '@/lib/research/issue585/note-export'
import { NoteExportAction, type NoteExportActionProps } from './NoteExportAction'
import type { NoteWorkspaceEditorHandle } from './NoteWorkspaceProvider'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'

vi.mock('@/lib/research/issue585/note-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/research/issue585/note-client')>()
  return {
    ...original,
    requestNoteExportD2: vi.fn(),
    downloadNoteExportFile: vi.fn(),
  }
})

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

const mockedRequest = vi.mocked(requestNoteExportD2)
const mockedDownload = vi.mocked(downloadNoteExportFile)

const PROJECT = 'proj_1'
const NOTE = 'note_1'
const HASH = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)
const EXPORT_ID = `nex_${'c'.repeat(32)}`
const TITLE = '受保护笔记'
const BLOB = new Blob(['# body'], { type: 'text/markdown' })

function d2Note(overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: NOTE,
    project_id: PROJECT,
    title: TITLE,
    content: '# 正文',
    note_type: 'human',
    created_at: '2026-11-11T00:00:00Z',
    updated_at: '2026-11-11T00:00:00Z',
    revision: 3,
    snapshot_hash: HASH,
    edit_schema: 'd2-v1',
    access_state: 'visible',
    ...overrides,
  }
}

function makeState(overrides: Partial<NoteEditorState> = {}): NoteEditorState {
  return {
    status: 'ready',
    note: d2Note(),
    title: TITLE,
    content: '# 正文',
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

function capabilities(markdownExport: boolean): NoteCapabilities {
  return {
    noteEditor: { available: true, reason: null },
    noteEditorExisting: { available: true, reason: null },
    markdownExport: {
      available: markdownExport,
      reason: markdownExport ? null : 'not_ready',
    },
    writingLocal: { available: false, reason: 'not_ready' },
    writingExternal: { available: false, reason: 'not_ready' },
  }
}

function exportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    export_id: EXPORT_ID,
    project_id: PROJECT,
    note_id: NOTE,
    note_revision: 3,
    note_snapshot_hash: HASH,
    format: 'markdown',
    content_hash: HASH2,
    created_at: '2026-11-11T00:00:00Z',
    download_url: expectedExportDownloadPath(PROJECT, EXPORT_ID),
    replayed: false,
    ...overrides,
  }
}

function axiosError(status: number, detail?: unknown): unknown {
  return {
    isAxiosError: true,
    response: { status, data: detail === undefined ? {} : { detail }, headers: {} },
  }
}

function renderAction(overrides: Partial<React.ComponentProps<typeof NoteExportAction>> = {}) {
  const actions = makeActions()
  const props: React.ComponentProps<typeof NoteExportAction> = {
    editor: { state: makeState(), actions },
    capabilities: capabilities(true),
    isAdminReadonly: false,
    ...overrides,
  }
  const utils = render(<NoteExportAction {...props} />)
  return { ...utils, actions, props }
}

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  createObjectURL = vi.fn(() => `blob:note-export-${EXPORT_ID}`)
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  })
  mockedRequest.mockReset()
  mockedDownload.mockReset()
  mockedRequest.mockResolvedValue({ status: 201, data: exportPayload() } as never)
  mockedDownload.mockResolvedValue({ blob: BLOB, filename: null } as never)
})

afterEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: originalCreateObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: originalRevokeObjectURL,
  })
})

describe('NoteExportAction visibility', () => {
  it('renders nothing when markdownExport capability is unavailable', () => {
    const { container } = renderAction({ capabilities: capabilities(false) })
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('note-export-markdown')).toBeNull()
  })

  it('renders nothing when capabilities are unknown (fail-closed)', () => {
    const { container } = renderAction({ capabilities: null })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for Admin read-only sessions', () => {
    const { container } = renderAction({ isAdminReadonly: true })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for legacy/unprotected notes or without an editor', () => {
    const legacy = d2Note({ edit_schema: null, revision: null, snapshot_hash: null })
    const first = renderAction({
      editor: { state: makeState({ note: legacy }), actions: makeActions() },
    })
    expect(first.container).toBeEmptyDOMElement()
    first.unmount()

    const second = renderAction({ editor: null })
    expect(second.container).toBeEmptyDOMElement()
  })
})

describe('NoteExportAction interaction', () => {
  it('exposes a keyboard-focusable button with an accessible name', () => {
    renderAction()
    const button = screen.getByTestId('note-export-markdown')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAccessibleName('research.notes.export.action')
    expect(button).toBeEnabled()
    button.focus()
    expect(button).toHaveFocus()
    expect(screen.getByTestId('note-export-status')).toHaveAttribute('role', 'status')
    expect(screen.queryByTestId('note-export-error')).toBeNull()
  })

  it('announces the exporting state, disables the button and downloads on success', async () => {
    let resolveRequest!: (value: unknown) => void
    mockedRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        }) as never,
    )
    renderAction()

    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
    })

    const button = screen.getByTestId('note-export-markdown')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('note-export-status')).toHaveTextContent(
      'research.notes.export.exporting',
    )

    await act(async () => {
      resolveRequest({ status: 201, data: exportPayload() })
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(screen.getByTestId('note-export-status')).toHaveTextContent(
        'research.notes.export.exported',
      ),
    )
    expect(screen.getByTestId('note-export-markdown')).toBeEnabled()
    expect(screen.queryByTestId('note-export-error')).toBeNull()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('ignores repeated clicks while an export is running', async () => {
    let resolveRequest!: (value: unknown) => void
    mockedRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        }) as never,
    )
    renderAction()

    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
    })
    expect(mockedRequest).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRequest({ status: 201, data: exportPayload() })
      await Promise.resolve()
    })
  })
})

describe('NoteExportAction failure presentation', () => {
  it('shows an inline role=alert with the mapped label and never claims the export succeeded', async () => {
    mockedRequest.mockRejectedValue(axiosError(403))
    renderAction()

    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
      await Promise.resolve()
    })

    const alert = await screen.findByTestId('note-export-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent('research.notes.editor.errors.note_access_restricted')
    expect(alert).toHaveTextContent('research.notes.export.hint.restricted')
    expect(screen.getByTestId('note-export-status')).not.toHaveTextContent(
      'research.notes.export.exported',
    )
    expect(screen.queryByText(/boom|stack/i)).toBeNull()
    expect(mockedDownload).not.toHaveBeenCalled()
  })

  it('shows the request id for a 422 invalid export request', async () => {
    mockedRequest.mockRejectedValue(
      axiosError(422, {
        code: 'export_request_invalid',
        message: 'm',
        retryable: false,
        request_id: 'req_422',
      }),
    )
    renderAction()

    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
      await Promise.resolve()
    })

    const alert = await screen.findByTestId('note-export-error')
    expect(alert).toHaveTextContent('research.notes.editor.errors.export_request_invalid')
    expect(alert).toHaveTextContent('research.notes.export.requestId req_422')
  })

  it('shows the same-key retry hint for an unconfirmed 503 result', async () => {
    mockedRequest.mockRejectedValue(axiosError(503))
    renderAction()

    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
      await Promise.resolve()
    })

    const alert = await screen.findByTestId('note-export-error')
    expect(alert).toHaveTextContent(
      'research.notes.editor.errors.export_snapshot_unavailable',
    )
    expect(alert).toHaveTextContent('research.notes.export.hint.unknownResult')
  })

  it('clears the previous failure when a new export attempt starts', async () => {
    mockedRequest.mockRejectedValueOnce(axiosError(403))
    mockedRequest.mockResolvedValueOnce({ status: 201, data: exportPayload() } as never)
    renderAction()

    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
      await Promise.resolve()
    })
    expect(await screen.findByTestId('note-export-error')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('note-export-markdown'))
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByTestId('note-export-error')).toBeNull())
    await waitFor(() =>
      expect(screen.getByTestId('note-export-status')).toHaveTextContent(
        'research.notes.export.exported',
      ),
    )
  })
})

describe('NoteExportAction mount contract (PR-A TargetEditorFocus)', () => {
  it('accepts the provider editor handle unchanged (no adapter layer at the mount point)', () => {
    // PR-A 的 TargetEditorFocus 从 `useNoteWorkspace()` 取 `editor` 并原样传入；
    // 这里锁死该结构契约（provider 句柄 → NoteExportAction props）。
    const providerEditor: NoteWorkspaceEditorHandle | null = {
      state: makeState(),
      actions: makeActions(),
    }
    const props: NoteExportActionProps = {
      editor: providerEditor,
      capabilities: capabilities(true),
      isAdminReadonly: false,
    }
    const { container } = render(<NoteExportAction {...props} />)
    expect(container).not.toBeEmptyDOMElement()
    expect(screen.getByTestId('note-export-markdown')).toBeInTheDocument()
  })
})
