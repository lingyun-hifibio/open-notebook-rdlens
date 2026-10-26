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
import {
  QUERY_KEYS,
  RESEARCH_MUTATION_OPTIONS,
  adminReadonlyResearchIdentity,
  ownerResearchIdentity,
  researchEgressConsentIdentityKey,
  researchExecutionPreferencesIdentityKey,
  researchIdentityEquals,
  researchModelCatalogIdentityKey,
  type ResearchQueryIdentity,
} from '@/lib/api/query-client'
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
import { coverageAllSelectedFrom } from '@/lib/research/types'
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

/**
 * 显式「未派发/已派发」通知（DESIGN L200/L1120）：身份变化、consent 取消、
 * 被禁用时**不能只关弹窗/返回 undefined**，调用方据此释放 submit hold。
 */
export interface GuardedOperationCompletion {
  readonly dispatched: boolean
  readonly reason?: 'cancelled' | 'identity-changed' | 'blocked'
  readonly modelId: string | null
}

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
  /**
   * #358：后端 `coverage_all_selected` 能力（来自 GET models 顶层
   * capabilities）。缺失/非法/请求失败/加载中一律 false（fail-closed）；
   * 仅 true 才允许提交 all_selected。与模型目录同一次响应返回，避免
   * 两次请求间的能力竞态。
   */
  coverageAllSelected: boolean
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
   *
   * RWV2-11（K10/K11）：`options.scopeLabel` 为派发时登记的 Scope 摘要
   * （如 "2 sources · 1 note"），随登记单记录存续，弹窗只在有值且本次
   * 派发已登记时展示（K5）——禁止回读 provider 推导（弹窗摘要必须与
   * 最终请求同一快照）。
   */
  runGuarded: <T>(
    operation: GuardedOperation<T>,
    options?: {
      scopeLabel?: string
      /** PR5（D-22）：契约选择随登记冻结（确认后不再判定能力） */
      contract?: 'v1' | 'c05-v1'
      /** PR5（D-22）：请求信封随登记冻结（确认后原样派发） */
      envelope?: Readonly<Record<string, unknown>>
      /** PR5（D-22）：幂等键随登记冻结（确认后原样复用） */
      idempotencyKey?: string
      /** PR-1：未派发/已派发完成通知（consent 取消、身份失效、被禁用） */
      onCompletion?: (completion: GuardedOperationCompletion) => void
    },
  ) => Promise<T | undefined>
  /**
   * RWV2-11（K10）：本次待确认派发登记的 Scope 摘要；弹窗仅在其非空时
   * 显示 Scope 行。取消/确认/未登记派发 → null（不显示，防陈标泄漏）。
   */
  pendingScopeLabel: string | null
  /**
   * RWV2-42：本次待确认派发登记的**模型快照**（弹窗 Model 行数据源）。
   * 与执行使用同一快照（登记时捕获），绝不读 live confirmed——当前模型
   * 在登记后被改（跨标签/focus refetch）时，本值仍指向将实际执行的模型。
   * 取消/确认/未登记 → null。
   */
  pendingModelId: string | null
  /**
   * PR5（D-22）：本次登记的**冻结派发意图**（契约 / 请求信封 / 幂等键）。
   * 确认后只用这里的信封与键派发；取消/确认/未登记 → null。
   * 暴露出来的目的是让"同意流程与直发同键同信封"可被断言（T40）。
   */
  pendingConsentRegistration: {
    contract: 'v1' | 'c05-v1' | null
    envelope: Readonly<Record<string, unknown>> | null
    idempotencyKey: string | null
  } | null
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
  /** 最近一次确认失败的信息（弹窗内展示；登记保留可重试） */
  consentError: string | null
  /** Admin 只读：显示禁用控件，不发 PATCH，不执行 */
  isAdminReadonly: boolean
}

const ResearchGlobalModelContext = createContext<UseResearchGlobalModelResult | null>(null)

export function ResearchGlobalModelProvider({ children }: { children: ReactNode }) {
  const { projectId, isAdminReadonly, userId, role, authGeneration } = useResearchWorkspace()
  const queryClient = useQueryClient()

  // 判别身份（DESIGN §3.2）：owner 带 viewer，Admin 只读不带 viewer；查询键
  // 尾部追加身份段，认证代际/viewer 变化后旧缓存不可见。
  const researchIdentity = useMemo<ResearchQueryIdentity | null>(() => {
    const generation = authGeneration ?? 0
    if (role === 'admin_readonly') {
      return adminReadonlyResearchIdentity(projectId, generation)
    }
    if (!userId) return null
    return ownerResearchIdentity(projectId, userId, generation)
  }, [authGeneration, projectId, role, userId])
  const identityRef = useRef<ResearchQueryIdentity | null>(researchIdentity)
  identityRef.current = researchIdentity
  // runGuarded 必须绑定“调用时闭包携带的身份”，而不是执行时再读 ref：
  // 旧闭包在身份变化后不得用新身份重新通过校验（review F4）。
  const identityAtRender = researchIdentity

  const modelCatalogKey = researchIdentity
    ? researchModelCatalogIdentityKey(researchIdentity)
    : QUERY_KEYS.researchModelCatalog(projectId)
  const preferencesKey = researchIdentity
    ? researchExecutionPreferencesIdentityKey(researchIdentity)
    : QUERY_KEYS.researchExecutionPreferences(projectId)
  const consentKey = researchIdentity
    ? researchEgressConsentIdentityKey(researchIdentity)
    : QUERY_KEYS.researchEgressConsent(projectId)

  const [draftModelId, setDraftModelId] = useState<string | null>(null)
  const [saveModelError, setSaveModelError] = useState<string | null>(null)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [isConsentPromptOpen, setIsConsentPromptOpen] = useState(false)
  const [isConsentInFlight, setIsConsentInFlight] = useState(false)
  /** §6.8 single-flight：同一时刻只允许一个确认流程在途 */
  const consentInFlightRef = useRef(false)
  /**
   * RWV2-11（K10）：确认前登记的「执行体 + 模型快照 + 派发 Scope 摘要」单
   * 记录——三者同生共死，取消/确认成功时整体丢弃，杜绝 Scope 摘要陈标
   * 泄漏到下一次未登记派发（SourceChat/Insights/Transformation 等）。
   */
  interface PendingConsentRegistration {
    operation: GuardedOperation<unknown>
    modelId: string
    scopeLabel: string | null
    /**
     * PR5（D-22）：登记必须冻结**完整派发意图**，不只是模型快照 + Scope 摘要。
     * 若请求信封与幂等键在确认之后才构造，取消/重试就会换键——而 D-13 表①
     * 要求"未完成发出"时保留原键，同意流程会因此成为幂等漏洞。
     */
    contract: 'v1' | 'c05-v1' | null
    /** 冻结的请求信封（确认后**只用它**派发） */
    envelope: Readonly<Record<string, unknown>> | null
    /** 冻结的幂等键（确认后**只用它**派发；取消不得清除） */
    idempotencyKey: string | null
    /** 登记时捕获的认证身份（ACK 后/派发前复核；变化即不派发） */
    identity: ResearchQueryIdentity | null
    /** 未派发/已派发通知（释放 submit hold 用） */
    onCompletion?: (completion: GuardedOperationCompletion) => void
  }
  const pendingRegistrationRef = useRef<PendingConsentRegistration | null>(null)

  // Provider 卸载（登出/会话结束）后，迟到的 ACK/执行不得再触发执行体。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isIdentityCurrent = useCallback(
    (identity: ResearchQueryIdentity | null): boolean =>
      mountedRef.current && researchIdentityEquals(identity, identityRef.current),
    [],
  )

  const modelsQuery = useQuery({
    queryKey: modelCatalogKey,
    queryFn: () => listModels(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })
  const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data])
  // #358：能力协商——缺失/非法/未加载一律 false（fail-closed）。
  // 与模型目录同一次 GET models 返回，随 refetchOnWindowFocus 刷新，
  // 因此后端开关翻转后下一次窗口聚焦即生效（请求时刻真值）。
  const coverageAllSelected = useMemo(
    () => coverageAllSelectedFrom(modelsQuery.data?.capabilities),
    [modelsQuery.data],
  )

  const preferencesQuery = useQuery({
    queryKey: preferencesKey,
    queryFn: () => getExecutionPreferences(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })

  const consentQuery = useQuery({
    queryKey: consentKey,
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
      queryKey: consentKey,
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

  // 模型保存与 Search 上下文保存是两个独立 mutation：isSavingModel 只反映
  // 模型保存（不变量 3 的冻结范围），上下文保存不冻结生成入口；分离实例
  // 也避免并发保存共用 isPending 导致提前解冻。
  const patchPreferences = (input: Parameters<typeof patchExecutionPreferences>[1]) =>
    patchExecutionPreferences(projectId, input)

  /** 每次 PATCH 携带派发时捕获的身份：共享 ref 无法区分并发 mutation。 */
  interface PatchMutationVariables {
    readonly input: Parameters<typeof patchExecutionPreferences>[1]
    readonly identity: ResearchQueryIdentity | null
  }

  const onPatchSuccess = (
    saved: Awaited<ReturnType<typeof patchExecutionPreferences>>,
    variables: PatchMutationVariables,
  ) => {
    // 服务端响应即权威值：直接写入缓存（比 invalidate 更快且避免
    // 多标签页并发 PATCH 期间读到陈旧快照），仍保留 invalidate 语义。
    // PR-1：回填前校验**本次派发**的身份（旧代 PATCH 成功不得覆盖新代缓存）。
    if (!isIdentityCurrent(variables.identity)) return
    const currentIdentity = identityRef.current
    queryClient.setQueryData(
      currentIdentity
        ? researchExecutionPreferencesIdentityKey(currentIdentity)
        : QUERY_KEYS.researchExecutionPreferences(projectId),
      saved,
    )
  }

  const patchMutationOptions = {
    ...RESEARCH_MUTATION_OPTIONS,
    mutationFn: async ({ input, identity }: PatchMutationVariables) => {
      // 派发前校验（DESIGN L197）：身份已变化则不再发出旧身份请求。
      if (!isIdentityCurrent(identity)) {
        throw new Error('research patch superseded by new auth generation')
      }
      return patchPreferences(input)
    },
    onSuccess: onPatchSuccess,
  } as const

  const modelPatch = useMutation(patchMutationOptions)
  const contextPatch = useMutation(patchMutationOptions)

  const saveModel = useCallback(async (): Promise<void> => {
    if (isAdminReadonly || draftModelId === null) return
    const dispatchIdentity = identityRef.current
    setSaveModelError(null)
    try {
      // 只 PATCH preferred_model_id；成功后服务端权威值成为 confirmed
      // （draft 保留为用户选择，正常情况下两者相等）
      await modelPatch.mutateAsync({
        input: { preferred_model_id: draftModelId },
        identity: dispatchIdentity,
      })
    } catch (err) {
      // 身份已变化的失败结果不得写本地错误/回滚新代 draft。
      if (!isIdentityCurrent(dispatchIdentity)) return
      setSaveModelError(err instanceof Error ? err.message : String(err))
      // 失败丢弃 draft，回滚到服务端值（§6.1：refetch authority）；
      // 保存期间服务端值可能已变（如多标签页 refetch），闭包里的
      // confirmedModelId 可能是陈旧回滚目标——invalidate 让权威值自愈
      setDraftModelId(confirmedModelId)
      setDraftTouched(false)
      void queryClient.invalidateQueries({
        queryKey: preferencesKey,
      })
      throw err
    }
  }, [confirmedModelId, draftModelId, isAdminReadonly, isIdentityCurrent, modelPatch, projectId, queryClient])

  const clearModel = useCallback(async (): Promise<void> => {
    if (isAdminReadonly) return
    const dispatchIdentity = identityRef.current
    setSaveModelError(null)
    try {
      await modelPatch.mutateAsync({ input: { preferred_model_id: null }, identity: dispatchIdentity })
      // 旧代 clear 的迟到成功不得覆盖新代本地选择（review F3）。
      if (!isIdentityCurrent(dispatchIdentity)) return
      setDraftModelId(null)
      setDraftTouched(false)
    } catch (err) {
      if (!isIdentityCurrent(dispatchIdentity)) return
      setSaveModelError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [isAdminReadonly, isIdentityCurrent, modelPatch])

  const saveSearchContext = useCallback(
    async (level: ResearchContextLevel): Promise<void> => {
      if (isAdminReadonly) return
      // 只 PATCH default_context_level，不触碰模型（不变量 8）
      await contextPatch.mutateAsync({
        input: { default_context_level: level },
        identity: identityRef.current,
      })
    },
    [isAdminReadonly, contextPatch],
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

  const isSavingModel = modelPatch.isPending
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
    // 不变量 9：取消不创建/不改变任何执行状态；单记录整体丢弃（K10）。
    // PR-1：显式通知「执行未发生」（DESIGN L200/L1120），调用方释放 hold。
    const discarded = pendingRegistrationRef.current
    pendingRegistrationRef.current = null
    setIsConsentPromptOpen(false)
    setConsentError(null)
    discarded?.onCompletion?.({
      dispatched: false,
      reason: 'cancelled',
      modelId: discarded.modelId,
    })
  }, [isConsentInFlight])

  // RWV2-42（评审 R7-1）：登记后当前权威模型被改变（跨标签页 / focus
  // refetch）时，弹窗行与最终派发将不一致（Model 行=登记模型，目的地/
  // 类别=新模型 scope）→ 自动取消本次登记（零副作用，用户重试重新走
  // 确认）。ack 在途时跳过（cancelConsent 本身 no-op）。服务端 dispatch
  // gate（consent_scope_changed 403）仍是最终安全网。
  useEffect(() => {
    if (!isConsentPromptOpen || isConsentInFlight) return
    const registration = pendingRegistrationRef.current
    if (!registration) return
    // PR-1：登记身份随 token refresh/viewer 变化失效——确认后不得用新 token
    // 派发旧意图；显式通知「执行未发生」，不依赖 confirmConsent 的 ACK 后复核。
    if (!researchIdentityEquals(registration.identity, identityRef.current)) {
      pendingRegistrationRef.current = null
      setIsConsentPromptOpen(false)
      setConsentError(null)
      registration.onCompletion?.({
        dispatched: false,
        reason: 'identity-changed',
        modelId: registration.modelId,
      })
      return
    }
    if (confirmedModelId !== registration.modelId) {
      cancelConsent()
    }
  }, [cancelConsent, confirmedModelId, isConsentInFlight, isConsentPromptOpen])

  const confirmConsent = useCallback(async (): Promise<void> => {
    if (!isConsentPromptOpen || consentInFlightRef.current) return
    consentInFlightRef.current = true
    setIsConsentInFlight(true)
    // ACK 派发时捕获身份：ACK 在途换代时结果不得写进新代 consent 缓存。
    const ackIdentity = identityRef.current
    let acknowledged = false
    try {
      // acknowledge 的响应即服务端权威 consent 状态（§6.8 第 4 步）
      const updated = await acknowledgeExternalEgressConsent(projectId)
      if (isIdentityCurrent(ackIdentity)) {
        queryClient.setQueryData(
          ackIdentity
            ? researchEgressConsentIdentityKey(ackIdentity)
            : QUERY_KEYS.researchEgressConsent(projectId),
          updated,
        )
        setConsentError(null)
      }
      acknowledged = true
    } catch (err) {
      // acknowledge 失败：弹窗保持打开、登记保留可重试，并给出可见反馈
      //（不静默吞错，也不产生未处理 rejection）；身份已失效时不写新代错误。
      if (isIdentityCurrent(ackIdentity)) {
        setConsentError(err instanceof Error ? err.message : String(err))
      }
    }
    // 用登记时捕获的快照执行——不重新读取当前 confirmed（不变量 4）；
    // 登记仅在 acknowledge 成功后清除，失败时保留可重试（K10）
    const registration = pendingRegistrationRef.current
    if (acknowledged) {
      setIsConsentPromptOpen(false)
      pendingRegistrationRef.current = null
    }
    if (acknowledged && registration && registration.modelId) {
      // ACK 返回后、实际派发前复核身份（DESIGN L200）：身份已变化则显式
      // 通知「执行未发生」，不得拿新 token 派发旧意图。
      if (!isIdentityCurrent(registration.identity)) {
        registration.onCompletion?.({
          dispatched: false,
          reason: 'identity-changed',
          modelId: registration.modelId,
        })
        void refetchConsent()
      } else {
        // 执行失败也必须结算 completion（dispatched=true：执行体已调用），
        // 否则调用方的 submit hold 会悬挂（DESIGN L1120）。
        let dispatched = false
        try {
          dispatched = true
          await registration.operation(registration.modelId)
        } catch {
          // 执行体错误与 consent 状态无关（acknowledge 已成功、弹窗已关）：
          // 不写 consentError，避免下次弹窗误标「确认失败」；重拉服务端
          // consent，让下一次执行重新走确认判断
          void refetchConsent()
        } finally {
          registration.onCompletion?.({
            dispatched,
            modelId: registration.modelId,
          })
        }
      }
    }
    consentInFlightRef.current = false
    setIsConsentInFlight(false)
  }, [isConsentPromptOpen, isIdentityCurrent, projectId, queryClient, refetchConsent])

  const runGuarded = useCallback(
    async <T,>(
      operation: GuardedOperation<T>,
      options?: {
        scopeLabel?: string
        contract?: 'v1' | 'c05-v1'
        envelope?: Readonly<Record<string, unknown>>
        idempotencyKey?: string
        onCompletion?: (completion: GuardedOperationCompletion) => void
      },
    ): Promise<T | undefined> => {
      const snapshot = confirmedModelId
      // 绑定本次渲染时的身份：旧闭包调用时既有权限/consent 判断与身份一致，
      // 身份变化后 isIdentityCurrent 必然判旧（review F4）。
      const dispatchIdentity = identityAtRender
      if (!mountedRef.current) {
        options?.onCompletion?.({
          dispatched: false,
          reason: 'identity-changed',
          modelId: snapshot,
        })
        return undefined
      }
      if (!canExecute || snapshot === null) {
        options?.onCompletion?.({
          dispatched: false,
          reason: 'blocked',
          modelId: snapshot,
        })
        return undefined
      }
      if (!needsConsent) {
        // 直发路径同样先校验调用时刻的身份（DESIGN L197）。
        if (!isIdentityCurrent(dispatchIdentity)) {
          options?.onCompletion?.({
            dispatched: false,
            reason: 'identity-changed',
            modelId: snapshot,
          })
          return undefined
        }
        // 直发也必须显式 completion（释放 hold 不依赖 Promise finally）；
        // 执行体抛错时同样结算一次。completion 放在 try 之外，避免回调自身
        // 抛错导致二次结算或遮蔽执行体异常（review N2）。
        let result: T
        try {
          result = await operation(snapshot)
        } catch (error) {
          // completion 回调自身异常不得遮蔽执行体原异常（review N2）。
          try {
            options?.onCompletion?.({ dispatched: true, modelId: snapshot })
          } catch {
            // 释放 hold 的通知失败不改变执行结果语义
          }
          throw error
        }
        options?.onCompletion?.({ dispatched: true, modelId: snapshot })
        return result
      }
      // 外部模型且 consent 未生效：single-flight，只登记不执行。
      // pendingRegistrationRef（同步 ref）同时检查：同 tick 内第二次调用时
      // isConsentPromptOpen 仍是旧值，若只查 state 会覆盖第一次的登记。
      if (
        consentInFlightRef.current ||
        isConsentPromptOpen ||
        pendingRegistrationRef.current !== null
      ) {
        options?.onCompletion?.({
          dispatched: false,
          reason: 'blocked',
          modelId: snapshot,
        })
        return undefined
      }
      // K10 + PR5（D-22）：执行体 + 模型快照 + Scope 摘要 + **契约/信封/幂等键**
      // 单记录登记——确认后只用登记中的信封与键派发，取消不清键。
      pendingRegistrationRef.current = {
        operation: operation as GuardedOperation<unknown>,
        modelId: snapshot,
        scopeLabel: options?.scopeLabel ?? null,
        contract: options?.contract ?? null,
        envelope: options?.envelope ?? null,
        idempotencyKey: options?.idempotencyKey ?? null,
        identity: dispatchIdentity,
        onCompletion: options?.onCompletion,
      }
      setIsConsentPromptOpen(true)
      return undefined
    },
    [canExecute, confirmedModelId, identityAtRender, isConsentPromptOpen, isIdentityCurrent, needsConsent],
  )

  // K10：弹窗仅在打开且本次派发登记了 Scope 摘要时展示（K5）；未登记派发
  // （SourceChat/Insights/Transformation/GlobalModelBar 空操作）→ null。
  const pendingScopeLabel = isConsentPromptOpen
    ? pendingRegistrationRef.current?.scopeLabel ?? null
    : null

  // RWV2-42：弹窗 Model 行数据源 = 登记快照模型（与执行同源，非 live）。
  const pendingModelId = isConsentPromptOpen
    ? pendingRegistrationRef.current?.modelId ?? null
    : null

  // PR5（D-22）：登记中冻结的契约/信封/幂等键（可断言"同意流程与直发同键
  // 同信封"）；未登记或已确认/取消 → null。
  const pendingConsentRegistration = useMemo(() => {
    if (!isConsentPromptOpen) return null
    const registration = pendingRegistrationRef.current
    if (registration === null) return null
    return {
      contract: registration.contract,
      envelope: registration.envelope,
      idempotencyKey: registration.idempotencyKey,
    }
  }, [isConsentPromptOpen])

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
    coverageAllSelected,
    confirmedModel,
    confirmedModelIsExternal,
    confirmedModelAvailability,
    canExecute,
    blockedReason,
    runGuarded,
    pendingScopeLabel,
    pendingModelId,
    pendingConsentRegistration,
    needsConsent,
    isConsentPromptOpen,
    isConsentInFlight,
    consentResponse: consentQuery.data ?? null,
    invalidateConsent: refetchConsent,
    cancelConsent,
    confirmConsent,
    consentError,
    isAdminReadonly,
  }), [
    consentError,
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
    coverageAllSelected,
    draftModelId,
    isConsentInFlight,
    isConsentPromptOpen,
    isLoadingModel,
    isSavingModel,
    isAdminReadonly,
    models,
    needsConsent,
    pendingScopeLabel,
    pendingModelId,
    pendingConsentRegistration,
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

/**
 * blockedReason → 引导文案（各生成入口共用同一映射，避免文案漂移）。
 * 'none' / 'loading' 返回空串——可用或尚在加载（loading 由骨架/禁用表达，
 * 不需要额外提示行）。
 */
export function researchModelBlockedHint(
  reason: ResearchModelBlockedReason,
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
