/**
 * 成果目录 hook 单测（Issue #1046 PR4 / D2-B2）。
 *
 * 覆盖：d2-v1 列表请求（契约头在 note-client 单测覆盖）、分页合并、
 * 搜索词透传与查询键隔离、独立于旧 headless 列表的 'd2-v1' 缓存段、
 * 工作台身份段、错误归一、refresh。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { QUERY_KEYS, ownerResearchIdentity, researchQueryKey } from '@/lib/api/query-client'
import { listNotesD2 } from './note-client'
import { noteCatalogQueryKey, useNoteCatalog } from './use-note-catalog'
import type { ResearchNoteD2 } from './types'

vi.mock('./note-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('./note-client')>()
  return { ...original, listNotesD2: vi.fn() }
})

const mockedList = vi.mocked(listNotesD2)
const PROJECT = 'proj_1'

function noteItem(noteId: string, overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: noteId,
    project_id: PROJECT,
    title: `Title ${noteId}`,
    content: `Content ${noteId}`,
    note_type: 'human',
    created_at: null,
    updated_at: null,
    revision: 1,
    snapshot_hash: 'a'.repeat(64),
    edit_schema: 'd2-v1',
    access_state: 'visible',
    ...overrides,
  }
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
}

function wrapper(client: QueryClient, workspace = true) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const content = workspace ? (
      <ResearchWorkspaceProvider
        projectId={PROJECT}
        role="owner"
        userId="7"
        authGeneration={1}
      >
        {children}
      </ResearchWorkspaceProvider>
    ) : (
      children
    )
    return <QueryClientProvider client={client}>{content}</QueryClientProvider>
  }
}

beforeEach(() => {
  mockedList.mockReset()
})

describe('noteCatalogQueryKey', () => {
  it('keeps the research notes prefix but isolates the d2-v1 representation', () => {
    const withoutIdentity = noteCatalogQueryKey(PROJECT, '', null)
    expect(withoutIdentity.slice(0, 5)).toEqual(['research', PROJECT, 'notes', 'd2-v1', ''])
    expect(withoutIdentity.slice(0, 3)).toEqual(
      [...QUERY_KEYS.researchNotes(PROJECT)].slice(0, 3),
    )
    const withIdentity = noteCatalogQueryKey(
      PROJECT,
      'q',
      ownerResearchIdentity(PROJECT, '7', 1),
    )
    expect(withIdentity).toEqual(
      researchQueryKey(ownerResearchIdentity(PROJECT, '7', 1), 'notes', 'd2-v1', 'q'),
    )
    expect(withIdentity).not.toEqual(noteCatalogQueryKey(PROJECT, 'q', null))
  })
})

describe('useNoteCatalog', () => {
  it('loads the d2-v1 catalog (both legacy and protected rows) inside the workspace', async () => {
    mockedList.mockResolvedValue({
      items: [
        noteItem('n1'),
        noteItem('legacy', { edit_schema: null, revision: null, snapshot_hash: null }),
        noteItem('restricted', {
          title: '',
          content: '',
          access_state: 'restricted',
          revision: null,
          snapshot_hash: null,
        }),
      ],
      next_cursor: null,
    })
    const client = createClient()
    const { result } = renderHook(
      () => useNoteCatalog({ projectId: PROJECT, search: '' }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.items).toHaveLength(3))
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.items[1].edit_schema).toBeNull()
    expect(result.current.items[2].access_state).toBe('restricted')
    expect(mockedList).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ limit: 100 }),
      expect.any(AbortSignal),
    )
    const identityKey = researchQueryKey(
      ownerResearchIdentity(PROJECT, '7', 1),
      'notes',
      'd2-v1',
      '',
    )
    expect(client.getQueryData(identityKey)).toBeDefined()
    // 不得与旧 headless 列表（无 d2-v1 段）共享缓存。
    expect(client.getQueryData(QUERY_KEYS.researchNotes(PROJECT))).toBeUndefined()
  })

  it('passes the lexical search as q and keeps search variants in separate keys', async () => {
    mockedList.mockResolvedValue({ items: [noteItem('n1')], next_cursor: null })
    const client = createClient()
    const { result, rerender } = renderHook(
      ({ search }: { search: string }) =>
        useNoteCatalog({ projectId: PROJECT, search }),
      { wrapper: wrapper(client), initialProps: { search: 'mk' } },
    )
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(mockedList).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ q: 'mk' }),
      expect.any(AbortSignal),
    )
    rerender({ search: 'mk2' })
    await waitFor(() =>
      expect(mockedList).toHaveBeenCalledWith(
        PROJECT,
        expect.objectContaining({ q: 'mk2' }),
        expect.any(AbortSignal),
      ),
    )
  })

  it('collects all cursor pages and de-duplicates items', async () => {
    mockedList
      .mockResolvedValueOnce({ items: [noteItem('n1')], next_cursor: 'c1' })
      .mockResolvedValueOnce({ items: [noteItem('n1'), noteItem('n2')], next_cursor: null })
    const client = createClient()
    const { result } = renderHook(
      () => useNoteCatalog({ projectId: PROJECT, search: '' }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.items.map((item) => item.note_id)).toEqual(['n1', 'n2'])
  })

  it('normalizes catalog errors to NoteApiError', async () => {
    mockedList.mockRejectedValue({
      response: {
        status: 403,
        data: { detail: { code: 'note_access_restricted', message: 'x', retryable: false } },
      },
    })
    const client = createClient()
    const { result } = renderHook(
      () => useNoteCatalog({ projectId: PROJECT, search: '' }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error?.code).toBe('note_access_restricted')
    expect(result.current.items).toEqual([])
  })

  it('refresh re-fetches the catalog', async () => {
    mockedList
      .mockResolvedValueOnce({ items: [noteItem('n1')], next_cursor: null })
      .mockResolvedValueOnce({
        items: [noteItem('n1'), noteItem('n2')],
        next_cursor: null,
      })
    const client = createClient()
    const { result } = renderHook(
      () => useNoteCatalog({ projectId: PROJECT, search: '' }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    await result.current.refresh()
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(mockedList).toHaveBeenCalledTimes(2)
  })
})
