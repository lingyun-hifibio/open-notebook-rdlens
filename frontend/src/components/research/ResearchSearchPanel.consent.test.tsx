/**
 * PR5（D-22 / T40）：同意流程必须与直发**同键同信封**。
 *
 * 为什么必须用**真实** GlobalModel Provider：其余 Search 用例用替身，`runGuarded`
 * 同步执行，测不到"登记 → 一段时间后 confirm → 才派发"这条路径。而这正是
 * D-22 指出的漏洞面：若请求信封与幂等键在确认之后才构造，用户取消后重试就会
 * 换键——D-13 表① 要求"未完成发出"时保留原键，同意流程会因此变成幂等漏洞。
 *
 * 本文件锁死三件事：
 * 1. 登记时即冻结契约 / 完整信封 / 幂等键；
 * 2. 取消**不清键**，同一次逻辑提交重试复用原键；
 * 3. 确认后派发的键与信封逐字段等于登记内容（不是重新构造的另一份）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import { ResearchEgressConsentDialog } from './ResearchEgressConsentDialog'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import {
  ResearchGlobalModelProvider,
  useResearchGlobalModel,
} from '@/lib/hooks/use-research-global-model'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import { QUERY_KEYS } from '@/lib/api/query-client'

vi.mock('@/lib/research/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/research/api')>()),
  searchV1: vi.fn(),
  fetchContextPreview: vi.fn(),
  fetchC05Preview: vi.fn(),
  // 真实 GlobalModel Provider 的查询面
  listModels: vi.fn(),
  getExecutionPreferences: vi.fn(),
  getExternalEgressConsent: vi.fn(),
  acknowledgeExternalEgressConsent: vi.fn(),
  saveExecutionPreferences: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const PROJECT = 'proj_1'
const EXTERNAL_MODEL = 'm-ext'

/** 把登记内容暴露出来（D-22 的冻结意图必须是可观测的） */
function RegistrationProbe() {
  const { pendingConsentRegistration } = useResearchGlobalModel()
  return (
    <output data-testid="registration-probe">
      {JSON.stringify(pendingConsentRegistration)}
    </output>
  )
}

function makeTree() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return { queryClient, ui: (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId={PROJECT} role="owner">
        <ResearchGlobalModelProvider>
          <ResearchJobsProvider>
            <ResearchScopeProvider userId="u1" projectId={PROJECT}>
              <ResearchSearchPanel projectId={PROJECT} />
              <RegistrationProbe />
              <ResearchEgressConsentDialog />
            </ResearchScopeProvider>
          </ResearchJobsProvider>
        </ResearchGlobalModelProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  ) }
}

/** 外部模型 + 尚未确认（consent.valid=false）→ needsConsent=true */
function stubExternalModelPendingConsent(c05SearchReady = false) {
  vi.mocked(researchApi.listModels).mockResolvedValue({
    models: [{
      model_id: EXTERNAL_MODEL, display_name: 'Ext M', data_egress: true,
      interactive_context_levels: ['focused', 'document', 'workspace'],
    }],
    capabilities: {
      c05: {
        contract: 'c05-v1',
        enabled: c05SearchReady,
        preview_supported: false,
        entries: {
          search: {
            scope_modes: c05SearchReady ? ['all', 'selected', 'single'] : [],
            execution_modes: c05SearchReady ? ['auto'] : [],
            context_levels: c05SearchReady ? ['focused', 'document', 'workspace'] : [],
            preview_supported: false,
            execution_ready: c05SearchReady,
            unavailable_reason: c05SearchReady ? null : 'c05_contract_disabled',
          },
        },
      },
    },
  } as never)
  vi.mocked(researchApi.getExecutionPreferences).mockResolvedValue({
    preferred_model_id: EXTERNAL_MODEL, default_context_level: 'focused',
  } as never)
  vi.mocked(researchApi.getExternalEgressConsent).mockResolvedValue({
    consent: null,
    required_scope: {
      policy_version: '1',
      provider_destinations: [{ provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' }],
      data_categories: ['focused_context'],
      scope_hash: 'h',
    },
  } as never)
  vi.mocked(researchApi.acknowledgeExternalEgressConsent).mockResolvedValue({
    consent: {
      policy_version: '1', scope_hash: 'h', acknowledged_at: '2026-09-01T00:00:00Z',
      acknowledged_by_user_id: 1, destination_ids: ['ext-1'], data_categories: ['focused_context'],
      valid: true,
    },
    required_scope: {
      policy_version: '1',
      provider_destinations: [{ provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' }],
      data_categories: ['focused_context'],
      scope_hash: 'h',
    },
  } as never)
}

function readRegistration(): {
  contract: 'v1' | 'c05-v1' | null
  envelope: Record<string, unknown> | null
  idempotencyKey: string | null
} | null {
  const raw = screen.getByTestId('registration-probe').textContent ?? 'null'
  return JSON.parse(raw)
}

async function submitSearch(query: string) {
  const input = await screen.findByTestId('search-input')
  fireEvent.change(input, { target: { value: query } })
  fireEvent.click(screen.getByTestId('search-run'))
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  localStorage.setItem(
    scopeStorageKey('u1', PROJECT),
    JSON.stringify({ version: 1, mode: 'selected', sourceIds: ['src_1'], noteIds: [] }),
  )
  // Context/Scope Preview 的 debounce（400ms）会在较长的用例里真正触发：
  // mock 必须返回 Promise，否则 `.then` 打到 undefined（unhandled error）
  vi.mocked(researchApi.fetchContextPreview).mockResolvedValue(null as never)
  vi.mocked(researchApi.fetchC05Preview).mockResolvedValue({ budget: null } as never)
  vi.mocked(researchApi.searchV1).mockResolvedValue({
    kind: 'direct',
    result: {
      request_id: 'r1', resolved_mode: 'direct_context', evidence: [], citations: [],
      usage: null, degradation_reason: null, conclusion: 'ok',
    },
  } as never)
})

describe('T40（D-22）：同意登记冻结信封与幂等键', () => {
  it('登记时即冻结契约/信封/键；确认后只用登记内容派发', async () => {
    stubExternalModelPendingConsent(false)
    render(makeTree().ui)

    await submitSearch('q-consent-1')
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    // 尚未外发
    expect(researchApi.searchV1).not.toHaveBeenCalled()

    const registered = readRegistration()
    expect(registered).not.toBeNull()
    expect(registered?.contract).toBe('v1')
    expect(registered?.idempotencyKey).toBeTruthy()
    // 信封就是将要 POST 的载荷（含 query / 冻结的范围）
    expect(registered?.envelope).toMatchObject({
      query: 'q-consent-1',
      source_ids: ['src_1'],
      model_id: EXTERNAL_MODEL,
    })

    fireEvent.click(screen.getByTestId('egress-consent-confirm'))

    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    const [, body, options] = vi.mocked(researchApi.searchV1).mock.calls[0]
    // 键与信封逐字段等于登记内容（不是重新构造的另一份）
    expect(options?.idempotencyKey).toBe(registered?.idempotencyKey)
    expect(body).toEqual(registered?.envelope)
    // v1 契约：无 source_scope
    expect((body as unknown as Record<string, unknown>).source_scope).toBeUndefined()
  })

  it('C-05 登记：契约随登记冻结为 c05-v1，确认后信封为 source_scope 形状', async () => {
    stubExternalModelPendingConsent(true)
    render(makeTree().ui)

    await submitSearch('q-consent-c05')
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())

    const registered = readRegistration()
    expect(registered?.contract).toBe('c05-v1')
    expect(registered?.envelope).toMatchObject({
      query: 'q-consent-c05',
      source_scope: { mode: 'selected', source_ids: ['src_1'], single_source_id: null },
    })

    fireEvent.click(screen.getByTestId('egress-consent-confirm'))

    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    const [, body, options] = vi.mocked(researchApi.searchV1).mock.calls[0]
    expect(options?.contract).toBe('c05-v1')
    expect(options?.idempotencyKey).toBe(registered?.idempotencyKey)
    expect(body).toEqual(registered?.envelope)
  })

  it('取消不清键：同一次逻辑提交重试复用**原键**', async () => {
    stubExternalModelPendingConsent(false)
    render(makeTree().ui)

    await submitSearch('q-consent-cancel')
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    const firstKey = readRegistration()?.idempotencyKey
    expect(firstKey).toBeTruthy()

    fireEvent.click(screen.getByTestId('egress-consent-cancel'))
    await waitFor(() => expect(screen.queryByTestId('egress-consent-dialog')).toBeNull())
    // 取消 = 未完成发出 → 登记清空，但**不得**丢失原键（D-13 表①）
    expect(readRegistration()).toBeNull()
    expect(researchApi.searchV1).not.toHaveBeenCalled()

    await submitSearch('q-consent-cancel')
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    const retryRegistration = readRegistration()
    expect(retryRegistration?.idempotencyKey).toBe(firstKey)

    fireEvent.click(screen.getByTestId('egress-consent-confirm'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    expect(vi.mocked(researchApi.searchV1).mock.calls[0][2]?.idempotencyKey).toBe(firstKey)
  })

  it('确定性完成后的同题重提 = 新执行 → 新键（D-13 表②，经同意路径）', async () => {
    stubExternalModelPendingConsent(false)
    render(makeTree().ui)

    await submitSearch('q-repeat')
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    const firstKey = readRegistration()?.idempotencyKey
    fireEvent.click(screen.getByTestId('egress-consent-confirm'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    expect(vi.mocked(researchApi.searchV1).mock.calls[0][2]?.idempotencyKey).toBe(firstKey)

    // 已确定性完成 → 清键；同一问题再提一次必须换新键（不得命中服务端重放）。
    // 注意：确认后 consent 已生效，第二次提交**不再弹确认**，直接派发——
    // 因此从实际请求读键（这也顺带断言了"确认后回到直发路径"）。
    await submitSearch('q-repeat')
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(2))
    const secondKey = vi.mocked(researchApi.searchV1).mock.calls[1][2]?.idempotencyKey
    expect(secondKey).toBeTruthy()
    expect(secondKey).not.toBe(firstKey)
  })

  it('契约/信封在登记后不被能力翻转改写（确认前后同源）', async () => {
    stubExternalModelPendingConsent(false)
    const { queryClient, ui } = makeTree()
    render(ui)

    await submitSearch('q-consent-freeze')
    await waitFor(() => expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy())
    const registered = readRegistration()
    expect(registered?.contract).toBe('v1')

    // 评审 LOW-13：必须让能力**真的**翻转进查询缓存——否则该用例只改了 mock
    // 返回值，派发时即使重新读取能力也读不到新值，断言是空的。
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [{
        model_id: EXTERNAL_MODEL, display_name: 'Ext M', data_egress: true,
        interactive_context_levels: ['focused'],
      }],
      capabilities: { c05: { contract: 'c05-v1', enabled: true, preview_supported: false, entries: {
        search: { scope_modes: ['all', 'selected', 'single'], execution_modes: ['auto'],
          context_levels: ['focused'], preview_supported: false, execution_ready: true,
          unavailable_reason: null },
      } } },
    } as never)
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchModelCatalog(PROJECT) })
    })
    // 先确认"翻转确实落地了"，再断言契约未被改写
    await waitFor(() => {
      const cached = queryClient.getQueryData(QUERY_KEYS.researchModelCatalog(PROJECT)) as
        | { capabilities?: { c05?: { enabled?: boolean } } } | undefined
      expect(cached?.capabilities?.c05?.enabled).toBe(true)
    })

    fireEvent.click(screen.getByTestId('egress-consent-confirm'))
    await waitFor(() => expect(researchApi.searchV1).toHaveBeenCalledTimes(1))
    const [, body, options] = vi.mocked(researchApi.searchV1).mock.calls[0]
    expect(options?.contract).toBeUndefined() // 冻结为 v1 → 无契约头
    expect((body as unknown as Record<string, unknown>).source_scope).toBeUndefined()
    expect(body).toEqual(registered?.envelope)
  })
})

afterEach(() => {
  cleanup()
})
