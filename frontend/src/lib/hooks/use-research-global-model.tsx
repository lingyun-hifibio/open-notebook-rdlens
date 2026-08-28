'use client'

/**
 * Research 全局模型 provider（Issue #243 GMOD-FE-01，计划 §6.1/§6.8）。
 *
 * 在已认证的 Research 根节点挂载，集中加载模型目录、执行偏好与 Workspace
 * 外发 consent，并把状态分离为：
 *
 * - `draftModelId`：顶层下拉框当前候选（草稿不能执行，不变量 2）；
 * - `confirmedModelId`：服务端保存成功的权威值；所有生成入口只读它；
 * - `isSavingModel`：保存中冻结所有新生成入口（不变量 3，已有运行不取消）；
 * - `confirmedModelAvailability`：available/unavailable/none——已保存模型
 *   消失或禁用时保留展示并阻止生成，不自动改选（不变量 7）；
 * - `runGuarded`（§6.8）：Research 根级统一执行闸门，见下。
 *
 * 模型保存只 PATCH preferred_model_id；Search 上下文保存只 PATCH
 * default_context_level——两字段互不覆盖（不变量 8）。后端仍是安全权威
 * （不变量 5）；Admin readonly 时 blockedReason='admin-readonly'、不发
 * PATCH、不执行（§6.1）。
 *
 * ## 为什么执行必须经过 `runGuarded`
 *
 * §6.8 不变量 9 要求取消外发确认后不残留 turn/job/loading/idempotency
 * 状态。唯一稳妥的做法是：**确认完成前根本不调用执行函数**。因此
 * `runGuarded` 在需要确认时只登记待执行操作并打开弹窗，确认成功后才用
 * 调用当时捕获的模型快照执行；取消则直接丢弃登记，不产生任何状态。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QUERY_KEYS } from '@/lib/api/query-client'
import {
  acknowledgeExternalEgressConsent,
  getExecutionPreferences,
  getExternalEgressConsent,
  listModels,
  patchExecutionPreferences,
} from '@/lib/research/api'
import type {
  ResearchContextLevel,
  ResearchEgressConsentResponse,
  ResearchModelOption,
} from '@/lib/research/types'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'

export type ResearchModelAvailability = 'available' | 'unavailable' | 'none'

/**
 * 生成入口被禁用的原因。'none' 表示可用；其余值同时用于 UI 引导文案，
 * 不能笼统禁用——外部模型需要确认时入口仍可点击（点击后弹确认），因此
 * 「待确认」不是禁用原因。
 */
export type ResearchModelBlockedReason =
  | 'none'
  | 'loading'
  | 'saving'
  | 'no-model'
  | 'unavailable'
  | 'admin-readonly'

/** §6.8 受保护的执行体：接收调用时刻捕获的 confirmed model 快照。 */
export type GuardedOperation<T> = (modelId: string) => T | Promise<T>

export interface UseResearchGlobalModelResult {
  /** 服务端保存成功并确认的权威模型；null = 未选择（不自动改选） */
  confirmedModelId: string | null
  /** 顶层下拉框当前候选；保存成功后与 confirmed 同步 */
  draftModelId: string | null
  setDraftModelId: (modelId: string | null) => void
  /** 服务端 default_context_level（Search 初始档位） */
  searchContextDefault: ResearchContextLevel
  /** Search 局部档位的已保存默认值持久化（只 PATCH context） */
  saveSearchContext: (level: ResearchContextLevel) => Promise<void>
  saveModel: () => Promise<void>
  clearModel: () => Promise<void>
  isSavingModel: boolean
  isLoadingModel: boolean
  saveModelError: string | null
  dismissSaveModelError: () => void
  models: ResearchModelOption[]
  /** confirmed 模型条目；unavailable（目录中消失）时为 null */
  confirmedModel: ResearchModelOption | null
  confirmedModelIsExternal: boolean
  confirmedModelAvailability: ResearchModelAvailability
  /** 所有新生成入口的统一闸门：有可用模型、非保存中、非 Admin 只读 */
  canExecute: boolean
  /** 禁用原因（'none' 表示可用）；用于引导文案，不做隐式回退 */
  blockedReason: ResearchModelBlockedReason
  /**
   * §6.8 统一执行闸门。本地模型直接执行；外部模型且 consent 未生效时
   * 只登记操作并打开确认弹窗，确认完成后用捕获的快照执行。返回
   * `undefined` 表示本次未执行（被禁用、或等待/放弃确认）。
   */
  runGuarded: <T>(operation: GuardedOperation<T>) => Promise<T | undefined>
  /** consent 状态（§6.8） */
  needsConsent: boolean
  isConsentPromptOpen: boolean
  isConsentInFlight: boolean
  consentResponse: ResearchEgressConsentResponse | null
  /**
   * 让服务端 consent 重新生效判定（后端在 dispatch 侧拒绝时调用）。
   * 后端仍是最终权威：前端只据此决定下一次执行是否重新弹确认。
   */
  invalidateConsent: () => void
  cancelConsent: () => void
  confirmConsent: () => Promise<void>
  /** Admin 只读：显示禁用控件，不发 PATCH，不执行 */
  isAdminReadonly: boolean
}

const ResearchGlobalModelContext = createContext<UseResearchGlobalModelResult | null>(null)

export function ResearchGlobalModelProvider({ children }: { children: ReactNode }) {
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const queryClient = useQueryClient()

  const [draftModelId, setDraftModelId] = useState<string | null>(null)
  const [saveModelError, setSaveModelError] = useState<string | null>(null)
  const [isConsentPromptOpen, setIsConsentPromptOpen] = useState(false)
  const [isConsentInFlight, setIsConsentInFlight] = useState(false)
  /** §6.8 single-flight：同一时刻只允许一个确认流程在途 */
  const consentInFlightRef = useRef(false)
  /** 确认前登记的执行体与其模型快照；取消时整体丢弃 */
  const pendingOperationRef = useRef<GuardedOperation<unknown> | null>(null)
  const pendingModelIdRef = useRef<string | null>(null)

  const modelsQuery = useQuery({
    queryKey: QUERY_KEYS.researchModelCatalog(projectId),
    queryFn: () => listModels(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })
  const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data])

  const preferencesQuery = useQuery({
    queryKey: QUERY_KEYS.researchExecutionPreferences(projectId),
    queryFn: () => getExecutionPreferences(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })

  const consentQuery = useQuery({
    queryKey: QUERY_KEYS.researchEgressConsent(projectId),
    queryFn: () => getExternalEgressConsent(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })

  const confirmedModelId = preferencesQuery.data?.preferred_model_id ?? null
  const searchContextDefault =
    preferencesQuery.data?.default_context_level ?? 'focused'

  // draft 初始为 null；首次拿到服务端偏好后镜像 confirmed（用户尚未操作）。
  // 之后 draft 完全由用户驱动；保存失败回滚到 confirmed（§6.1）。
  const [draftTouched, setDraftTouched] = useState(false)
  useEffect(() => {
    if (!preferencesQuery.isSuccess || draftTouched) return
    setDraftModelId(preferencesQuery.data?.preferred_model_id ?? null)
  }, [draftTouched, preferencesQuery.data, preferencesQuery.isSuccess])

  // §6.8 第 6 步：切换 model/provider 时 refetch consent，不复用旧 destination
  const refetchConsent = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: QUERY_KEYS.researchEgressConsent(projectId),
    })
  }, [projectId, queryClient])

  const setDraft = useCallback(
    (modelId: string | null) => {
      setDraftTouched(true)
      setDraftModelId(modelId)
      refetchConsent()
    },
    [refetchConsent],
  )

  const preferencePatch = useMutation({
    mutationFn: (input: Parameters<typeof patchExecutionPreferences>[1]) =>
      patchExecutionPreferences(projectId, input),
    onSuccess: (saved) => {
      // 服务端响应即权威值：直接写入缓存（比 invalidate 更快且避免
      // 多标签页并发 PATCH 期间读到陈旧快照），仍保留 invalidate 语义
      queryClient.setQueryData(
        QUERY_KEYS.researchExecutionPreferences(projectId),
        saved,
      )
    },
  })

  const saveModel = useCallback(async (): Promise<void> => {
    if (isAdminReadonly || draftModelId === null) return
    setSaveModelError(null)
    try {
      // 只 PATCH preferred_model_id；成功后服务端权威值成为 confirmed
      // （draft 保留为用户选择，正常情况下两者相等）
      await preferencePatch.mutateAsync({ preferred_model_id: draftModelId })
    } catch (err) {
      setSaveModelError(err instanceof Error ? err.message : String(err))
      // 失败丢弃 draft，回滚到服务端值（§6.1：refetch authority）
      setDraftModelId(confirmedModelId)
      setDraftTouched(false)
      throw err
    }
  }, [confirmedModelId, draftModelId, isAdminReadonly, preferencePatch])

  const clearModel = useCallback(async (): Promise<void> => {
    if (isAdminReadonly) return
    setSaveModelError(null)
    try {
      await preferencePatch.mutateAsync({ preferred_model_id: null })
      setDraftModelId(null)
      setDraftTouched(false)
    } catch (err) {
      setSaveModelError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [isAdminReadonly, preferencePatch])

  const saveSearchContext = useCallback(
    async (level: ResearchContextLevel): Promise<void> => {
      if (isAdminReadonly) return
      // 只 PATCH default_context_level，不触碰模型（不变量 8）
      await preferencePatch.mutateAsync({ default_context_level: level })
    },
    [isAdminReadonly, preferencePatch],
  )

  const confirmedModel =
    models.find((model) => model.model_id === confirmedModelId) ?? null
  const confirmedModelIsExternal = confirmedModel?.data_egress === true

  const confirmedModelAvailability: ResearchModelAvailability =
    confirmedModelId === null
      ? 'none'
      : confirmedModel === null
        ? 'unavailable'
        : 'available'

  const isSavingModel = preferencePatch.isPending
  const isLoadingModel =
    modelsQuery.isLoading || preferencesQuery.isLoading || consentQuery.isLoading

  const blockedReason: ResearchModelBlockedReason = isAdminReadonly
    ? 'admin-readonly'
    : isSavingModel
      ? 'saving'
      : isLoadingModel
        ? 'loading'
        : confirmedModelAvailability === 'none'
          ? 'no-model'
          : confirmedModelAvailability === 'unavailable'
            ? 'unavailable'
            : 'none'
  const canExecute = blockedReason === 'none'

  // consent 是否需要：以服务端 valid 为准（§6.8 第 7 步：后端 dispatch gate
  // 仍是最终权威；前端判断只决定是否先展示确认）
  const needsConsent =
    confirmedModelIsExternal && consentQuery.data?.consent?.valid !== true

  const cancelConsent = useCallback(() => {
    // 已在途的确认不可取消（避免半执行），只丢弃尚未开始的登记
    if (isConsentInFlight) return
    // 不变零 9：取消不创建/不改变任何执行状态
    pendingOperationRef.current = null
    pendingModelIdRef.current = null
    setIsConsentPromptOpen(false)
  }, [isConsentInFlight])

  const confirmConsent = useCallback(async (): Promise<void> => {
    if (!isConsentPromptOpen || consentInFlightRef.current) return
    consentInFlightRef.current = true
    setIsConsentInFlight(true)
    try {
      // acknowledge 的响应即服务端权威 consent 状态（§6.8 第 4 步）
      const updated = await acknowledgeExternalEgressConsent(projectId)
      queryClient.setQueryData(
        QUERY_KEYS.researchEgressConsent(projectId),
        updated,
      )
      setIsConsentPromptOpen(false)
      // 用登记时捕获的快照执行——不重新读取当前 confirmed（不变量 4）
      const operation = pendingOperationRef.current
      const snapshot = pendingModelIdRef.current
      pendingOperationRef.current = null
      pendingModelIdRef.current = null
      if (operation && snapshot) await operation(snapshot)
    } finally {
      consentInFlightRef.current = false
      setIsConsentInFlight(false)
    }
  }, [isConsentPromptOpen, projectId, queryClient])

  const runGuarded = useCallback(
    async <T,>(operation: GuardedOperation<T>): Promise<T | undefined> => {
      const snapshot = confirmedModelId
      if (!canExecute || snapshot === null) return undefined
      if (!needsConsent) return operation(snapshot)
      // 外部模型且 consent 未生效：single-flight，只登记不执行
      if (consentInFlightRef.current || isConsentPromptOpen) return undefined
      pendingModelIdRef.current = snapshot
      pendingOperationRef.current = operation as GuardedOperation<unknown>
      setIsConsentPromptOpen(true)
      return undefined
    },
    [canExecute, confirmedModelId, isConsentPromptOpen, needsConsent],
  )

  const value = useMemo<UseResearchGlobalModelResult>(() => ({
    confirmedModelId,
    draftModelId,
    setDraftModelId: setDraft,
    searchContextDefault,
    saveSearchContext,
    saveModel,
    clearModel,
    isSavingModel,
    isLoadingModel,
    saveModelError,
    dismissSaveModelError: () => setSaveModelError(null),
    models,
    confirmedModel,
    confirmedModelIsExternal,
    confirmedModelAvailability,
    canExecute,
    blockedReason,
    runGuarded,
    needsConsent,
    isConsentPromptOpen,
    isConsentInFlight,
    consentResponse: consentQuery.data ?? null,
    invalidateConsent: refetchConsent,
    cancelConsent,
    confirmConsent,
    isAdminReadonly,
  }), [
    refetchConsent,
    blockedReason,
    canExecute,
    cancelConsent,
    confirmConsent,
    consentQuery.data,
    confirmedModel,
    confirmedModelAvailability,
    confirmedModelId,
    confirmedModelIsExternal,
    draftModelId,
    isConsentInFlight,
    isConsentPromptOpen,
    isLoadingModel,
    isSavingModel,
    isAdminReadonly,
    models,
    needsConsent,
    runGuarded,
    saveModel,
    saveModelError,
    saveSearchContext,
    searchContextDefault,
    setDraft,
    clearModel,
  ])

  return (
    <ResearchGlobalModelContext.Provider value={value}>
      {children}
    </ResearchGlobalModelContext.Provider>
  )
}

export function useResearchGlobalModel(): UseResearchGlobalModelResult {
  const value = useContext(ResearchGlobalModelContext)
  if (value === null) {
    throw new Error('research global model provider is not available')
  }
  return value
}
