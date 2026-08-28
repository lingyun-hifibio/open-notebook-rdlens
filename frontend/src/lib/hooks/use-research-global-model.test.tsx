/**
 * Issue #243 GMOD-FE-01 §6.1/§6.8：Research 全局模型 provider。
 *
 * - draft/confirmed 分离：draft 从不进入请求；保存成功后 confirmed 才可执行；
 * - 保存只 PATCH preferred_model_id；Search context 只 PATCH
 *   default_context_level（互不覆盖）；
 * - 保存中 isSavingModel=true，所有新生成入口冻结；失败回滚 draft 并 refetch；
 * - unavailable（模型消失/禁用/显式清除）阻止生成，不自动改选；
 * - Admin readonly：禁用控件语义，不发 PATCH；
 * - consent single-flight：取消无副作用（不创建任何状态）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  acknowledgeExternalEgressConsent,
  listModels,
  getExecutionPreferences,
  patchExecutionPreferences,
  getExternalEgressConsent,
} from '@/lib/research/api'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import type { ResearchModelOption } from '@/lib/research/types'
import {
  ResearchGlobalModelProvider,
  useResearchGlobalModel,
} from './use-research-global-model'

vi.mock('@/lib/research/api', () => ({
  listModels: vi.fn(),
  getExecutionPreferences: vi.fn(),
  patchExecutionPreferences: vi.fn(),
  getExternalEgressConsent: vi.fn(),
  acknowledgeExternalEgressConsent: vi.fn(),
}))

vi.mock('@/lib/embedded/workspace-context', () => ({
  useResearchWorkspace: vi.fn(() => ({
    projectId: 'proj_1',
    role: 'owner',
    isOwner: true,
    isAdminReadonly: false,
  })),
}))

const MODELS: ResearchModelOption[] = [
  { model_id: 'm-local', display_name: 'Local M', data_egress: false, interactive_context_levels: ['focused', 'document', 'workspace'] },
  { model_id: 'm-ext', display_name: 'Ext M', data_egress: true, interactive_context_levels: ['focused'] },
]

const PREFS_M_LOCAL = {
  project_id: 'proj_1',
  default_context_level: 'focused' as const,
  preferred_model_id: 'm-local',
  updated_by: 1,
  updated_at: '2026-08-28T00:00:00+00:00',
}

const PREFS_NULL = {
  project_id: 'proj_1',
  default_context_level: 'focused' as const,
  preferred_model_id: null,
  updated_by: null,
  updated_at: null,
}

const CONSENT_VALID = {
  consent: {
    project_id: 'proj_1',
    acknowledged_by: 1,
    acknowledged_at: '2026-08-28T00:00:00+00:00',
    policy_version: '1',
    scope_hash: 'hash',
    revoked_at: null,
    revoked_by: null,
    valid: true,
  },
  required_scope: {
    policy_version: '1',
    provider_destinations: [{ provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' }],
    data_categories: ['focused_context'],
    scope_hash: 'hash',
  },
}

const CONSENT_MISSING = {
  consent: null,
  required_scope: CONSENT_VALID.required_scope,
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ResearchGlobalModelProvider>{children}</ResearchGlobalModelProvider>
      </QueryClientProvider>
    )
  }
}

function renderGlobalModel() {
  return renderHook(() => useResearchGlobalModel(), { wrapper: makeWrapper() })
}

describe('useResearchGlobalModel（GMOD §6.1 draft/confirmed）', () => {
  beforeEach(() => {
    // reset（而非 clear）：挂起型 mockImplementation 不会泄漏到后续测试
    vi.resetAllMocks()
    vi.mocked(useResearchWorkspace).mockReturnValue({
      projectId: 'proj_1',
      role: 'owner',
      isOwner: true,
      isAdminReadonly: false,
    })
    vi.mocked(listModels).mockResolvedValue({ models: MODELS })
    vi.mocked(getExecutionPreferences).mockResolvedValue(PREFS_M_LOCAL)
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_VALID)
    vi.mocked(acknowledgeExternalEgressConsent).mockResolvedValue(CONSENT_VALID)
    vi.mocked(patchExecutionPreferences).mockImplementation(
      async (_projectId, input) => ({
        ...PREFS_M_LOCAL,
        ...(input.preferred_model_id !== undefined
          ? { preferred_model_id: input.preferred_model_id }
          : {}),
        ...(input.default_context_level !== undefined
          ? { default_context_level: input.default_context_level }
          : {}),
      }),
    )
  })

  it('加载后 confirmed 为服务端偏好值；draft 初始等于 confirmed', async () => {
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    expect(result.current.confirmedModelId).toBe('m-local')
    expect(result.current.draftModelId).toBe('m-local')
    expect(result.current.confirmedModelAvailability).toBe('available')
  })

  it('无已保存偏好时 confirmed 为 null，不自动选中第一个模型', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(PREFS_NULL)
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    expect(result.current.confirmedModelId).toBeNull()
    expect(result.current.draftModelId).toBeNull()
    expect(result.current.confirmedModelAvailability).toBe('none')
  })

  it('draft 选择不改变 confirmed；保存成功后 confirmed 才更新（只 PATCH model）', async () => {
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    act(() => result.current.setDraftModelId('m-ext'))
    expect(result.current.draftModelId).toBe('m-ext')
    expect(result.current.confirmedModelId).toBe('m-local')
    await act(async () => {
      await result.current.saveModel()
    })
    expect(patchExecutionPreferences).toHaveBeenCalledWith(
      'proj_1',
      { preferred_model_id: 'm-ext' },
    )
    // PATCH 载荷不得包含 default_context_level（互不覆盖，不变量 8）
    const payload = vi.mocked(patchExecutionPreferences).mock.calls[0][1]
    expect(Object.keys(payload)).toEqual(['preferred_model_id'])
    expect(result.current.confirmedModelId).toBe('m-ext')
  })

  it('保存 Search 上下文只 PATCH default_context_level，不触碰模型', async () => {
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    await act(async () => {
      await result.current.saveSearchContext('document')
    })
    expect(patchExecutionPreferences).toHaveBeenCalledWith(
      'proj_1',
      { default_context_level: 'document' },
    )
    const payload = vi.mocked(patchExecutionPreferences).mock.calls[0][1]
    expect(Object.keys(payload)).toEqual(['default_context_level'])
    // 模型不被覆盖
    expect(result.current.confirmedModelId).toBe('m-local')
    await waitFor(() => expect(result.current.searchContextDefault).toBe('document'))
  })

  it('保存失败：丢弃 draft、refetch 服务端值、错误置位', async () => {
    vi.mocked(patchExecutionPreferences).mockRejectedValue(new Error('save failed'))
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    act(() => result.current.setDraftModelId('m-ext'))
    await act(async () => {
      // saveModel 不吞错（调用方决定提示），但状态必须回滚
      await result.current.saveModel().catch(() => undefined)
    })
    expect(result.current.saveModelError).not.toBeNull()
    // draft 回滚到服务端 confirmed
    expect(result.current.draftModelId).toBe('m-local')
    expect(result.current.confirmedModelId).toBe('m-local')
  })

  it('保存中 isSavingModel=true 且执行被冻结（canExecute=false）', async () => {
    let resolveSave: ((v: unknown) => void) | null = null
    vi.mocked(patchExecutionPreferences).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve as (v: unknown) => void
        }),
    )
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    act(() => result.current.setDraftModelId('m-ext'))
    let savePromise: Promise<void> | null = null
    act(() => {
      savePromise = result.current.saveModel()
    })
    await waitFor(() => expect(result.current.isSavingModel).toBe(true))
    expect(result.current.canExecute).toBe(false)
    await act(async () => {
      resolveSave?.({
        ...PREFS_M_LOCAL,
        preferred_model_id: 'm-ext',
      })
      await savePromise
    })
    await waitFor(() => expect(result.current.isSavingModel).toBe(false))
    await waitFor(() => expect(result.current.canExecute).toBe(true))
  })

  it('已保存模型消失/禁用时 availability=unavailable 且 canExecute=false', async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: [MODELS[1]!], // m-local 不在目录中
    })
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    expect(result.current.confirmedModelId).toBe('m-local')
    expect(result.current.confirmedModelAvailability).toBe('unavailable')
    expect(result.current.canExecute).toBe(false)
  })

  it('显式清除模型（保存 null）后 availability=none 且阻止生成', async () => {
    vi.mocked(patchExecutionPreferences).mockResolvedValue(PREFS_NULL)
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    await act(async () => {
      await result.current.clearModel()
    })
    expect(patchExecutionPreferences).toHaveBeenCalledWith(
      'proj_1',
      { preferred_model_id: null },
    )
    expect(result.current.confirmedModelId).toBeNull()
    expect(result.current.confirmedModelAvailability).toBe('none')
    expect(result.current.canExecute).toBe(false)
  })

  it('canExecute 在无模型/保存中/unavailable 时为 false；正常时 true', async () => {
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    expect(result.current.canExecute).toBe(true)
  })

  it('本地模型：runGuarded 直接执行，不弹确认', async () => {
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    const operation = vi.fn(async (modelId: string) => `ran:${modelId}`)
    let outcome: string | undefined
    await act(async () => {
      outcome = await result.current.runGuarded(operation)
    })
    expect(operation).toHaveBeenCalledTimes(1)
    // 传入的是 confirmed 快照，不是 draft
    expect(operation).toHaveBeenCalledWith('m-local')
    expect(outcome).toBe('ran:m-local')
    expect(result.current.isConsentPromptOpen).toBe(false)
  })

  it('外部模型：runGuarded 先弹确认，确认后用捕获快照执行', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...PREFS_M_LOCAL,
      preferred_model_id: 'm-ext',
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    expect(result.current.confirmedModelIsExternal).toBe(true)
    expect(result.current.needsConsent).toBe(true)
    // 入口仍可点击：禁用会让用户永远无法触发确认（§6.8 第 3 步）
    expect(result.current.canExecute).toBe(true)

    const operation = vi.fn(async () => 'ok')
    await act(async () => {
      await result.current.runGuarded(operation)
    })
    // 不变量 9：确认前不执行，因此不可能残留 turn/job/loading/idempotency
    expect(operation).not.toHaveBeenCalled()
    expect(result.current.isConsentPromptOpen).toBe(true)

    await act(async () => {
      await result.current.confirmConsent()
    })
    expect(acknowledgeExternalEgressConsent).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledWith('m-ext')
    await waitFor(() => expect(result.current.needsConsent).toBe(false))
    expect(result.current.isConsentPromptOpen).toBe(false)
  })

  it('consent 取消：不执行、不 acknowledge、无残留状态', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...PREFS_M_LOCAL,
      preferred_model_id: 'm-ext',
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    const operation = vi.fn(async () => 'ok')
    await act(async () => {
      await result.current.runGuarded(operation)
    })
    expect(result.current.isConsentPromptOpen).toBe(true)

    act(() => result.current.cancelConsent())
    expect(result.current.isConsentPromptOpen).toBe(false)
    expect(operation).not.toHaveBeenCalled()
    expect(acknowledgeExternalEgressConsent).not.toHaveBeenCalled()
    // 用户输入/选择不被取消动作改变
    expect(result.current.draftModelId).toBe('m-ext')
    expect(result.current.confirmedModelId).toBe('m-ext')

    // 已取消的登记不得被后续确认复活
    await act(async () => {
      await result.current.confirmConsent()
    })
    expect(operation).not.toHaveBeenCalled()
    expect(acknowledgeExternalEgressConsent).not.toHaveBeenCalled()
  })

  it('single-flight：确认在途时重复 confirmConsent 不重复 acknowledge', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...PREFS_M_LOCAL,
      preferred_model_id: 'm-ext',
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    let release: ((value: unknown) => void) | null = null
    vi.mocked(acknowledgeExternalEgressConsent).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void
        }),
    )
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    const operation = vi.fn(async () => 'ok')
    await act(async () => {
      await result.current.runGuarded(operation)
    })
    expect(result.current.isConsentPromptOpen).toBe(true)

    let first: Promise<void> | null = null
    let secondDone = false
    await act(async () => {
      first = result.current.confirmConsent()
      // 在途时第二次确认被忽略并立即返回，不挂起
      await result.current.confirmConsent().then(() => { secondDone = true })
    })
    expect(secondDone).toBe(true)
    expect(acknowledgeExternalEgressConsent).toHaveBeenCalledTimes(1)
    expect(operation).not.toHaveBeenCalled()

    await act(async () => {
      release?.(CONSENT_VALID)
      await first
    })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledWith('m-ext')
  })

  it('confirmConsent acknowledge 失败：弹窗保持打开、错误可见、登记保留可重试', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      ...PREFS_M_LOCAL,
      preferred_model_id: 'm-ext',
    })
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    vi.mocked(acknowledgeExternalEgressConsent)
      .mockRejectedValueOnce(new Error('ack down'))
      .mockResolvedValueOnce(CONSENT_VALID)
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    const operation = vi.fn(async () => 'ok')
    await act(async () => {
      await result.current.runGuarded(operation)
    })
    expect(result.current.isConsentPromptOpen).toBe(true)

    // 第一次确认失败：错误置位、无未处理 rejection、弹窗与登记保留
    await act(async () => {
      await result.current.confirmConsent()
    })
    expect(result.current.consentError).toBe('ack down')
    expect(result.current.isConsentPromptOpen).toBe(true)
    expect(operation).not.toHaveBeenCalled()

    // 重试成功：执行登记的操作并清除错误
    await act(async () => {
      await result.current.confirmConsent()
    })
    expect(acknowledgeExternalEgressConsent).toHaveBeenCalledTimes(2)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledWith('m-ext')
    expect(result.current.consentError).toBeNull()
    expect(result.current.isConsentPromptOpen).toBe(false)

    // 取消时错误一并清除（不留陈旧提示）
    await act(async () => {
      await result.current.runGuarded(vi.fn(async () => 'ok'))
    })
    act(() => result.current.cancelConsent())
    expect(result.current.consentError).toBeNull()
  })

  it('保存 Search 上下文不冻结生成入口（isSavingModel 只反映模型保存）', async () => {
    // 先建 deferred，再挂 mock：不依赖 mutateAsync 的调用时机
    let resolveContext!: (value: unknown) => void
    const contextDeferred = new Promise((resolve) => {
      resolveContext = resolve as (value: unknown) => void
    })
    vi.mocked(patchExecutionPreferences).mockImplementation(
      (_projectId, input) => {
        if (input.default_context_level !== undefined) {
          return contextDeferred as never
        }
        return Promise.resolve({
          ...PREFS_M_LOCAL,
          ...input,
        }) as never
      },
    )
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))

    let contextSave: Promise<void> | null = null
    await act(async () => {
      contextSave = result.current.saveSearchContext('document')
    })
    // 上下文保存在途：生成入口不被冻结（冻结范围仅模型保存，不变量 3）
    expect(result.current.isSavingModel).toBe(false)
    expect(result.current.canExecute).toBe(true)

    await act(async () => {
      resolveContext({
        ...PREFS_M_LOCAL,
        default_context_level: 'document',
      })
      await contextSave
    })
    await waitFor(() => expect(result.current.searchContextDefault).toBe('document'))
  })

  it('切换模型（draft 变化）时 refetch consent（目标 scope 不复用）', async () => {
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    const before = vi.mocked(getExternalEgressConsent).mock.calls.length
    act(() => result.current.setDraftModelId('m-ext'))
    await waitFor(() =>
      expect(vi.mocked(getExternalEgressConsent).mock.calls.length).toBeGreaterThan(before),
    )
  })

  it('Admin readonly：blockedReason=admin-readonly，不执行也不发 PATCH', async () => {
    vi.mocked(useResearchWorkspace).mockReturnValue({
      projectId: 'proj_1',
      role: 'admin_readonly',
      isOwner: false,
      isAdminReadonly: true,
    })
    const { result } = renderGlobalModel()
    await waitFor(() => expect(result.current.isLoadingModel).toBe(false))
    expect(result.current.isAdminReadonly).toBe(true)
    expect(result.current.canExecute).toBe(false)
    expect(result.current.blockedReason).toBe('admin-readonly')
    const operation = vi.fn(async () => 'ok')
    let outcome: string | undefined
    await act(async () => {
      outcome = await result.current.runGuarded(operation)
      await result.current.saveModel()
    })
    expect(operation).not.toHaveBeenCalled()
    expect(outcome).toBeUndefined()
    expect(patchExecutionPreferences).not.toHaveBeenCalled()
  })
})
