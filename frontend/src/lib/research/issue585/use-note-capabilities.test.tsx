/**
 * 能力投影 hook 单测（Issue #1046 PR4 / D2-B2，Lead D4 / 方案 §8.2）。
 *
 * 覆盖：snake_case → camelCase 解析、缺失/畸形 fail-closed、/models 失败
 * 返回 null + error（UI 阻断，不推断）、复用既有 /models 查询键（共享缓存，
 * 零额外请求）、工作台身份段、refresh 重新请求。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { QUERY_KEYS, ownerResearchIdentity, researchModelCatalogIdentityKey } from '@/lib/api/query-client'
import { listModels } from '@/lib/research/api'
import { readNoteCapabilities, useNoteCapabilities } from './use-note-capabilities'

vi.mock('@/lib/research/api', () => ({
  listModels: vi.fn(),
}))

const mockedListModels = vi.mocked(listModels)
const PROJECT = 'proj_1'

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
}

function wrapper(client: QueryClient, options: { workspace?: boolean } = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const content = options.workspace === false ? (
      children
    ) : (
      <ResearchWorkspaceProvider
        projectId={PROJECT}
        role="owner"
        userId="7"
        authGeneration={1}
      >
        {children}
      </ResearchWorkspaceProvider>
    )
    return <QueryClientProvider client={client}>{content}</QueryClientProvider>
  }
}

function rawCapabilities() {
  return {
    note_editor: { available: true, reason: null },
    note_editor_existing: { available: true, reason: null },
    markdown_export: { available: false, reason: 'not_ready' },
    writing_local: { available: false, reason: 'not_ready' },
    writing_external: { available: false, reason: 'not_ready' },
  }
}

beforeEach(() => {
  mockedListModels.mockReset()
})

describe('readNoteCapabilities', () => {
  it('maps raw snake_case capability keys to the frozen camelCase projection', () => {
    const capabilities = readNoteCapabilities(rawCapabilities())
    expect(capabilities.noteEditor).toEqual({ available: true, reason: null })
    expect(capabilities.noteEditorExisting).toEqual({ available: true, reason: null })
    expect(capabilities.markdownExport).toEqual({ available: false, reason: 'not_ready' })
    expect(capabilities.writingLocal).toEqual({ available: false, reason: 'not_ready' })
    expect(capabilities.writingExternal).toEqual({ available: false, reason: 'not_ready' })
  })

  it('fails closed on missing/malformed keys without inventing availability', () => {
    const capabilities = readNoteCapabilities({
      note_editor: { available: 'yes' },
      note_editor_existing: null,
      markdown_export: {},
    })
    expect(capabilities.noteEditor).toEqual({
      available: false,
      reason: 'capability_unknown',
    })
    expect(capabilities.noteEditorExisting.available).toBe(false)
    expect(capabilities.markdownExport.available).toBe(false)
    expect(readNoteCapabilities(undefined).noteEditor.available).toBe(false)
  })

  it('keeps server growth reasons for disabled capabilities', () => {
    const capabilities = readNoteCapabilities({
      note_editor: { available: false, reason: 'disabled_by_flag' },
      note_editor_existing: { available: false, reason: 'note_store_unavailable' },
    })
    expect(capabilities.noteEditor.reason).toBe('disabled_by_flag')
    expect(capabilities.noteEditorExisting.reason).toBe('note_store_unavailable')
  })
})

describe('useNoteCapabilities', () => {
  it('reads capabilities from the existing /models response', async () => {
    mockedListModels.mockResolvedValue({
      models: [],
      capabilities: rawCapabilities(),
    } as never)
    const client = createClient()
    const { result } = renderHook(() => useNoteCapabilities(PROJECT), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.capabilities).not.toBeNull())
    expect(result.current.capabilities?.noteEditorExisting.available).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('reuses the existing query key (shared cache, no extra request)', async () => {
    const client = createClient()
    client.setQueryData(QUERY_KEYS.researchModelCatalog(PROJECT), {
      models: [],
      capabilities: rawCapabilities(),
    })
    const { result } = renderHook(() => useNoteCapabilities(PROJECT), {
      wrapper: wrapper(client, { workspace: false }),
    })
    await waitFor(() => expect(result.current.capabilities).not.toBeNull())
    expect(mockedListModels).not.toHaveBeenCalled()
    expect(result.current.capabilities?.noteEditor.available).toBe(true)
  })

  it('uses the workspace identity query key when inside the workspace', async () => {
    mockedListModels.mockResolvedValue({
      models: [],
      capabilities: rawCapabilities(),
    } as never)
    const client = createClient()
    const { result } = renderHook(() => useNoteCapabilities(PROJECT), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.capabilities).not.toBeNull())
    const identityKey = researchModelCatalogIdentityKey(
      ownerResearchIdentity(PROJECT, '7', 1),
    )
    expect(client.getQueryData(identityKey)).toBeDefined()
  })

  it('fail-closes to null on /models failure (no environment inference)', async () => {
    mockedListModels.mockRejectedValue(new Error('models down'))
    const client = createClient()
    const { result } = renderHook(() => useNoteCapabilities(PROJECT), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.capabilities).toBeNull()
    expect(result.current.error?.code).toBe('network_error')
  })

  it('refresh triggers a new /models request', async () => {
    mockedListModels
      .mockResolvedValueOnce({ models: [], capabilities: rawCapabilities() } as never)
      .mockResolvedValueOnce({
        models: [],
        capabilities: {
          ...rawCapabilities(),
          note_editor: { available: false, reason: 'disabled_by_flag' },
        },
      } as never)
    const client = createClient()
    const { result } = renderHook(() => useNoteCapabilities(PROJECT), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.capabilities?.noteEditor.available).toBe(true))
    result.current.refresh()
    await waitFor(() => expect(result.current.capabilities?.noteEditor.available).toBe(false))
    expect(mockedListModels).toHaveBeenCalledTimes(2)
  })
})
