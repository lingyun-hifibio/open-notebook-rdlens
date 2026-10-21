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
import { QUERY_KEYS } from '@/lib/api/query-client'
import { act } from '@testing-library/react'
import type { ResearchModelOption } from '@/lib/research/types'

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    searchV1: vi.fn(),
    fetchContextPreview: vi.fn(),
    fetchC05Preview: vi.fn(),
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

let activeQueryClient: QueryClient | null = null

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  activeQueryClient = queryClient
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

function c05Caps(enabled: boolean, searchReady = true, previewSupported = false) {
  return {
    contract: 'c05-v1',
    enabled,
    preview_supported: previewSupported,
    entries: {
      search: {
        scope_modes: enabled ? ['all', 'selected', 'single'] : [],
        execution_modes: enabled && searchReady ? ['auto', 'direct_context', 'hybrid_rag', 'planned_rag', 'deep_compare'] : [],
        context_levels: enabled && searchReady ? ['focused', 'document', 'workspace'] : [],
        preview_supported: previewSupported,
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

/** #748 `c05_preview_response` 的合法最小形状（预算 exceeded，供门禁行为测试）。 */
function previewExceeded() {
  return {
    scope_contract_version: 'c05-v1',
    resolved_scope: {
      mode: 'all', contract_version: 'c05-v1', resolved_source_refs: [],
      note_ids: [], single_source_id: null, missing_source_ids: [],
      includes_exact_versions: true, contains_document_body: false, warnings: [],
    },
    availability: { source_versions: 0, chunks: 0, requested_notes: 0, nonempty_notes: 0 },
    budget: {
      status: 'exceeded',
      checks: [{
        name: 'known_input', path: 'selected', unit: 'tokens', phase: 'preflight',
        required: true, status: 'exceeded', observed: 5_000_000,
        limit: 4_000_000, limit_source: 'model_window/admission/reserves',
      }],
      deferred: [],
      token_estimate: null,
      estimate_kind: 'source_and_note_units',
      resolved_mode: 'hybrid_rag',
      input_budget: 100,
    },
    execution_hint: 'interactive',
    needs_consent: false,
    warnings: [],
  }
}

/**
 * #748 `c05_preview_response` 的 validated 形状（`deferred[]` 可注入执行期检查）。
 * D-12（2026-10-22 收口）：validated + deferred → `execution_recheck` 提示；
 * validated 且 deferred 为空 → 无提示。
 */
function previewValidated(deferred: unknown[] = []) {
  return {
    ...previewExceeded(),
    budget: {
      status: 'validated',
      checks: [{
        name: 'known_input', path: 'selected', unit: 'tokens', phase: 'preflight',
        required: true, status: 'validated', observed: 1_000,
        limit: 4_000_000, limit_source: 'model_window/admission/reserves',
      }],
      deferred,
      token_estimate: 1_000,
      estimate_kind: 'source_and_note_units',
      resolved_mode: 'hybrid_rag',
      input_budget: 4_000_000,
    },
  }
}

/** 执行期检查（`deferred[]` 元素）——D-12 "执行期复检"提示的触发位。 */
function deferredExecutionCheck() {
  return {
    name: 'actual_prompt_tokens', path: 'selected', unit: 'tokens', phase: 'execution',
    required: false, status: 'deferred', observed: null, limit: null,
    limit_source: 'resolved_mode/prompt_budget',
  }
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
    expect(researchApi.fetchC05Preview).not.toHaveBeenCalled()
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

  // ── PR5（D-01/D-14/D-17）：投影**消费**接线（此前只解析不渲染） ──

  it('D-01：响应不携带投影 → 如实说明"服务端未返回范围详情"（不猜测、不显示计数）', async () => {
    seedScopeAll()
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-proj-absent' } })
    fireEvent.click(screen.getByTestId('search-run'))

    await waitFor(() => {
      expect(screen.getByTestId('scope-projection-missing')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('scope-warning-summary')).toBeNull()
    expect(screen.queryByTestId('scope-projection-refs')).toBeNull()
  })

  it('D-17/T35：响应携带数百条警告 → 有界呈现（明细受限 + 计数摘要 + 截断标注）', async () => {
    seedScopeAll()
    const warnings = Array.from({ length: 300 }, (_, index) => ({
      code: 'stale_fallback',
      message: `fallback-${index}`,
      documents: [{
        document_id: `doc_${index}`,
        used_version: index % 2 === 0 ? 'v2' : '',
        skipped_version: 'v3',
      }],
    }))
    const resultWithProjection = {
      ...directResult,
      scope_contract_version: 'c05-v1',
      resolved_scope: {
        mode: 'all',
        contract_version: 'c05-v1',
        resolved_source_refs: Array.from({ length: 250 }, (_, index) => ({
          document_id: `doc_ref_${index}`,
          document_version: 'v2',
        })),
        note_ids: [],
        single_source_id: null,
        missing_source_ids: [],
        includes_exact_versions: false,
        contains_document_body: false,
        warnings,
      },
    }
    vi.mocked(researchApi.searchV1).mockResolvedValue({
      kind: 'direct',
      result: resultWithProjection as unknown as typeof directResult,
    })
    const { container } = render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-proj-huge' } })
    fireEvent.click(screen.getByTestId('search-run'))

    await waitFor(() => {
      expect(screen.getByTestId('scope-warning-summary')).toBeInTheDocument()
    })
    // 明细有界
    expect(
      container.querySelectorAll('[data-testid="scope-warning-detail"] li'),
    ).toHaveLength(5)
    expect(screen.getByTestId('scope-warning-truncated')).toBeInTheDocument()
    // refs 只出计数：不逐条渲染 250 个 document_id
    const text = container.textContent ?? ''
    expect(text).not.toContain('doc_ref_1')
    expect(text).not.toContain('doc_ref_249')
    // 首屏节点数不随规模增长（300 条警告仍是固定条明细）
    expect(container.querySelectorAll('li').length).toBeLessThan(20)
  })

  it('D-01：投影畸形（contains_document_body=true）→ 按不可用呈现并暴露原因码', async () => {
    seedScopeAll()
    const malformed = {
      ...directResult,
      scope_contract_version: 'c05-v1',
      resolved_scope: {
        mode: 'all',
        contract_version: 'c05-v1',
        resolved_source_refs: [],
        note_ids: [],
        single_source_id: null,
        missing_source_ids: [],
        includes_exact_versions: false,
        contains_document_body: true,
        warnings: [],
      },
    }
    vi.mocked(researchApi.searchV1).mockResolvedValue({
      kind: 'direct',
      result: malformed as unknown as typeof directResult,
    })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-proj-bad' } })
    fireEvent.click(screen.getByTestId('search-run'))

    await waitFor(() => {
      const node = screen.getByTestId('scope-projection-invalid')
      expect(node).toHaveTextContent('c05_scope_projection_invalid')
    })
  })

  it('D-01：先有 C-05 投影、再退到 v1 结果 → 旧投影必须被清空（不串台）', async () => {
    seedScopeAll()
    // 第一轮：C-05 携带投影（refs 有值）
    vi.mocked(researchApi.searchV1).mockResolvedValueOnce({
      kind: 'direct',
      result: {
        ...directResult,
        scope_contract_version: 'c05-v1',
        resolved_scope: {
          mode: 'all', contract_version: 'c05-v1',
          resolved_source_refs: [{ document_id: 'doc_ref_1', document_version: 'v1' }],
          note_ids: [], single_source_id: null, missing_source_ids: [],
          includes_exact_versions: false, contains_document_body: false, warnings: [],
        },
      } as unknown as typeof directResult,
    })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-c05-first' } })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(screen.getByTestId('scope-projection-refs')).toBeInTheDocument())

    // 第二轮：能力翻转为 v1（真实落到查询缓存），返回 v1 结果
    // 评审 LOW-13：此前该用例**直接从 v1 开始**，即使删掉"清空投影"逻辑也不会红。
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [], capabilities: { coverage_all_selected: false, c05: c05Caps(false) },
    })
    await act(async () => {
      await activeQueryClient!.invalidateQueries({ queryKey: QUERY_KEYS.researchModelCatalog('proj_1') })
    })
    // 等到能力**确实**翻转进缓存（否则第二轮仍会走 C-05 分支，前提不成立）
    await waitFor(() => {
      const cached = activeQueryClient!.getQueryData(QUERY_KEYS.researchModelCatalog('proj_1')) as
        | { capabilities?: { c05?: { enabled?: boolean } } } | undefined
      expect(cached?.capabilities?.c05?.enabled).toBe(false)
    })
    vi.mocked(researchApi.searchV1).mockResolvedValueOnce({ kind: 'direct', result: directResult })
    fireEvent.click(screen.getByTestId('search-run'))

    // **前提断言**：第二轮必须真的走了 v1 分支（契约翻转发散了）。没有这一步，
    // "投影被清空"可能只是 C-05 分支重新赋值的结果，用例会假绿。
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(2))
    const secondBody = vi.mocked(researchApi.searchV1).mock.calls[1][1] as unknown as Record<string, unknown>
    expect(secondBody.source_scope).toBeUndefined()
    expect(vi.mocked(researchApi.searchV1).mock.calls[1][2]?.contract).toBeUndefined()

    await waitFor(() => {
      expect(screen.getByTestId('scope-projection-missing')).toBeInTheDocument()
    })
    // 上一轮的 C-05 投影必须已经消失（否则范围身份与当前 v1 结果不一致）
    expect(screen.queryByTestId('scope-projection-refs')).toBeNull()
  })

  // ── PR5（D-12/2026-10-21 复核 M1）：Preview budget 生命周期与门禁行为 ──

  function previewReadyCaps() {
    return {
      models: [], capabilities: { coverage_all_selected: false, c05: c05Caps(true, true, true) },
    }
  }

  it('D-12：Preview exceeded → Run 被门禁阻断（不发 searchV1）', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    vi.mocked(researchApi.fetchC05Preview).mockResolvedValue(previewExceeded() as never)
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-budget-exceeded' } })
    await waitFor(() => expect(researchApi.fetchC05Preview).toHaveBeenCalledTimes(1), { timeout: 2000 })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(screen.getByTestId('search-error')).toBeInTheDocument())
    expect(researchApi.searchV1).not.toHaveBeenCalled()
  })

  it('D-12：query 变化立即作废旧 budget（旧 exceeded 不阻断新意图）', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    vi.mocked(researchApi.fetchC05Preview).mockResolvedValue(previewExceeded() as never)
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-old-intent' } })
    await waitFor(() => expect(researchApi.fetchC05Preview).toHaveBeenCalledTimes(1), { timeout: 2000 })
    // 不等待新 debounce：新意图提交时必须已作废旧预算（否则会被旧 exceeded 阻断）
    fireEvent.change(input, { target: { value: 'q-new-intent' } })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
  })

  it('D-12：已取消旧 Preview 的 reject 不得清掉新 budget（新意图仍被阻断）', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    let rejectOld: (error: Error) => void = () => {}
    const oldPreview = new Promise((_resolve, reject) => { rejectOld = reject })
    vi.mocked(researchApi.fetchC05Preview)
      .mockReturnValueOnce(oldPreview as never)
      .mockResolvedValueOnce(previewExceeded() as never)
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-stale-old' } })
    await waitFor(() => expect(researchApi.fetchC05Preview).toHaveBeenCalledTimes(1), { timeout: 2000 })
    fireEvent.change(input, { target: { value: 'q-stale-new' } })
    await waitFor(() => expect(researchApi.fetchC05Preview).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await act(async () => {
      rejectOld(new Error('stale-preview-failed'))
      await Promise.resolve()
    })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(screen.getByTestId('search-error')).toBeInTheDocument())
    expect(researchApi.searchV1).not.toHaveBeenCalled()
  })

  it('D-12：inactive 清空旧 budget（重新提交不被旧 exceeded 阻断）', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    vi.mocked(researchApi.fetchC05Preview).mockResolvedValue(previewExceeded() as never)
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    const wrapper = makeWrapper()
    const { rerender } = render(<ResearchSearchPanel projectId="proj_1" active />, { wrapper })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-inactive' } })
    await waitFor(() => expect(researchApi.fetchC05Preview).toHaveBeenCalledTimes(1), { timeout: 2000 })
    rerender(<ResearchSearchPanel projectId="proj_1" active={false} />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
  })

  // ── PR5（D-12，2026-10-22 收口）：Preview 提示层接线 ──
  // 面板只消费 `canSubmit` / `blockedReason` 的口径不变；`notice` 仅渲染提示。
  // 注：测试环境把 `useTranslation` mock 成 `t(key) => key`（见 src/test/setup.ts），
  // 因此断言的是**映射到的 i18n 键**；键值本身由 en-US 真源 + locale parity 测试保证。

  it('D-12（2026-10-22 收口）：deferred[] → 提示"执行期复检"且不阻断提交；inactive 清空', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    vi.mocked(researchApi.fetchC05Preview).mockResolvedValue(
      previewValidated([deferredExecutionCheck()]) as never,
    )
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    const { rerender } = render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-notice-deferred' } })

    const notice = await screen.findByTestId('c05-preview-notice', {}, { timeout: 2000 })
    expect(notice).toHaveTextContent('research.c05PreviewExecutionRecheck')
    expect(notice).not.toHaveTextContent('research.c05PreviewUnvalidated')

    // D-12：execution_recheck 只提示、不阻断（validated + deferred 仍应放行）
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('search-error')).toBeNull()

    // inactive（隐藏/切走）→ 旧意图的提示不得残留
    rerender(<ResearchSearchPanel projectId="proj_1" active={false} />)
    await waitFor(() => expect(screen.queryByTestId('c05-preview-notice')).toBeNull())
  })

  it('D-12（2026-10-22 收口）：Preview 失败/不可用 → unvalidated 提示可见且不阻断', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    vi.mocked(researchApi.fetchC05Preview).mockRejectedValue(new Error('c05_entry_not_ready'))
    vi.mocked(researchApi.searchV1).mockResolvedValue({ kind: 'direct', result: directResult })
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-notice-missing' } })

    const notice = await screen.findByTestId('c05-preview-notice', {}, { timeout: 2000 })
    expect(notice).toHaveTextContent('research.c05PreviewUnvalidated')

    // D-12：不得把"未检查"渲染成通过，也不得因此阻断提交
    fireEvent.click(screen.getByTestId('search-run'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('search-error')).toBeNull()
  })

  it('D-12（2026-10-22 收口）：全 validated 无 deferred → 不渲染提示', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    let resolvePreview: (value: unknown) => void = () => {}
    const previewPromise = new Promise<unknown>((resolve) => { resolvePreview = resolve })
    vi.mocked(researchApi.fetchC05Preview).mockReturnValue(previewPromise as never)
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-notice-clean' } })
    await waitFor(() => expect(researchApi.fetchC05Preview).toHaveBeenCalledTimes(1), { timeout: 2000 })

    // 显式放行响应，确保断言发生在组件**消费**结果之后（否则负向断言是假绿）
    await act(async () => {
      resolvePreview(previewValidated())
      await previewPromise
    })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('c05-preview-notice')).toBeNull()
  })

  it('D-12（2026-10-22 收口）：能力关闭退回旧 v1 路径 → 提示清空', async () => {
    seedScopeAll()
    vi.mocked(researchApi.listModels).mockResolvedValue(previewReadyCaps())
    vi.mocked(researchApi.fetchC05Preview).mockResolvedValue(
      previewValidated([deferredExecutionCheck()]) as never,
    )
    vi.mocked(researchApi.fetchContextPreview).mockResolvedValue({
      source_count: 1, chunk_count: 1, note_count: 0, token_estimate: 10,
      direct_or_background: 'direct', needs_consent: false, coverage: {}, warnings: [],
    } as never)
    render(<ResearchSearchPanel projectId="proj_1" />, { wrapper: makeWrapper() })
    const input = await screen.findByTestId('search-input')
    fireEvent.change(input, { target: { value: 'q-notice-flip' } })
    await screen.findByTestId('c05-preview-notice', {}, { timeout: 2000 })

    // 能力翻转（真实写进查询缓存）→ 面板退回旧 v1 Preview 路径
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [], capabilities: { coverage_all_selected: false, c05: c05Caps(false) },
    })
    await act(async () => {
      await activeQueryClient!.invalidateQueries({
        queryKey: QUERY_KEYS.researchModelCatalog('proj_1'),
      })
    })
    await waitFor(() => {
      const cached = activeQueryClient!.getQueryData(QUERY_KEYS.researchModelCatalog('proj_1')) as
        | { capabilities?: { c05?: { enabled?: boolean } } } | undefined
      expect(cached?.capabilities?.c05?.enabled).toBe(false)
    })
    // 前提断言：确实退回 v1 路径发起了 Preview（否则"提示消失"可能是假绿）
    await waitFor(() => expect(researchApi.fetchContextPreview).toHaveBeenCalled(), { timeout: 2000 })
    await waitFor(() => expect(screen.queryByTestId('c05-preview-notice')).toBeNull())
  })
})
