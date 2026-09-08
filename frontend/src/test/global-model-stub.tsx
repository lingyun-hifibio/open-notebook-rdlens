'use client'

/**
 * `use-research-global-model` 的测试替身（Issue #243 GMOD-FE-01）。
 *
 * 只用于「被测对象不是全局模型本身」的组件测试：这些测试不应依赖
 * models/consent 查询链路，否则每个面板测试都要重复铺一遍模型目录与
 * 外发确认 mock。配合 `src/lib/hooks/__mocks__/use-research-global-model`
 * 使用（Vitest `__mocks__` 约定），用例通过 `vi.mock(module)` 启用。
 *
 * 默认语义与真实实现在「本地已选模型」场景一致：confirmed 模型存在、
 * 可生成、runGuarded 立即执行（不弹确认）。需要其它场景（无模型、
 * Admin 只读、待确认）的用例通过 `setGlobalModelStub` 覆盖，并在
 * `beforeEach` 调 `resetGlobalModelStub` 复位。
 */
import type { ReactNode } from 'react'
import type {
  GuardedOperation,
  ResearchModelAvailability,
  ResearchModelBlockedReason,
  UseResearchGlobalModelResult,
} from '@/lib/hooks/use-research-global-model'
import type { ResearchEgressConsentResponse, ResearchModelOption } from '@/lib/research/types'

export const GLOBAL_MODEL_STUB_ID = 'm-local'

interface StubOverrides {
  confirmedModelId?: string | null
  canExecute?: boolean
  blockedReason?: ResearchModelBlockedReason
  /** true：runGuarded 登记后不执行（模拟等待/放弃确认） */
  deferGuarded?: boolean
  /**
   * deferGuarded 时把「已登记但未执行的 op + 模型快照」交给测试捕获
   * （二轮审查 N1：用于重放「consent 确认后执行登记 op」路径——组件
   * 卸载后确认完成仍执行 op，op 内生命周期守卫须拦截派发）。
   */
  onGuardedRegistered?: (operation: GuardedOperation<unknown>, modelId: string) => void
  models?: ResearchModelOption[]
  /** #358：后端 Coverage 能力（默认 false=fail-closed；用例可覆盖） */
  coverageAllSelected?: boolean
  /** 以下字段供 ModelBar/ConsentDialog 组件测试覆盖（默认语义见 useResearchGlobalModel） */
  draftModelId?: string | null
  isSavingModel?: boolean
  /** UIOPT-A（#57 评审 L4）：模型目录查询加载中（Trigger 不把暂未命中标 Unavailable） */
  isLoadingModel?: boolean
  saveModelError?: string | null
  needsConsent?: boolean
  isConsentPromptOpen?: boolean
  consentError?: string | null
  consentResponse?: ResearchEgressConsentResponse | null
  /** RWV2-11：派发登记的 Scope 摘要（弹窗展示用） */
  pendingScopeLabel?: string | null
  /** RWV2-42：派发登记的模型快照（弹窗 Model 行展示用） */
  pendingModelId?: string | null
  onCancelConsent?: () => void
  onConfirmConsent?: () => Promise<void>
  onRunGuarded?: () => void
  /**
   * RWV2-42：每次 runGuarded 调用回传本次 options（scopeLabel），供
   * 面板测试断言「consent Scope 行摘要与派发同源」。
   */
  onGuardedOptions?: (options?: { scopeLabel?: string }) => void
}

let overrides: StubOverrides = {}

/** 重置为默认（本地可用模型）语义；在 beforeEach 中调用 */
export function resetGlobalModelStub(): void {
  overrides = {}
}

/** 覆盖替身语义，供需要非默认场景的用例使用 */
export function setGlobalModelStub(next: StubOverrides): void {
  overrides = { ...overrides, ...next }
}

/** 与真实实现同语义：'none'/'loading' 无提示行 */
export function researchModelBlockedHint(
  reason: string,
  t: (key: string) => string,
): string {
  switch (reason) {
    case 'no-model':
      return t('research.globalModel.selectModelHint')
    case 'unavailable':
      return t('research.globalModel.unavailable')
    case 'saving':
      return t('research.globalModel.saving')
    case 'admin-readonly':
      return t('research.globalModel.adminReadonly')
    default:
      return ''
  }
}

export function ResearchGlobalModelProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function useResearchGlobalModel(): UseResearchGlobalModelResult {
  const confirmedModelId =
    overrides.confirmedModelId === undefined
      ? GLOBAL_MODEL_STUB_ID
      : overrides.confirmedModelId
  const models = overrides.models ?? [
    {
      model_id: GLOBAL_MODEL_STUB_ID,
      display_name: 'Local M',
      data_egress: false,
      interactive_context_levels: ['focused', 'document', 'workspace'],
    },
  ]
  const confirmedModel = models.find((m) => m.model_id === confirmedModelId) ?? null
  const hasModel = Boolean(confirmedModelId) && confirmedModel !== null
  const blockedReason: ResearchModelBlockedReason =
    overrides.blockedReason ?? (hasModel ? 'none' : 'no-model')
  const canExecute = overrides.canExecute ?? hasModel
  // 与真实实现同语义：null → none；非 null 但不在目录 → unavailable
  const confirmedModelAvailability: ResearchModelAvailability =
    confirmedModelId === null ? 'none' : confirmedModel !== null ? 'available' : 'unavailable'

  const runGuarded = async <T,>(
    operation: GuardedOperation<T>,
    options?: { scopeLabel?: string },
  ): Promise<T | undefined> => {
    if (!canExecute || confirmedModelId === null) return undefined
    overrides.onGuardedOptions?.(options)
    overrides.onRunGuarded?.()
    if (overrides.deferGuarded) {
      // 模拟真实 provider 的「登记不执行」：把 op + 模型快照交给测试捕获，
      // 让用例能在组件卸载后重放（consent 确认后的执行路径，N1）
      overrides.onGuardedRegistered?.(
        operation as GuardedOperation<unknown>,
        confirmedModelId,
      )
      return undefined
    }
    return operation(confirmedModelId)
  }

  return {
    confirmedModelId,
    draftModelId:
      overrides.draftModelId === undefined ? confirmedModelId : overrides.draftModelId,
    setDraftModelId: () => undefined,
    searchContextDefault: 'focused',
    saveSearchContext: async () => undefined,
    saveModel: async () => undefined,
    clearModel: async () => undefined,
    isSavingModel: overrides.isSavingModel ?? false,
    isLoadingModel: overrides.isLoadingModel ?? false,
    saveModelError: overrides.saveModelError ?? null,
    dismissSaveModelError: () => undefined,
    models,
    // #358：能力协商字段（stub 默认 false，与 fail-closed 一致；用例可覆盖）
    coverageAllSelected: overrides.coverageAllSelected ?? false,
    confirmedModel,
    confirmedModelIsExternal: confirmedModel?.data_egress === true,
    confirmedModelAvailability,
    canExecute,
    blockedReason,
    runGuarded,
    // RWV2-11（F5 同步）：接口新增字段，stub 必须提供（防 tsc 失败）
    pendingScopeLabel: overrides.pendingScopeLabel ?? null,
    pendingModelId: overrides.pendingModelId ?? null,
    needsConsent: overrides.needsConsent ?? false,
    isConsentPromptOpen: overrides.isConsentPromptOpen ?? false,
    isConsentInFlight: false,
    consentResponse:
      overrides.consentResponse === undefined ? null : overrides.consentResponse,
    invalidateConsent: () => undefined,
    cancelConsent: overrides.onCancelConsent ?? (() => undefined),
    confirmConsent: overrides.onConfirmConsent ?? (async () => undefined),
    consentError: overrides.consentError ?? null,
    isAdminReadonly: blockedReason === 'admin-readonly',
  }
}
