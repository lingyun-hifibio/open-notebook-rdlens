/**
 * 单份 Markdown 导出 hook 单测（Issue #1191 PR-B，计划 §5.1/§2.2.2）。
 *
 * 覆盖：
 * - 可见性三道闸（能力位/Admin 只读/d2-v1+revision+snapshot_hash），全部
 *   fail-closed：不可用时不发请求、不 flush；
 * - flush-first：先 `flushBeforeLeave()`；非 null 阻塞原因（saving/unsaved/
 *   restricted/failed/conflict/unknown）一律中止导出，且以**保存后**的
 *   revision/snapshot_hash 发请求（不导出旧版本）；
 * - 201 与 200(replayed) 都能下载；同签名重试/再次点击复用同一幂等键；
 * - 403/404/409×3/422/503 失败分类，畸形响应不冒充成功；失败不改正文/草稿；
 * - 单在途：导出中重复调用是 no-op。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { downloadNoteExportFile, requestNoteExportD2 } from './note-client'
import { expectedExportDownloadPath } from './note-export'
import { useNoteExport, type UseNoteExportOptions } from './use-note-export'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from './types'

vi.mock('./note-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('./note-client')>()
  return {
    ...original,
    requestNoteExportD2: vi.fn(),
    downloadNoteExportFile: vi.fn(),
  }
})

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

function renderExport(options: Partial<UseNoteExportOptions> = {}) {
  const actions = makeActions()
  const initialProps: UseNoteExportOptions = {
    editor: { state: makeState(), actions },
    capabilities: capabilities(true),
    isAdminReadonly: false,
    download: vi.fn(() => true),
    ...options,
  }
  const utils = renderHook((props: UseNoteExportOptions) => useNoteExport(props), {
    initialProps,
  })
  return { ...utils, actions, props: initialProps }
}

function lastRequest() {
  const call = mockedRequest.mock.calls.at(-1)
  if (call === undefined) throw new Error('no export request was sent')
  return call[2] as { revision: number; snapshot_hash: string; format: string }
}

beforeEach(() => {
  mockedRequest.mockReset()
  mockedDownload.mockReset()
  // 服务端响应绑定请求里的 revision/snapshot_hash（与 #1050 契约一致）。
  mockedRequest.mockImplementation(async (_projectId, _noteId, body) => ({
    status: 201,
    data: exportPayload({
      note_revision: body.revision,
      note_snapshot_hash: body.snapshot_hash,
    }),
  }) as never)
  mockedDownload.mockResolvedValue({ blob: BLOB, filename: null } as never)
})

// ── 可见性闸（fail-closed） ──────────────────────────────────────────────

describe('visibility gates', () => {
  it('is available for a d2-v1 note with capability and no Admin read-only mode', () => {
    const { result } = renderExport()
    expect(result.current.state.available).toBe(true)
    expect(result.current.state.failure).toBeNull()
    expect(result.current.state.isExporting).toBe(false)
  })

  it('is unavailable (and sends nothing) when markdownExport is not available', async () => {
    const { result, actions } = renderExport({ capabilities: capabilities(false) })
    expect(result.current.state.available).toBe(false)
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(actions.flushBeforeLeave).not.toHaveBeenCalled()
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('is unavailable when capabilities are unknown (fail-closed)', () => {
    const { result } = renderExport({ capabilities: null })
    expect(result.current.state.available).toBe(false)
  })

  it('is unavailable for Admin read-only sessions and sends nothing', async () => {
    const { result, actions } = renderExport({ isAdminReadonly: true })
    expect(result.current.state.available).toBe(false)
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(actions.flushBeforeLeave).not.toHaveBeenCalled()
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('is unavailable for legacy / unprotected notes', () => {
    const { result } = renderExport({
      editor: {
        state: makeState({
          note: d2Note({ edit_schema: null, revision: null, snapshot_hash: null }),
        }),
        actions: makeActions(),
      },
    })
    expect(result.current.state.available).toBe(false)
  })

  it('is unavailable while the note has no confirmed revision/snapshot_hash', () => {
    const { result } = renderExport({
      editor: { state: makeState({ note: d2Note({ revision: null }) }), actions: makeActions() },
    })
    expect(result.current.state.available).toBe(false)
  })

  it('is unavailable while no note is open', () => {
    const { result } = renderExport({
      editor: { state: makeState({ status: 'idle', note: null }), actions: makeActions() },
    })
    expect(result.current.state.available).toBe(false)
  })
})

// ── flush-first ─────────────────────────────────────────────────────────

describe('flush-first', () => {
  it('flushes before requesting and spends the post-flush revision/snapshot_hash', async () => {
    const freshNote = d2Note({ revision: 4, snapshot_hash: HASH2 })
    const actions = makeActions()
    const download = vi.fn(() => true)
    const { result, rerender, props } = renderExport({
      editor: { state: makeState(), actions },
      download,
    })
    // 模拟真实机：flush 内部保存成功后再渲染新的 revision/hash。
    vi.mocked(actions.flushBeforeLeave).mockImplementation(async () => {
      rerender({
        ...props,
        editor: { state: makeState({ note: freshNote }), actions },
      })
      return null
    })

    await act(async () => {
      await result.current.exportMarkdown()
    })

    expect(actions.flushBeforeLeave).toHaveBeenCalledTimes(1)
    expect(mockedRequest).toHaveBeenCalledTimes(1)
    expect(lastRequest()).toEqual({
      revision: 4,
      snapshot_hash: HASH2,
      format: 'markdown',
    })
    expect(result.current.state.failure).toBeNull()
    expect(result.current.state.lastFilename).toBe(`${TITLE}.md`)
    expect(download).toHaveBeenCalledWith(BLOB, `${TITLE}.md`)
  })

  it.each([
    'saving',
    'unsaved',
    'restricted',
    'failed',
    'conflict',
    'unknown',
  ] as const)(
    'aborts honestly when flushBeforeLeave returns %s (no request, reuse leave label)',
    async (reason) => {
      const { result, actions } = renderExport()
      vi.mocked(actions.flushBeforeLeave).mockResolvedValue(reason)

      await act(async () => {
        await result.current.exportMarkdown()
      })

      expect(actions.flushBeforeLeave).toHaveBeenCalledTimes(1)
      expect(mockedRequest).not.toHaveBeenCalled()
      expect(mockedDownload).not.toHaveBeenCalled()
      expect(result.current.state.failure).toEqual({ kind: 'blocked', reason })
      expect(result.current.state.isExporting).toBe(false)
      expect(result.current.state.lastFilename).toBeNull()
    },
  )

  it('keeps the editor content and draft untouched when flush blocks or the export fails', async () => {
    const actions = makeActions()
    const { result } = renderExport({ editor: { state: makeState(), actions } })
    vi.mocked(actions.flushBeforeLeave).mockResolvedValue('unsaved')
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(actions.setContent).not.toHaveBeenCalled()
    expect(actions.setTitle).not.toHaveBeenCalled()
    expect(actions.discardLocal).not.toHaveBeenCalled()
    expect(actions.saveAsCopy).not.toHaveBeenCalled()
    expect(actions.loadLatest).not.toHaveBeenCalled()

    vi.mocked(actions.flushBeforeLeave).mockResolvedValue(null)
    mockedRequest.mockRejectedValue(axiosError(503))
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(actions.setContent).not.toHaveBeenCalled()
    expect(actions.setTitle).not.toHaveBeenCalled()
    expect(actions.discardLocal).not.toHaveBeenCalled()
  })
})

// ── 成功路径 ────────────────────────────────────────────────────────────

describe('success', () => {
  it('downloads the created export with the server filename when readable', async () => {
    mockedDownload.mockResolvedValue({ blob: BLOB, filename: '服务端名字.md' } as never)
    const download = vi.fn(() => true)
    const { result } = renderExport({ download })

    await act(async () => {
      await result.current.exportMarkdown()
    })

    expect(mockedRequest).toHaveBeenCalledTimes(1)
    expect(mockedDownload).toHaveBeenCalledWith(
      expectedExportDownloadPath(PROJECT, EXPORT_ID),
    )
    expect(download).toHaveBeenCalledWith(BLOB, '服务端名字.md')
    expect(result.current.state.failure).toBeNull()
    expect(result.current.state.lastFilename).toBe('服务端名字.md')
    expect(result.current.state.isExporting).toBe(false)
  })

  it('treats 200 replayed as success too', async () => {
    mockedRequest.mockResolvedValue({
      status: 200,
      data: exportPayload({ replayed: true }),
    } as never)
    const { result } = renderExport()
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(result.current.state.failure).toBeNull()
    expect(result.current.state.lastFilename).toBe(`${TITLE}.md`)
  })

  it('reuses the same idempotency key when the same version is exported again', async () => {
    const { result } = renderExport()
    await act(async () => {
      await result.current.exportMarkdown()
    })
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(mockedRequest).toHaveBeenCalledTimes(2)
    const firstKey = (mockedRequest.mock.calls[0][3] as string)
    const secondKey = (mockedRequest.mock.calls[1][3] as string)
    expect(secondKey).toBe(firstKey)
  })

  it('rotates the key when a new saved revision changes the signature', async () => {
    const actions = makeActions()
    const { result, rerender, props } = renderExport({
      editor: { state: makeState(), actions },
    })
    await act(async () => {
      await result.current.exportMarkdown()
    })
    const firstKey = mockedRequest.mock.calls[0][3] as string

    rerender({
      ...props,
      editor: {
        state: makeState({ note: d2Note({ revision: 4, snapshot_hash: HASH2 }) }),
        actions,
      },
    })
    await act(async () => {
      await result.current.exportMarkdown()
    })
    const secondKey = mockedRequest.mock.calls[1][3] as string
    expect(secondKey).not.toBe(firstKey)
    expect(lastRequest()).toMatchObject({ revision: 4, snapshot_hash: HASH2 })
  })
})

// ── 失败分类（403/404/409×3/422/503/畸形响应） ─────────────────────────

describe('failure mapping', () => {
  it.each([
    { name: '403', error: () => axiosError(403), code: 'note_access_restricted' },
    { name: '404 create', error: () => axiosError(404), code: 'note_not_found' },
    {
      name: '409 revision conflict',
      error: () =>
        axiosError(409, { code: 'note_revision_conflict', message: 'm', retryable: false }),
      code: 'note_revision_conflict',
    },
    {
      name: '409 export request conflict',
      error: () =>
        axiosError(409, { code: 'export_request_conflict', message: 'm', retryable: false }),
      code: 'export_request_conflict',
    },
    {
      name: '409 schema unsupported',
      error: () =>
        axiosError(409, {
          code: 'note_edit_schema_unsupported',
          message: 'm',
          retryable: false,
        }),
      code: 'note_edit_schema_unsupported',
    },
    { name: '422', error: () => axiosError(422), code: 'export_request_invalid' },
    { name: '503', error: () => axiosError(503), code: 'export_snapshot_unavailable' },
  ])('presents $name as a stable failure code, never as success', async ({ error, code }) => {
    mockedRequest.mockRejectedValue(error())
    const { result } = renderExport()
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(result.current.state.failure).toMatchObject({ kind: 'api', code })
    expect(result.current.state.lastFilename).toBeNull()
    expect(mockedDownload).not.toHaveBeenCalled()
    expect(result.current.state.isExporting).toBe(false)
  })

  it('does not download a malformed create response', async () => {
    mockedRequest.mockResolvedValue({
      status: 201,
      data: exportPayload({ download_url: 'https://evil.example.com/x.md' }),
    } as never)
    const download = vi.fn(() => true)
    const { result } = renderExport({ download })
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(result.current.state.failure).toEqual({ kind: 'invalid_response' })
    expect(mockedDownload).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(result.current.state.lastFilename).toBeNull()
  })

  it('maps a download 403 to note_access_restricted and a download 404 to export_not_found', async () => {
    mockedDownload.mockRejectedValue(axiosError(403))
    const { result } = renderExport()
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(result.current.state.failure).toMatchObject({
      kind: 'api',
      code: 'note_access_restricted',
    })

    mockedDownload.mockRejectedValue(axiosError(404))
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(result.current.state.failure).toMatchObject({
      kind: 'api',
      code: 'export_not_found',
    })
  })

  it('reports download_unavailable when the browser cannot start the download', async () => {
    const { result } = renderExport({ download: () => false })
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(result.current.state.failure).toEqual({ kind: 'download_unavailable' })
    expect(result.current.state.lastFilename).toBeNull()
  })

  it('rotates the key after export_request_conflict so the explicit retry can succeed', async () => {
    mockedRequest.mockRejectedValueOnce(
      axiosError(409, { code: 'export_request_conflict', message: 'm', retryable: false }),
    )
    const { result } = renderExport()
    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(result.current.state.failure).toMatchObject({
      kind: 'api',
      code: 'export_request_conflict',
    })
    const firstKey = mockedRequest.mock.calls[0][3] as string

    mockedRequest.mockResolvedValue({ status: 201, data: exportPayload() } as never)
    await act(async () => {
      await result.current.exportMarkdown()
    })
    const secondKey = mockedRequest.mock.calls[1][3] as string
    expect(secondKey).not.toBe(firstKey)
    expect(result.current.state.failure).toBeNull()
  })
})

// ── 单在途 ─────────────────────────────────────────────────────────────

describe('single in-flight export', () => {
  it('ignores repeated clicks while an export is running', async () => {
    let resolveRequest!: (value: unknown) => void
    mockedRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve
        }) as never,
    )
    const { result, actions } = renderExport()

    let first: Promise<void>
    await act(async () => {
      first = result.current.exportMarkdown()
      await Promise.resolve()
    })
    expect(result.current.state.isExporting).toBe(true)

    await act(async () => {
      await result.current.exportMarkdown()
    })
    expect(mockedRequest).toHaveBeenCalledTimes(1)
    expect(actions.flushBeforeLeave).toHaveBeenCalledTimes(1)

    resolveRequest({ status: 201, data: exportPayload() })
    await act(async () => {
      await first
    })
    expect(result.current.state.isExporting).toBe(false)
    expect(result.current.state.failure).toBeNull()
  })
})
