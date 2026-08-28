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
import type { ResearchModelOption } from '@/lib/research/types'

export const GLOBAL_MODEL_STUB_ID = 'm-local'

interface StubOverrides {
  confirmedModelId?: string | null
  canExecute?: boolean
  blockedReason?: ResearchModelBlockedReason
  /** true：runGuarded 登记后不执行（模拟等待/放弃确认） */
  deferGuarded?: boolean
  models?: ResearchModelOption[]
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
  const confirmedModelAvailability = (hasModel
    ? 'available'
    : 'none') as ResearchModelAvailability

  const runGuarded = async <T,>(
    operation: GuardedOperation<T>,
  ): Promise<T | undefined> => {
    if (!canExecute || confirmedModelId === null) return undefined
    if (overrides.deferGuarded) return undefined
    return operation(confirmedModelId)
  }

  return {
    confirmedModelId,
    draftModelId: confirmedModelId,
    setDraftModelId: () => undefined,
    searchContextDefault: 'focused',
    saveSearchContext: async () => undefined,
    saveModel: async () => undefined,
    clearModel: async () => undefined,
    isSavingModel: false,
    isLoadingModel: false,
    saveModelError: null,
    dismissSaveModelError: () => undefined,
    models,
    confirmedModel,
    confirmedModelIsExternal: confirmedModel?.data_egress === true,
    confirmedModelAvailability,
    canExecute,
    blockedReason,
    runGuarded,
    needsConsent: false,
    isConsentPromptOpen: false,
    isConsentInFlight: false,
    consentResponse: null,
    invalidateConsent: () => undefined,
    cancelConsent: () => undefined,
    confirmConsent: async () => undefined,
    consentError: null,
    dismissConsentError: () => undefined,
    isAdminReadonly: blockedReason === 'admin-readonly',
  }
}
