/**
 * Issue #601 PR5（C6）：SearchPanel C-05 接线测试（T2/T3/T11/T25/T27 面板面）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import * as researchApi from '@/lib/research/api'
import { monotonicNow } from '@/lib/research/c05-key-retention'
import type { ResearchModelOption } from '@/lib/research/types'

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    searchV1: vi.fn(),
    fetchContextPreview: vi.fn(),
    listModels: vi.fn(),
  }
})

vi.mock('@/lib/hooks/use-research-global-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/use-research-global-model')>()
  return {
    ...actual,
    useResearchGlobalModel: () => ({
      confirmedModelId: 'm-local',
      confirmedModel: {
        model_id: 'm-local', display_name: 'Local', provider_id: 'p1',
        provider_is_external: false, data_egress: false,
        interactive_context_levels: ['focused', 'document', 'workspace'],
      } as unknown as ResearchModelOption,
      searchContextDefault: 'focused' as const,
      saveSearchContext: vi.fn(),
      canExecute: true,
      blockedReason: 'none' as const,
      needsConsent: false,
      isSavingModel: false,
      invalidateConsent: vi.fn(),
      runGuarded: async (op: (m: string) => unknown) => op('m-local'),
    }),
    researchModelBlockedHint: () => null,
  }
})

function seedScopeAll(): void {
  localStorage.setItem(
    scopeStorageKey('u1', 'proj_1'),
    JSON.stringify({ version: 1, mode: 'all', sourceIds: [], noteIds: [] }),
  )
}

function seedScopeSelected(ids: string[]): void {
  localStorage.setItem(
    scopeStorageKey('u1', 'proj_1'),
    JSON.stringify({ version: 1, mode: 'selected', sourceIds: ids, noteIds: [] }),
  )
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="u1">
        <ResearchJobsProvider>
          <ResearchScopeProvider userId="u1" projectId="proj_1">
            {children}
          </ResearchScopeProvider>
        </ResearchJobsProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

function c05Caps(enabled: boolean, searchReady = true) {
  return {
    contract: 'c05-v1',
    enabled,
    preview_supported: false,
    entries: {
      search: {
        scope_modes: enabled ? ['all', 'selected', 'single'] : [],
        execution_modes: enabled && searchReady ? ['auto', 'direct_context', 'hybrid_rag', 'planned_rag', 'deep_compare'] : [],
        context_levels: enabled && searchReady ? ['focused', 'document', 'workspace'] : [],
        preview_supported: false,
        execution_ready: enabled && searchReady,
        unavailable_reason: enabled ? (searchReady ? null : 'c05_entry_not_wired') : 'c05_contract_disabled',
      },
      chat: { scope_modes: [], execution_modes: [], context_levels: [], preview_supported: false, execution_ready: false, unavailable_reason: 'c05_entry_not_wired' },
      coverage: { scope_modes: [], execution_modes: [], context_levels: [], preview_supported: false, execution_ready: false, unavailable_reason: 'c05_entry_not_wired' },
      compare: { scope_modes: [], execution_modes: [], context_levels: [], preview_supported: false, execution_ready: false, unavailable_reason: 'c05_entry_not_wired' },
      ai_insight: { scope_modes: [], execution_modes: [], context_levels: [], preview_supported: false, execution_ready: false, unavailable_reason: 'c05_entry_not_wired' },
      transformation: { scope_modes: [], execution_modes: [], context_levels: [], preview_supported: false, execution_ready: false, unavailable_reason: 'c05_entry_not_wired' },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(researchApi.listModels).mockResolvedValue({
    models: [], capabilities: { coverage_all_selected: false, c05: c05Caps(true) },
  })
})
afterEach(cleanup)

const directResult = {
  request_id: 'r1', resolved_mode: 'direct_context',
  evidence: [], citations: [],
  usage: { input_tokens: 1, output_tokens: 1, estimated: true },
  degradation_reason: null, conclusion: 'ok',
}

describe('ResearchSearchPanel C-05（C6）', () => {
  it('T3：all 下派发 → C-05 形状（source_scope.mode=all、无顶层 source_ids）+ c05-v1 头', async () => {
    seedScopeAll()
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q1' } })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    const [projectId, body, options] = vi.mocked(researchApi.searchV1).mock.calls[0]
    expect(projectId).toBe('proj_1')
    expect(body).toMatchObject({
      query: 'q1', model_id: 'm-local', mode: 'auto',
      source_scope: { mode: 'all', source_ids: [], single_source_id: null },
      note_ids: [],
    })
    expect((body as unknown as Record<string, unknown>).source_ids).toBeUndefined()
    expect(options?.contract).toBe('c05-v1')
    expect(typeof options?.idempotencyKey).toBe('string')
  })

  it('T3：selected 下 C-05 就绪 → source_scope 携带显式集合', async () => {
    seedScopeSelected(['src_1', 'src_2'])
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q2' } })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    const body = vi.mocked(researchApi.searchV1).mock.calls[0][1] as unknown as Record<string, unknown>
    expect(body.source_scope).toEqual({ mode: 'selected', source_ids: ['src_1', 'src_2'], single_source_id: null })
  })

  it('T2：能力假 → 旧契约（v1 头 + 顶层 source_ids）', async () => {
    seedScopeSelected(['src_1'])
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [], capabilities: { coverage_all_selected: false, c05: c05Caps(false) },
    })
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q3' } })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    const [, body, options] = vi.mocked(researchApi.searchV1).mock.calls[0]
    expect(options?.contract).toBeUndefined()
    expect((body as unknown as Record<string, unknown>).source_ids).toEqual(['src_1'])
    expect((body as unknown as Record<string, unknown>).source_scope).toBeUndefined()
  })

  it('T27：同提交网络失败重试复用原键；完成后同题重跑新键', async () => {
    seedScopeAll()
    vi.mocked(researchApi.searchV1)
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { response: undefined }))
      .mockResolvedValueOnce({ kind: 'direct', result: directResult })
      .mockResolvedValueOnce({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q4' } })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    const key1 = vi.mocked(researchApi.searchV1).mock.calls[0][2]?.idempotencyKey
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(2))
    expect(vi.mocked(researchApi.searchV1).mock.calls[1][2]?.idempotencyKey).toBe(key1)
    // 第二次成功（确定性完成）→ 同题重跑必须新键
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(3))
    expect(vi.mocked(researchApi.searchV1).mock.calls[2][2]?.idempotencyKey).not.toBe(key1)
  })

  it('T10：preview_supported=false → 不发 Preview 请求', async () => {
    seedScopeAll()
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q5' } })
    await new Promise((r) => setTimeout(r, 500))
    expect(researchApi.fetchContextPreview).not.toHaveBeenCalled()
  })

  it('T11：all 下 document 档位收敛到 focused（scope 归因提示）', async () => {
    seedScopeAll()
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    await screen.findByTestId('search-input')
    fireEvent.change(screen.getByTestId('context-select'), { target: { value: 'document' } })
    await waitFor(() => {
      expect(screen.getByTestId('document-needs-sources-hint')).toBeInTheDocument()
    })
  })
})
