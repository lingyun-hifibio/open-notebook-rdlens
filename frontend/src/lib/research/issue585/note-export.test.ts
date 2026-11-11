/**
 * 单份 Markdown 导出纯逻辑单测（Issue #1191 PR-B / #1050 已冻结后端契约）。
 *
 * 覆盖（计划 §5.1 PR-B）：
 * - 传输：请求头恒含 `X-Research-Note-Contract: d2-v1` 与 `Idempotency-Key`；
 *   体恰三键；下载用响应 `download_url` 原样 GET（不自行拼路径）；
 * - 幂等键：按 `note_id+revision+snapshot_hash+format` 签名绑定，同签名复用、
 *   版本变化/冲突后显式重试换新 key；
 * - 响应校验：`export_id`/`download_url` 形态不合法 → 不冒充成功、不发起下载；
 * - 文件名：服务端 Content-Disposition 优先，否则本地回退 `<title>.md`
 *   （空标题 `note-<note_id>.md`，清洗路径分隔符/控制字符）；
 * - 下载：blob + `<a download>` + objectURL 回收，绝不 `window.open`；
 * - 失败归一：403/404/409×3/422/503 与畸形响应都给出稳定码，失败不得成功。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api/client'
import {
  downloadNoteExportFile,
  isNoteErrorCode,
  normalizeNoteExportApiError,
  requestNoteExportD2,
} from './note-client'
import {
  NOTE_EXPORT_ID_PATTERN,
  buildNoteExportBody,
  createNoteExportKeyStore,
  expectedExportDownloadPath,
  expectedExportDownloadPrefix,
  exportableNoteSnapshot,
  newNoteExportIdempotencyKey,
  noteExportSignatureKey,
  parseNoteExportResponse,
  resolveNoteExportFilename,
  runNoteExport,
  sanitizeNoteExportFilenameStem,
  triggerNoteExportDownload,
  type NoteExportSignature,
  type NoteExportTransport,
} from './note-export'
import type { NoteLeaveBlockReason, ResearchNoteD2 } from './types'

vi.mock('@/lib/api/client', () => ({
  API_TIMEOUT_MS: 600000,
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const mocked = vi.mocked(apiClient)

const PROJECT = 'proj_1'
const NOTE = 'note_1'
const HASH = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)
const EXPORT_ID = `nex_${'c'.repeat(32)}`
const OTHER_EXPORT_ID = `nex_${'d'.repeat(32)}`

function jsonResponse(data: unknown, status = 200): never {
  return { data, status, statusText: 'OK', headers: {}, config: {} } as never
}

function axiosError(
  status: number,
  detail: unknown,
  headers: Record<string, string> = {},
): unknown {
  return {
    isAxiosError: true,
    response: { status, data: detail === undefined ? {} : { detail }, headers },
  }
}

function signature(overrides: Partial<NoteExportSignature> = {}): NoteExportSignature {
  return {
    projectId: PROJECT,
    noteId: NOTE,
    revision: 3,
    snapshotHash: HASH,
    format: 'markdown',
    ...overrides,
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

function d2Note(overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: NOTE,
    project_id: PROJECT,
    title: '受保护笔记',
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

function fakeTransport(
  overrides: Partial<NoteExportTransport> = {},
): NoteExportTransport & {
  requestExport: ReturnType<typeof vi.fn>
  fetchExportFile: ReturnType<typeof vi.fn>
} {
  const requestExport = vi.fn(async () => ({ status: 201, data: exportPayload() }))
  const fetchExportFile = vi.fn(async () => ({
    blob: new Blob(['# body'], { type: 'text/markdown' }),
    filename: null as string | null,
  }))
  return { requestExport, fetchExportFile, ...overrides } as never
}

beforeEach(() => {
  mocked.get.mockReset()
  mocked.post.mockReset()
  mocked.patch.mockReset()
  mocked.delete.mockReset()
})

// ── 传输：头/体/下载 URL ─────────────────────────────────────────────────

describe('note export transport (note-client)', () => {
  it('sends the d2-v1 contract header, the idempotency key and exactly three body keys', async () => {
    mocked.post.mockResolvedValue(
      jsonResponse({ export_id: EXPORT_ID }, 201) as never,
    )
    const body = buildNoteExportBody(signature())
    const result = await requestNoteExportD2(PROJECT, NOTE, body, 'export-key-1')

    expect(mocked.post).toHaveBeenCalledTimes(1)
    const [url, sentBody, config] = mocked.post.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { headers: Record<string, string> },
    ]
    expect(url).toBe(`/v1/research/projects/${PROJECT}/notes/${NOTE}/exports`)
    expect(sentBody).toEqual({ revision: 3, snapshot_hash: HASH, format: 'markdown' })
    expect(Object.keys(sentBody).sort()).toEqual(['format', 'revision', 'snapshot_hash'])
    expect(config.headers['X-Research-Note-Contract']).toBe('d2-v1')
    expect(config.headers['Idempotency-Key']).toBe('export-key-1')
    expect(result.status).toBe(201)
  })

  it('downloads the response download_url verbatim and reads the Content-Disposition filename', async () => {
    const blob = new Blob(['# body'])
    mocked.get.mockResolvedValue({
      data: blob,
      status: 200,
      statusText: 'OK',
      headers: {
        'content-disposition':
          "attachment; filename=\"note.md\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%E7%AC%94%E8%AE%B0.md",
      },
      config: {},
    } as never)

    // 服务端给出的 URL（含查询串）必须原样使用，不自行拼路径。
    const downloadUrl = `${expectedExportDownloadPath(PROJECT, EXPORT_ID)}?download=1`
    const file = await downloadNoteExportFile(downloadUrl)

    expect(mocked.get).toHaveBeenCalledTimes(1)
    const [url, config] = mocked.get.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(url).toBe(downloadUrl)
    expect(config.responseType).toBe('blob')
    expect(file.blob).toBe(blob)
    expect(file.filename).toBe('中文笔记.md')
  })

  it('returns a null filename when Content-Disposition is missing or unreadable', async () => {
    mocked.get.mockResolvedValue({
      data: new Blob(['x']),
      status: 200,
      headers: {},
      config: {},
    } as never)
    const file = await downloadNoteExportFile(expectedExportDownloadPath(PROJECT, EXPORT_ID))
    expect(file.filename).toBeNull()
  })
})

// ── 错误码归一（含 409/export_* 扩码） ───────────────────────────────────

describe('normalizeNoteExportApiError', () => {
  it('accepts the additive export_* codes in the closed NoteErrorCode set', () => {
    expect(isNoteErrorCode('export_request_invalid')).toBe(true)
    expect(isNoteErrorCode('export_request_conflict')).toBe(true)
    expect(isNoteErrorCode('export_snapshot_unavailable')).toBe(true)
    expect(isNoteErrorCode('export_not_found')).toBe(true)
  })

  it('keeps the three 409 contract codes instead of degrading them to unknown_error', () => {
    expect(
      normalizeNoteExportApiError(
        axiosError(409, { code: 'note_revision_conflict', message: 'm', retryable: false }),
      ).code,
    ).toBe('note_revision_conflict')
    expect(
      normalizeNoteExportApiError(
        axiosError(409, { code: 'export_request_conflict', message: 'm', retryable: false }),
      ).code,
    ).toBe('export_request_conflict')
    expect(
      normalizeNoteExportApiError(
        axiosError(409, { code: 'note_edit_schema_unsupported', message: 'm', retryable: false }),
      ).code,
    ).toBe('note_edit_schema_unsupported')
  })

  it('never guesses an ambiguous 409 without a contract code', () => {
    const normalized = normalizeNoteExportApiError(axiosError(409, undefined))
    expect(normalized.code).toBe('unknown_error')
    expect(normalized.retryable).toBe(false)
  })

  it('maps a codeless 422 on the export path to export_request_invalid', () => {
    expect(normalizeNoteExportApiError(axiosError(422, undefined)).code).toBe(
      'export_request_invalid',
    )
  })

  it('maps a codeless 503 to the retryable export_snapshot_unavailable', () => {
    const normalized = normalizeNoteExportApiError(axiosError(503, undefined))
    expect(normalized.code).toBe('export_snapshot_unavailable')
    expect(normalized.retryable).toBe(true)
  })

  it('maps 403/404 per operation (create = Note, download = export record)', () => {
    expect(normalizeNoteExportApiError(axiosError(403, undefined)).code).toBe(
      'note_access_restricted',
    )
    expect(
      normalizeNoteExportApiError(axiosError(404, undefined), 'create').code,
    ).toBe('note_not_found')
    expect(
      normalizeNoteExportApiError(axiosError(404, undefined), 'download').code,
    ).toBe('export_not_found')
  })

  it('keeps server-provided retryable/request_id and never exposes a raw body', () => {
    const normalized = normalizeNoteExportApiError(
      axiosError(503, {
        code: 'export_snapshot_unavailable',
        message: 'boom stack trace',
        retryable: true,
        request_id: 'req_123',
      }),
    )
    expect(normalized.code).toBe('export_snapshot_unavailable')
    expect(normalized.retryable).toBe(true)
    expect(normalized.requestId).toBe('req_123')
    expect(normalized.message).toBe('boom stack trace') // 只进 error 对象，不直接展示
  })
})

// ── 请求体 / 幂等键签名 ─────────────────────────────────────────────────

describe('buildNoteExportBody', () => {
  it('builds the frozen closed three-key body', () => {
    expect(buildNoteExportBody(signature())).toEqual({
      revision: 3,
      snapshot_hash: HASH,
      format: 'markdown',
    })
  })
})

describe('idempotency key binding', () => {
  it('binds the key to note_id+revision+snapshot_hash+format', () => {
    const base = noteExportSignatureKey(signature())
    expect(base).toBe(noteExportSignatureKey(signature()))
    expect(base).not.toBe(noteExportSignatureKey(signature({ revision: 4 })))
    expect(base).not.toBe(noteExportSignatureKey(signature({ snapshotHash: HASH2 })))
    expect(base).not.toBe(noteExportSignatureKey(signature({ noteId: 'note_2' })))
    expect(base).not.toBe(noteExportSignatureKey(signature({ projectId: 'proj_2' })))
  })

  it('reuses the same key for the same signature and rotates it only on invalidation', () => {
    const store = createNoteExportKeyStore({ createKey: undefined })
    const first = store.keyFor(signature())
    expect(store.keyFor(signature())).toBe(first)
    expect(store.keyFor(signature({ revision: 4 }))).not.toBe(first)
    store.invalidate(signature({ revision: 4 }))
    const rotated = store.keyFor(signature({ revision: 4 }))
    expect(rotated).not.toBe(first)
    expect(store.keyFor(signature())).toBe(first)
  })

  it('generates server-valid idempotency keys (1..128 chars, no control chars)', () => {
    const key = newNoteExportIdempotencyKey()
    expect(key.length).toBeGreaterThan(0)
    expect(key.length).toBeLessThanOrEqual(128)
    expect(/[\u0000-\u001f]/.test(key)).toBe(false)
    expect(newNoteExportIdempotencyKey()).not.toBe(key)
  })
})

// ── 导出可用性（d2-v1 + revision + snapshot_hash） ─────────────────────

describe('exportableNoteSnapshot', () => {
  it('accepts a protected d2-v1 note with revision and snapshot_hash', () => {
    expect(exportableNoteSnapshot(d2Note())).toEqual({
      projectId: PROJECT,
      noteId: NOTE,
      revision: 3,
      snapshotHash: HASH,
    })
  })

  it('fails closed for legacy / missing revision / missing hash / missing note', () => {
    expect(exportableNoteSnapshot(null)).toBeNull()
    expect(
      exportableNoteSnapshot(d2Note({ edit_schema: null, revision: null, snapshot_hash: null })),
    ).toBeNull()
    expect(exportableNoteSnapshot(d2Note({ revision: null }))).toBeNull()
    expect(exportableNoteSnapshot(d2Note({ snapshot_hash: null }))).toBeNull()
    expect(exportableNoteSnapshot(d2Note({ revision: 0 }))).toBeNull()
    expect(exportableNoteSnapshot(d2Note({ note_id: '' }))).toBeNull()
    expect(exportableNoteSnapshot(d2Note({ project_id: '' }))).toBeNull()
  })
})

// ── 响应校验 ───────────────────────────────────────────────────────────

describe('parseNoteExportResponse', () => {
  const expected = { projectId: PROJECT, noteId: NOTE, revision: 3 }

  it('accepts 201 created and 200 replayed responses', () => {
    const created = parseNoteExportResponse({ status: 201, data: exportPayload() }, expected)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.created.exportId).toBe(EXPORT_ID)
    expect(created.created.downloadUrl).toBe(
      expectedExportDownloadPath(PROJECT, EXPORT_ID),
    )
    expect(created.created.replayed).toBe(false)

    const replayed = parseNoteExportResponse(
      { status: 200, data: exportPayload({ replayed: true }) },
      expected,
    )
    expect(replayed.ok).toBe(true)
    if (!replayed.ok) return
    expect(replayed.created.replayed).toBe(true)
  })

  it('rejects export_id not matching ^nex_ without inventing a download URL', () => {
    for (const exportId of ['exp_123', 'nex_short', 'nex_ZZZ', '', 42]) {
      const parsed = parseNoteExportResponse(
        { status: 201, data: exportPayload({ export_id: exportId }) },
        expected,
      )
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.failure.kind).toBe('invalid_response')
    }
    expect(NOTE_EXPORT_ID_PATTERN.test(EXPORT_ID)).toBe(true)
    expect(NOTE_EXPORT_ID_PATTERN.test('nex_zz')).toBe(false)
  })

  it('rejects a download_url that is absolute, off-prefix or for another export', () => {
    const invalid = [
      'https://evil.example.com/export/file',
      '//evil.example.com/export/file',
      `/v1/research/projects/${PROJECT}/export/${OTHER_EXPORT_ID}/file`,
      `/v1/research/projects/other_project/export/${EXPORT_ID}/file`,
      `/v1/research/projects/${PROJECT}/notes/${NOTE}/exports`,
      '',
    ]
    for (const downloadUrl of invalid) {
      const parsed = parseNoteExportResponse(
        { status: 201, data: exportPayload({ download_url: downloadUrl }) },
        expected,
      )
      expect(parsed.ok, downloadUrl).toBe(false)
    }
  })

  it('accepts a download_url that only adds a query string to the frozen path', () => {
    const downloadUrl = `${expectedExportDownloadPath(PROJECT, EXPORT_ID)}?download=1`
    const parsed = parseNoteExportResponse(
      { status: 201, data: exportPayload({ download_url: downloadUrl }) },
      expected,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.created.downloadUrl).toBe(downloadUrl)
  })

  it('rejects non-2xx/201, non-object payloads and mismatched note/revision/format', () => {
    const cases: Array<{ status: number; data: unknown }> = [
      { status: 500, data: exportPayload() },
      { status: 202, data: exportPayload() },
      { status: 201, data: null },
      { status: 201, data: 'not json' },
      { status: 201, data: exportPayload({ note_id: 'note_other' }) },
      { status: 201, data: exportPayload({ note_revision: 4 }) },
      { status: 201, data: exportPayload({ format: 'json' }) },
    ]
    for (const raw of cases) {
      const parsed = parseNoteExportResponse(raw, expected)
      expect(parsed.ok, JSON.stringify(raw)).toBe(false)
    }
  })

  it('exposes the frozen relative download prefix', () => {
    expect(expectedExportDownloadPrefix(PROJECT)).toBe(
      `/v1/research/projects/${encodeURIComponent(PROJECT)}/export/`,
    )
  })
})

// ── 文件名 ─────────────────────────────────────────────────────────────

describe('resolveNoteExportFilename', () => {
  it('prefers the server Content-Disposition filename', () => {
    expect(
      resolveNoteExportFilename({
        serverFilename: '周报 2026-Q4.md',
        title: '本地标题',
        noteId: NOTE,
      }),
    ).toBe('周报 2026-Q4.md')
  })

  it('sanitizes path separators and control characters in server filenames', () => {
    expect(
      resolveNoteExportFilename({
        serverFilename: 'a/b\\c\u0000d.md',
        title: '',
        noteId: NOTE,
      }),
    ).toBe('a_b_c_d.md')
  })

  it('falls back to <title>.md when Content-Disposition is unreadable', () => {
    expect(
      resolveNoteExportFilename({ serverFilename: null, title: '受保护笔记', noteId: NOTE }),
    ).toBe('受保护笔记.md')
    expect(
      resolveNoteExportFilename({ serverFilename: '', title: '  My   note  ', noteId: NOTE }),
    ).toBe('My note.md')
  })

  it('falls back to note-<note_id>.md for blank titles', () => {
    expect(resolveNoteExportFilename({ title: '', noteId: NOTE })).toBe(`note-${NOTE}.md`)
    expect(resolveNoteExportFilename({ title: '   ', noteId: NOTE })).toBe(`note-${NOTE}.md`)
    expect(resolveNoteExportFilename({ title: null, noteId: NOTE })).toBe(`note-${NOTE}.md`)
    expect(resolveNoteExportFilename({ title: undefined, noteId: NOTE })).toBe(
      `note-${NOTE}.md`,
    )
  })

  it('sanitizes local fallback titles (separators/control chars) without empty names', () => {
    expect(
      resolveNoteExportFilename({ title: 'a/b\\c\nd', noteId: NOTE }),
    ).toBe('a_b_c_d.md')
    expect(sanitizeNoteExportFilenameStem('  ..hidden..  ')).toBe('hidden')
    expect(resolveNoteExportFilename({ title: '/', noteId: NOTE })).toBe(`note-${NOTE}.md`)
    const long = resolveNoteExportFilename({ title: 'x'.repeat(400), noteId: NOTE })
    expect(long.length).toBeLessThanOrEqual(84)
    expect(long.endsWith('.md')).toBe(true)
  })
})

// ── 下载触发（blob + <a download> + revoke；绝不 window.open） ───────────

describe('triggerNoteExportDownload', () => {
  it('creates and clicks an anchor then revokes the object URL', () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click: vi.fn(),
    }
    const appendChild = vi.fn()
    const removeChild = vi.fn()
    const doc = {
      createElement: vi.fn(() => anchor),
      body: { appendChild, removeChild },
      documentElement: { appendChild, removeChild },
    } as unknown as Document
    const createObjectURL = vi.fn(() => 'blob:export-file')
    const revokeObjectURL = vi.fn()
    const scheduled: Array<() => void> = []

    const ok = triggerNoteExportDownload(
      new Blob(['# body'], { type: 'text/markdown' }),
      '笔记.md',
      {
        document: doc,
        createObjectURL,
        revokeObjectURL,
        scheduleRevoke: (callback) => scheduled.push(callback),
      },
    )

    expect(ok).toBe(true)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(anchor.download).toBe('笔记.md')
    expect(anchor.href).toBe('blob:export-file')
    expect(anchor.rel).toBe('noopener')
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(removeChild).toHaveBeenCalledWith(anchor)
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export-file')
  })

  it('never opens a window/tab', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click: vi.fn(),
    }
    const doc = {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      documentElement: { appendChild: vi.fn(), removeChild: vi.fn() },
    } as unknown as Document
    triggerNoteExportDownload(new Blob(['x']), 'x.md', {
      document: doc,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: vi.fn(),
      scheduleRevoke: (callback) => callback(),
    })
    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('degrades to false when DOM/object URLs are unavailable (SSR/unsupported)', () => {
    expect(triggerNoteExportDownload(new Blob(['x']), 'x.md', { document: null })).toBe(false)
    const doc = {
      createElement: vi.fn(),
      body: null,
      documentElement: null,
    } as unknown as Document
    expect(
      triggerNoteExportDownload(new Blob(['x']), 'x.md', {
        document: doc,
        createObjectURL: null,
      }),
    ).toBe(false)
    expect(
      triggerNoteExportDownload(new Blob(['x']), 'x.md', {
        document: doc,
        createObjectURL: () => {
          throw new Error('no blob support')
        },
      }),
    ).toBe(false)
  })
})

// ── 完整流程编排 ───────────────────────────────────────────────────────

describe('runNoteExport', () => {
  const TITLE = '受保护笔记'
  const BLOB = new Blob(['# body'], { type: 'text/markdown' })

  function baseInput(transport: ReturnType<typeof fakeTransport>) {
    const download = vi.fn(() => true)
    return {
      download,
      input: {
        signature: signature(),
        title: TITLE,
        keyStore: createNoteExportKeyStore(),
        client: transport,
        download,
      },
    }
  }

  it('creates the export then downloads the response download_url verbatim', async () => {
    const transport = fakeTransport()
    transport.fetchExportFile.mockResolvedValue({ blob: BLOB, filename: '服务端名字.md' })
    const { input, download } = baseInput(transport)

    const outcome = await runNoteExport(input)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.filename).toBe('服务端名字.md')
    expect(outcome.exportId).toBe(EXPORT_ID)
    expect(transport.requestExport).toHaveBeenCalledWith({
      projectId: PROJECT,
      noteId: NOTE,
      body: { revision: 3, snapshot_hash: HASH, format: 'markdown' },
      idempotencyKey: expect.any(String),
    })
    expect(transport.fetchExportFile).toHaveBeenCalledWith(
      expectedExportDownloadPath(PROJECT, EXPORT_ID),
    )
    expect(download).toHaveBeenCalledWith(BLOB, '服务端名字.md')
  })

  it('uses the exact response download_url instead of rebuilding the path (M7)', async () => {
    const transport = fakeTransport()
    // 合法前缀但服务端带查询串：构造路径会丢掉查询串 → 本断言必须红。
    const returnedUrl = `${expectedExportDownloadPath(PROJECT, EXPORT_ID)}?download=1`
    transport.requestExport.mockResolvedValue({
      status: 201,
      data: exportPayload({ download_url: returnedUrl }),
    })
    const { input } = baseInput(transport)
    const outcome = await runNoteExport(input)
    expect(outcome.ok).toBe(true)
    expect(transport.fetchExportFile).toHaveBeenCalledWith(returnedUrl)
    expect(transport.fetchExportFile).not.toHaveBeenCalledWith(
      expectedExportDownloadPath(PROJECT, EXPORT_ID),
    )
  })

  it('uses the local <title>.md fallback when the server filename is unreadable', async () => {
    const transport = fakeTransport()
    transport.fetchExportFile.mockResolvedValue({ blob: BLOB, filename: null })
    const { input, download } = baseInput(transport)
    const outcome = await runNoteExport(input)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.filename).toBe(`${TITLE}.md`)
    expect(download).toHaveBeenCalledWith(BLOB, `${TITLE}.md`)
  })

  it('reuses the same idempotency key for same-signature retries (503 then replay 200)', async () => {
    const transport = fakeTransport()
    transport.requestExport
      .mockRejectedValueOnce(axiosError(503, { code: 'note_store_unavailable', message: 'm', retryable: true }))
      .mockResolvedValueOnce({ status: 200, data: exportPayload({ replayed: true }) })
    const { input } = baseInput(transport)

    const first = await runNoteExport(input)
    expect(first.ok).toBe(false)
    const second = await runNoteExport(input)
    expect(second.ok).toBe(true)

    const firstKey = (transport.requestExport.mock.calls[0][0] as { idempotencyKey: string })
      .idempotencyKey
    const secondKey = (transport.requestExport.mock.calls[1][0] as { idempotencyKey: string })
      .idempotencyKey
    expect(secondKey).toBe(firstKey)
  })

  it('rotates the idempotency key when revision/snapshot_hash change', async () => {
    const transport = fakeTransport()
    transport.requestExport.mockRejectedValue(
      axiosError(503, { code: 'note_store_unavailable', message: 'm', retryable: true }),
    )
    const keyStore = createNoteExportKeyStore()
    const download = vi.fn(() => true)
    await runNoteExport({
      signature: signature(),
      title: TITLE,
      keyStore,
      client: transport,
      download,
    })
    await runNoteExport({
      signature: signature({ revision: 4, snapshotHash: HASH2 }),
      title: TITLE,
      keyStore,
      client: transport,
      download,
    })
    const firstKey = (transport.requestExport.mock.calls[0][0] as { idempotencyKey: string })
      .idempotencyKey
    const secondKey = (transport.requestExport.mock.calls[1][0] as { idempotencyKey: string })
      .idempotencyKey
    expect(secondKey).not.toBe(firstKey)
  })

  it('fails honestly on 409 export_request_conflict and rotates the key for the explicit retry', async () => {
    const transport = fakeTransport()
    transport.requestExport
      .mockRejectedValueOnce(
        axiosError(409, { code: 'export_request_conflict', message: 'm', retryable: false }),
      )
      .mockResolvedValueOnce({ status: 201, data: exportPayload() })
    const { input, download } = baseInput(transport)

    const first = await runNoteExport(input)
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.failure.kind).toBe('api')
    if (first.failure.kind !== 'api') return
    expect(first.failure.code).toBe('export_request_conflict')
    expect(download).not.toHaveBeenCalled()

    const second = await runNoteExport(input)
    expect(second.ok).toBe(true)
    const firstKey = (transport.requestExport.mock.calls[0][0] as { idempotencyKey: string })
      .idempotencyKey
    const secondKey = (transport.requestExport.mock.calls[1][0] as { idempotencyKey: string })
      .idempotencyKey
    expect(secondKey).not.toBe(firstKey)
  })

  it('rejects 409 note_revision_conflict / note_edit_schema_unsupported as failures', async () => {
    for (const code of ['note_revision_conflict', 'note_edit_schema_unsupported'] as const) {
      const transport = fakeTransport()
      transport.requestExport.mockRejectedValue(
        axiosError(409, { code, message: 'm', retryable: false }),
      )
      const { input } = baseInput(transport)
      const outcome = await runNoteExport(input)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.failure).toMatchObject({ kind: 'api', code })
      expect(transport.fetchExportFile).not.toHaveBeenCalled()
    }
  })

  it('does not fetch or download when the create response is malformed', async () => {
    const transport = fakeTransport()
    transport.requestExport.mockResolvedValue({
      status: 201,
      data: exportPayload({ export_id: 'exp_legacy' }),
    })
    const { input, download } = baseInput(transport)
    const outcome = await runNoteExport(input)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('invalid_response')
    expect(transport.fetchExportFile).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('does not download when a replayed response download_url points elsewhere', async () => {
    const transport = fakeTransport()
    transport.requestExport.mockResolvedValue({
      status: 200,
      data: exportPayload({
        replayed: true,
        download_url: '/v1/research/projects/other/export/nex_x/file',
      }),
    })
    const { input, download } = baseInput(transport)
    const outcome = await runNoteExport(input)
    expect(outcome.ok).toBe(false)
    expect(transport.fetchExportFile).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('maps download-phase 403/404 to stable codes and never claims success', async () => {
    const forbidden = fakeTransport()
    forbidden.fetchExportFile.mockRejectedValue(axiosError(403, undefined))
    const outcome403 = await runNoteExport(baseInput(forbidden).input)
    expect(outcome403.ok).toBe(false)
    if (!outcome403.ok) expect(outcome403.failure).toMatchObject({ kind: 'api', code: 'note_access_restricted' })

    const gone = fakeTransport()
    gone.fetchExportFile.mockRejectedValue(axiosError(404, undefined))
    const outcome404 = await runNoteExport(baseInput(gone).input)
    expect(outcome404.ok).toBe(false)
    if (!outcome404.ok) expect(outcome404.failure).toMatchObject({ kind: 'api', code: 'export_not_found' })
  })

  it('reports download_unavailable when the browser cannot start the download', async () => {
    const transport = fakeTransport()
    const { input } = baseInput(transport)
    const outcome = await runNoteExport({ ...input, download: () => false })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('download_unavailable')
  })

  it('keeps the same key after a malformed response (result unknown, retry is safe)', async () => {
    const transport = fakeTransport()
    transport.requestExport
      .mockResolvedValueOnce({ status: 201, data: { export_id: 'nex_zzz' } })
      .mockResolvedValueOnce({ status: 201, data: exportPayload() })
    const { input } = baseInput(transport)
    await runNoteExport(input)
    const second = await runNoteExport(input)
    expect(second.ok).toBe(true)
    const firstKey = (transport.requestExport.mock.calls[0][0] as { idempotencyKey: string })
      .idempotencyKey
    const secondKey = (transport.requestExport.mock.calls[1][0] as { idempotencyKey: string })
      .idempotencyKey
    expect(secondKey).toBe(firstKey)
  })
})

// 未使用的类型导出保持编译覆盖（leave reason 供 hook/组件映射）。
export type { NoteLeaveBlockReason }
