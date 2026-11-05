/**
 * d2-v1 Note API 传输层单测（Issue #1046 PR4 / D2-B2）。
 *
 * 覆盖：d2-v1 契约头与路径（含 encodeURIComponent）、响应防御性归一化、
 * 错误包络归一（409 带 current_revision/current_snapshot_hash、网络、未知码、
 * 旧字符串 detail）、畸形回执按「结果未知」上报、copies/enable-editing 形状、
 * mutation_id 形状。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/lib/api/client'
import {
  copyNoteD2,
  createNoteD2,
  deleteNoteD2,
  enableNoteEditingD2,
  getNoteD2,
  isNoteApiError,
  isNoteErrorCode,
  listNotesD2,
  newNoteMutationId,
  normalizeNoteApiError,
  normalizeNoteD2,
  normalizeNotePage,
  normalizeNoteReceipt,
  saveNoteD2,
} from './note-client'
import { NOTE_CONTRACT_HEADER, NOTE_CONTRACT_VALUE } from './types'

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
const HASH = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)

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
    response: { status, data: { detail }, headers },
  }
}

const RECEIPT = {
  note_id: 'note_1',
  mutation_id: 'nm1',
  applied_revision: 2,
  snapshot_hash: HASH2,
  saved_at: '2026-11-05T02:50:52.748Z',
  replayed: false,
}

const NOTE = {
  note_id: 'note_1',
  project_id: 'proj_1',
  title: 'T',
  content: '# body',
  note_type: 'human',
  created_at: null,
  updated_at: '2026-11-05T02:50:52.748Z',
  revision: 2,
  snapshot_hash: HASH2,
  edit_schema: 'd2-v1',
  access_state: 'visible',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listNotesD2 / getNoteD2', () => {
  it('sends d2-v1 note contract header and encodes project/note ids', async () => {
    mocked.get.mockResolvedValueOnce(
      jsonResponse({ items: [NOTE], next_cursor: null }),
    )
    const page = await listNotesD2('proj/one', { q: 'mk', limit: 100 })
    expect(mocked.get).toHaveBeenCalledWith(
      '/v1/research/projects/proj%2Fone/notes',
      expect.objectContaining({
        params: { q: 'mk', limit: 100 },
        headers: { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE },
      }),
    )
    expect(page.items).toHaveLength(1)
    expect(page.items[0].revision).toBe(2)
    expect(page.items[0].edit_schema).toBe('d2-v1')
    expect(page.items[0].access_state).toBe('visible')
    expect(page.next_cursor).toBeNull()
  })

  it('normalizes legacy (no protection keys) rows to unprotected/null projection', () => {
    const page = normalizeNotePage({
      items: [
        {
          note_id: 'legacy',
          project_id: 'p',
          title: 'old',
          content: 'c',
          note_type: 'human',
          created_at: null,
          updated_at: null,
        },
      ],
      next_cursor: 'cursor_2',
    })
    expect(page.items[0]).toMatchObject({
      edit_schema: null,
      revision: null,
      snapshot_hash: null,
      access_state: null,
    })
    expect(page.next_cursor).toBe('cursor_2')
  })

  it('normalizes restricted placeholder without leaking title/content as text', () => {
    const note = normalizeNoteD2({
      note_id: 'n',
      project_id: 'p',
      title: null,
      content: null,
      note_type: 'human',
      created_at: null,
      updated_at: null,
      revision: null,
      snapshot_hash: null,
      edit_schema: 'd2-v1',
      access_state: 'restricted',
    })
    expect(note.title).toBe('')
    expect(note.content).toBe('')
    expect(note.access_state).toBe('restricted')
  })

  it('rejects malformed list payloads as protocol errors', () => {
    expect(() => normalizeNotePage({ items: 'nope' })).toThrow()
    expect(() => normalizeNoteD2({ note_id: 123 })).toThrow()
  })

  it('throws a normalized NoteApiError for malformed payloads', () => {
    try {
      normalizeNotePage({ items: 'nope' })
    } catch (error) {
      const apiError = normalizeNoteApiError(error)
      expect(apiError.code).toBe('unknown_error')
      expect(apiError.retryable).toBe(true)
    }
  })

  it('getNoteD2 encodes note id and passes AbortSignal', async () => {
    mocked.get.mockResolvedValueOnce(jsonResponse(NOTE))
    const controller = new AbortController()
    const note = await getNoteD2('p', 'note/1', controller.signal)
    expect(note.note_id).toBe('note_1')
    expect(mocked.get).toHaveBeenCalledWith(
      '/v1/research/projects/p/notes/note%2F1',
      expect.objectContaining({
        signal: controller.signal,
        headers: { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE },
      }),
    )
  })
})

describe('mutation endpoints', () => {
  it('createNoteD2 posts mutation body and parses receipt', async () => {
    mocked.post.mockResolvedValueOnce(jsonResponse(RECEIPT, 201))
    const receipt = await createNoteD2('p', { mutation_id: 'nm1', title: 'T', content: 'c' })
    expect(mocked.post).toHaveBeenCalledWith(
      '/v1/research/projects/p/notes',
      { mutation_id: 'nm1', title: 'T', content: 'c' },
      { headers: { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE } },
    )
    expect(receipt).toEqual(RECEIPT)
  })

  it('saveNoteD2 patches full snapshot with expected_revision', async () => {
    mocked.patch.mockResolvedValueOnce(jsonResponse(RECEIPT))
    await saveNoteD2('p', 'n1', {
      mutation_id: 'nm2',
      expected_revision: 1,
      title: 'T2',
      content: 'c2',
    })
    expect(mocked.patch).toHaveBeenCalledWith(
      '/v1/research/projects/p/notes/n1',
      {
        mutation_id: 'nm2',
        expected_revision: 1,
        title: 'T2',
        content: 'c2',
      },
      { headers: { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE } },
    )
  })

  it('deleteNoteD2 sends revision CAS body through DELETE data', async () => {
    mocked.delete.mockResolvedValueOnce(
      jsonResponse({ ...RECEIPT, snapshot_hash: null }),
    )
    const receipt = await deleteNoteD2('p', 'n1', {
      mutation_id: 'nm3',
      expected_revision: 4,
    })
    expect(mocked.delete).toHaveBeenCalledWith(
      '/v1/research/projects/p/notes/n1',
      {
        data: { mutation_id: 'nm3', expected_revision: 4 },
        headers: { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE },
      },
    )
    expect(receipt.snapshot_hash).toBeNull()
  })

  it('enableNoteEditingD2 parses {note, receipt:null}', async () => {
    mocked.post.mockResolvedValueOnce(
      jsonResponse({ note: { ...NOTE, edit_schema: 'd2-v1' }, receipt: null }),
    )
    const result = await enableNoteEditingD2('p', 'n1', { mutation_id: 'nm4' })
    expect(result.receipt).toBeNull()
    expect(result.note.edit_schema).toBe('d2-v1')
    expect(mocked.post).toHaveBeenCalledWith(
      '/v1/research/projects/p/notes/n1/editing',
      { mutation_id: 'nm4' },
      { headers: { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE } },
    )
  })

  it('copyNoteD2 posts local-draft baseline copy request', async () => {
    mocked.post.mockResolvedValueOnce(jsonResponse(RECEIPT, 201))
    const receipt = await copyNoteD2('p', 'n1', {
      mutation_id: 'nm5',
      source_revision: 3,
      source_snapshot_hash: HASH,
      title: 'T',
      content: 'local',
    })
    expect(mocked.post).toHaveBeenCalledWith(
      '/v1/research/projects/p/notes/n1/copies',
      {
        mutation_id: 'nm5',
        source_revision: 3,
        source_snapshot_hash: HASH,
        title: 'T',
        content: 'local',
      },
      { headers: { [NOTE_CONTRACT_HEADER]: NOTE_CONTRACT_VALUE } },
    )
    expect(receipt.note_id).toBe('note_1')
  })

  it('rejects malformed receipts (must not be treated as success)', () => {
    expect(() => normalizeNoteReceipt({ ...RECEIPT, replayed: 'no' })).toThrow()
    expect(() => normalizeNoteReceipt({ ...RECEIPT, applied_revision: 0 })).toThrow()
    expect(() => normalizeNoteReceipt({ ...RECEIPT, snapshot_hash: 'xyz' })).toThrow()
    expect(() =>
      normalizeNoteReceipt({ ...RECEIPT, saved_at: undefined }),
    ).toThrow()
  })
})

describe('normalizeNoteApiError', () => {
  it('maps 409 conflict envelope with current revision/hash and request id', () => {
    const apiError = normalizeNoteApiError(
      axiosError(
        409,
        {
          code: 'note_revision_conflict',
          message: 'revision mismatch',
          retryable: false,
          request_id: 'req_9',
          current_revision: 7,
          current_snapshot_hash: HASH,
        },
        { 'x-request-id': 'header_req' },
      ),
    )
    expect(apiError).toMatchObject({
      code: 'note_revision_conflict',
      retryable: false,
      status: 409,
      requestId: 'req_9',
      currentRevision: 7,
      currentSnapshotHash: HASH,
    })
    expect(isNoteApiError(apiError)).toBe(true)
  })

  it('does not leak non-hex/out-of-range conflict detail values', () => {
    const apiError = normalizeNoteApiError(
      axiosError(409, {
        code: 'note_revision_conflict',
        message: 'x',
        retryable: false,
        current_revision: 0,
        current_snapshot_hash: 'NOT_A_HASH',
      }),
    )
    expect(apiError.currentRevision).toBeUndefined()
    expect(apiError.currentSnapshotHash).toBeUndefined()
  })

  it('normalizes network errors to retryable network_error', () => {
    const apiError = normalizeNoteApiError(new Error('Network Error'))
    expect(apiError).toMatchObject({ code: 'network_error', retryable: true, status: 0 })
  })

  it('normalizes unknown wire codes without inventing conflict semantics', () => {
    const apiError = normalizeNoteApiError(
      axiosError(409, { code: 'some_future_code', message: 'm', retryable: false }),
    )
    expect(apiError.code).toBe('unknown_error')
    expect(apiError.retryable).toBe(false)
  })

  it('infers stable codes for unambiguous HTTP status only', () => {
    expect(normalizeNoteApiError(axiosError(404, {})).code).toBe('note_not_found')
    expect(normalizeNoteApiError(axiosError(403, 'forbidden')).code).toBe(
      'note_access_restricted',
    )
    expect(normalizeNoteApiError(axiosError(428, {})).code).toBe('note_revision_required')
    expect(normalizeNoteApiError(axiosError(500, {})).code).toBe('unknown_error')
    expect(normalizeNoteApiError(axiosError(500, {})).retryable).toBe(true)
  })

  it('passes already-normalized errors through unchanged', () => {
    const original = {
      code: 'note_store_unavailable' as const,
      message: 'm',
      retryable: true,
      status: 503,
    }
    expect(normalizeNoteApiError(original)).toBe(original)
  })

  it('isNoteErrorCode only accepts contract codes', () => {
    expect(isNoteErrorCode('note_revision_conflict')).toBe(true)
    expect(isNoteErrorCode('editor_revision_conflict')).toBe(false)
    expect(isNoteErrorCode(42)).toBe(false)
  })
})

describe('newNoteMutationId', () => {
  it('matches contract stable id pattern and is unique', () => {
    const first = newNoteMutationId()
    const second = newNoteMutationId()
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(first).not.toBe(second)
  })
})
