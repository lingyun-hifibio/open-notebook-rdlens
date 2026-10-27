'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { createCoverageChat, newIdempotencyKey, searchV1 } from '@/lib/research/api'
import { buildSubmissionKey } from '@/lib/research/session-idempotency'
import { useResearchC05 } from '@/lib/hooks/use-research-c05'
import { buildC05GeneratedRequest, buildSourceScope } from '@/lib/research/c05-request'
import { signatureOf } from '@/lib/research/c05-idempotency-key'
import {
  useResearchChat,
  type CoverageSubmitAccepted,
  type CoverageSubmitOutcome,
  type CoverageSubmitRequest,
  type ResearchChatSelection,
  type UseResearchChatSessionOptions,
  deriveScopeSnapshot,
} from '@/lib/hooks/use-research-chat'
import { formatScopeLabel, useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import {
  useResearchSessionRuntimeOptional,
  useSessionSnapshot,
} from '@/lib/hooks/research-session-runtime'
import { useResearchEditor } from '@/lib/hooks/use-research-editor'
import { researchModelBlockedHint, useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { useResearchNotes, useResearchSources } from '@/lib/hooks/use-research'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchJobsController } from './ResearchJobsProvider'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import {
  ResearchChatPanel,
  type BackgroundJobSubmitResult,
} from './ResearchChatPanel'
import { ComparePanel } from './ComparePanel'
import { MindMapPlaceholder } from './MindMapPlaceholder'
import { TransformationsPanel } from './TransformationsPanel'
import {
  RESEARCH_MAIN_ACTIONS,
  type ResearchMainAction,
} from './research-main-action'
import { canJumpToCitation, resolveCitationCandidate, resolveCitationSource } from './citation-utils'
import type { ResearchSource } from '@/lib/types/research'
import type { ResearchScopeBarNoteOption, ResearchScopeBarSourceOption } from '@/lib/research/types'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ConversationController } from '@/lib/research/session-runtime'
import type { ResearchConversationSnapshot } from '@/lib/research/types'
import type { ResearchCitation } from '@/lib/types/research'
import type { ResearchChatRequest } from '@/lib/research/types'

/**
 * RWV2-40（Fork #44）：主工作区（Main workspace）组合。
 *
 * 目标 IA（RFC §2，v9 冻结；#445 扩展）：主区固定为五个研究动作——
 * evidence-search / research-chat / compare / mind-map（占位，coming
 * soon）/ run-template（用户可见文案为 Custom Analysis，内部动作标识
 * 不变；Jobs 迁往 Header 的 Activity 兼容壳，不再占用主区动作位）。
 * 动作与保活由组合根（ResearchPageContent）控制：`activeAction` 受控
 * 下发，本组件维护 `visited` 集合 + 渲染期派生，实现「首次访问后
 * 保活」。
 *
 * 资源查询（useResearchSources/Notes）与 reconcile 逻辑留在本组件
 * （R8-1a 选 a：与 Header 同 key 多 observer，共享单一查询缓存；Header
 * 的 Current scope 摘要只观察状态，不产生第二网络请求）。
 *
 * keep-alive 实现（Radix Tabs + forceMount + data-state）：
 * - `visited` 保存已访问动作；渲染期求并集（visited ∪ {activeAction}），
 *   保证切换动作的同一帧就挂载对应 pane（避免空帧）；
 * - 已访问的非活动 pane 加 `forceMount` + `data-[state=inactive]:hidden`
 *   （保持 DOM、隐藏但不卸载），活动 pane 不加隐藏；
 * - 未访问动作不渲染 TabsContent —— 不产生空请求，首访才挂载内容
 *   （如 TransformationsPanel 只在首次进入 run-template 时挂载一次）；
 * - 注意：useResearchChat/useResearchJobsController/useResearchSources 等
 *   全部保持在组件层，绝不放入会被卸载的 TabsContent 内（保活前提）。
 *
 * Admin 只读（isAdminReadonly）：Chat 的 coverage retry 回调省略（叶子
 * 组件在无回调时不渲染按钮）；Compare 维持 modelBlocked（canExecute 已
 * 含 admin-readonly）；后端授权仍是最终权威。
 */
export interface ResearchWorkspaceProps {
  /** 主区当前动作（组合根控制；跨区 Tools→run-template 也经此） */
  activeAction: ResearchMainAction
  onActiveActionChange: (action: ResearchMainAction) => void
  /** 全局工作区可见（!sourceFocusActive）；隐藏时 Search preview 停 */
  surfaceActive: boolean
  /** Citation → 组合根：选源 + source focus + 高亮目标页 */
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
  /** Edit scope → 组合根统一链路（退 focus/最大化 → 左栏编辑面） */
  onEditScopeAllStates: () => void
  /** RWV2-23（AC4）：Continue research → 打开 Chat 并预填（根级 draft） */
  onOpenResearchChatDraft?: (text: string) => void
  /** RWV2-23（AC3）：保存成功后跳转左栏 Notes/Insights 并高亮 */
  onRevealSavedArtifact?: (kind: 'note' | 'insight', artifactId: string) => void
  /** RWV2-23（AC4）：Chat composer 预填草稿（seq 递增触发） */
  chatPrefill?: { text: string; seq: number } | null
}

export function ResearchWorkspace({
  activeAction,
  onActiveActionChange,
  surfaceActive,
  onCitationJump,
  onEditScopeAllStates,
  onOpenResearchChatDraft,
  onRevealSavedArtifact,
  chatPrefill,
}: ResearchWorkspaceProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const scopeApi = useResearchScope()
  const { reconcileSelection } = scopeApi
  const sourcesQuery = useResearchSources(projectId)
  const notesQuery = useResearchNotes(projectId)
  const sources = useMemo(() => sourcesQuery.data?.items ?? [], [sourcesQuery.data])
  const notes = useMemo(() => notesQuery.data?.items ?? [], [notesQuery.data])

  // PR-4：Chat 草稿/范围/锚点的真源＝当前全局会话 editor（DESIGN §5.3/§5.4）。
  // 未装配 session runtime 的宿主保持旧本地输入回退（PR-5a 移除）。
  const sessionRuntime = useResearchSessionRuntimeOptional()
  // 订阅运行时快照，capabilities 就绪后能重新评估发送门禁（§6.1 条件 2）；
  // 无 Provider 的宿主返回冻结的 server snapshot（capabilities=null）。
  const runtimeSnapshot = useSessionSnapshot()
  const activeGlobalRef = sessionRuntime?.active('global') ?? null
  const chatEditor = useResearchEditor({
    kind: 'global',
    sessionId: activeGlobalRef?.sessionId ?? '',
    enabled: sessionRuntime !== null && activeGlobalRef !== null,
  })
  const chatEditorSnapshot = sessionRuntime === null ? undefined : chatEditor.snapshot
  // §6.1 条件 2：submission capability 未就绪时 composer 必须禁用并给稳定原因。
  const chatSubmissionReady =
    sessionRuntime === null
      ? undefined
      : runtimeSnapshot.capabilities?.submissionReady.global === true
  const pendingSubmitTextRef = useRef<string | null>(null)
  // PR-5b（Codex P1-#1）：清稿 ACK 必须回报 controller（`clear_settled`），
  // 否则 `clearPending` 永挂、下一次发送被 `clear_settlement_pending` 拒绝。
  const chatControllerRef = useRef<ConversationController | null>(null)
  // Codex 第 2 轮 P1-#1：清稿 ACK 必须结算给**发起清稿的** controller（切换
  // 会话后 chatControllerRef 已指向新会话，不能拿“当前”实例结算）。
  const pendingClearControllersRef = useRef(new Map<string, ConversationController>())
  // PR-5b（D1，第 1 处）：把运行时 + 当前会话 ref + editor 持有者回调传给
  // useResearchChat——controller 是 trace 新协议的唯一权威（不再依赖 legacy）。
  const chatSession = useMemo<UseResearchChatSessionOptions | undefined>(() => {
    if (sessionRuntime === null || activeGlobalRef === null) return undefined
    return {
      runtime: sessionRuntime,
      ref: activeGlobalRef,
      onReleaseHold: (operationId: string) => chatEditor.release(operationId),
      // §9.2/§5.6：editor 的清稿核对需要“提交时的文本快照”（ResearchAcceptedReceipt
      // 不含正文），由发送派发处冻结；文本已被改动时 editor 会判定 invalid 不清稿。
      onClearAfterSubmission: (receipt, operationId) => {
        void chatEditor
          .clearAfterSubmission(
            {
              sessionRef: receipt.ref,
              draftToken: receipt.draftToken,
              editorRevision: receipt.editorRevision,
              text: pendingSubmitTextRef.current ?? '',
            },
            operationId,
          )
          .then((outcome) => {
            const controller = pendingClearControllersRef.current.get(operationId) ?? null
            pendingClearControllersRef.current.delete(operationId)
            // 清稿失败/被覆盖也必须结算，否则 hold 与后续发送永久阻塞。
            const settled =
              outcome === 'cleared'
                ? 'cleared'
                : outcome === 'superseded' || outcome === 'cancelled'
                  ? 'superseded'
                  : outcome === 'unsynced'
                    ? 'failed'
                    : 'blocked'
            controller?.notifyClearSettled(operationId, settled)
          })
      },
    }
  }, [sessionRuntime, activeGlobalRef, chatEditor])
  // 范围条只读投影：不读写工作区选择器（DESIGN §5.3）。
  const scopeBarSources = useMemo<ResearchScopeBarSourceOption[]>(
    () =>
      sources
        .filter(
          (source): source is ResearchSource & { source_id: string } =>
            source.source_id !== null,
        )
        .map((source) => ({
          sourceId: source.source_id,
          title: source.document_id,
          unavailable: source.status !== 'ready',
        })),
    [sources],
  )
  const scopeBarNotes = useMemo<ResearchScopeBarNoteOption[]>(
    () => notes.map((note) => ({ noteId: note.note_id, title: note.title })),
    [notes],
  )
  const loading = sourcesQuery.isLoading || notesQuery.isLoading
  const loadError = sourcesQuery.error ?? notesQuery.error
  const loadErrorText =
    loadError instanceof Error ? loadError.message : loadError === null ? null : String(loadError)

  // R8-1a：资源查询留在本组件 —— reconcile 成功后清理失效选中并 toast。
  useEffect(() => {
    if (!sourcesQuery.isSuccess && !notesQuery.isSuccess) return
    const removed = reconcileSelection(
      sourcesQuery.isSuccess
        ? sources
            .filter((source): source is ResearchSource & { source_id: string } =>
              source.source_id !== null && (source.status === 'ready' || source.status === 'stale'))
            .map((source) => source.source_id)
        : undefined,
      notesQuery.isSuccess ? notes.map((note) => note.note_id) : undefined,
    )
    if (removed.sourceIds.length + removed.noteIds.length > 0) {
      toast({
        title: t('research.layout.scope.modeLabel'),
        description: t('research.layout.scope.reconciled'),
      })
    }
  }, [notes, notesQuery.isSuccess, reconcileSelection, sources, sourcesQuery.isSuccess, t, toast])

  // ── Jobs 控制器（ResearchJobsProvider 唯一实例化点；Chat coverage /
  //    Compare 创建共享同一 3s 轮询控制器） ──
  const {
    jobs,
    isCreating,
    error: jobsError,
    errorCode: jobsErrorCode,
    createCompare: createCompareJob,
    registerCoverageJob,
    retryCoverage,
    refreshActivity,
  } = useResearchJobsController()

  // Chat SSE 状态机保持组件层（切动作/隐藏不中断流与刷新恢复）
  // PR5（C6）：C-05 能力（与 models 同 query key 共享缓存）；bindSession
  // 复用组件顶部唯一 scopeApi（D-04 会话绑定）
  const c05 = useResearchC05(projectId ?? '')
  const bindSingleSession = scopeApi.bindSession
  const {
    turns,
    isStreaming,
    backgroundNotice,
    send: sendTurn,
    sendCoverage,
    resolveChatOrigin,
    getCurrentSessionId,
    conversation: chatConversation,
    sessionMeta,
    sessionCards,
    submissionLookup,
    markerWriteFailed,
    refreshMarkerLookups,
  } = useResearchChat({
    projectId: projectId ?? '',
    // PR5（C6/C7）：C-05 契约判定（能力就绪才走 c05-v1）+ 会话绑定回调（D-04）
    c05DispatchReady: () => c05.dispatchReady('chat'),
    onBindSession: bindSingleSession,
    // PR-5b（D1）：显式会话时启用 session-v1 controller（新协议唯一发送路径）
    session: chatSession,
  })
  chatControllerRef.current = chatConversation ?? null

  // #243 §6.4：Chat/Compare 统一走顶层执行守卫（invariant 9）
  // #358：models 响应顶层能力——覆盖全部所选来源只在后端
  // coverage_all_selected 为 true 时允许提交（false/缺失/加载中 fail-closed）。
  const { runGuarded, canExecute, blockedReason, coverageAllSelected, confirmedModelId } = useResearchGlobalModel()
  const blockedHint = researchModelBlockedHint(blockedReason, t)

  // ── keep-alive visited 集合：渲染期并集保证新动作首帧即挂载 ──
  const [visited, setVisited] = useState<ResearchMainAction[]>(() => [activeAction])
  useEffect(() => {
    setVisited((prev) => (prev.includes(activeAction) ? prev : [...prev, activeAction]))
  }, [activeAction])
  const mountedActions = useMemo(() => {
    const set = new Set(visited)
    set.add(activeAction)
    return [...set]
  }, [visited, activeAction])

  const retryResources = useCallback(() => {
    void sourcesQuery.refetch()
    void notesQuery.refetch()
  }, [notesQuery, sourcesQuery])

  /**
   * PR5（D-22）：Chat 在同意登记前冻结的幂等键（按逻辑提交签名持有）。
   * 取消 → 保留（重试复用原键）；已派发 → 清空（同题重问 = 新执行）。
   */
  const pendingChatKeyRef = useRef<{ signature: string; key: string } | null>(null)

  const sendChat = useCallback(    async (
      query: string,
      selection: ResearchChatSelection | undefined,
    ): Promise<boolean> => {
      // RWV2-11（K11）+ PR5：selection 缺省时按 provider 生效快照（含 single）
      const effectiveSelection: ResearchChatSelection = selection ?? {
        mode: scopeApi.getSnapshot().mode,
        sourceIds: [...scopeApi.getSnapshot().sourceIds],
        noteIds: [...scopeApi.getSnapshot().noteIds],
        singleSourceId: scopeApi.getSnapshot().singleSourceId,
      }
      // consent 摘要与最终请求同一快照（K11）
      const scopeLabel = formatScopeLabel(deriveScopeSnapshot(effectiveSelection), t)
      // PR5（D-22）：幂等键与契约在**登记之前**冻结。取消 → 保留（重试复用
      // 原键，D-13 表①）；真正派发过 → 丢弃（同样的提问再问一次即新执行，
      // D-13 表②）。签名只用于判定"是否同一次逻辑提交"。
      const frozen = deriveChatSubmission(
        effectiveSelection,
        query,
        confirmedModelId,
        c05.dispatchReady('chat') ? 'c05-v1' : 'v1',
        // 评审 MEDIUM-11：会话身份在**登记时**冻结（此前由 hook 在派发时刻
        // 注入，导致登记体与实际 wire 请求不同源）
        getCurrentSessionId(),
      )
      const held = pendingChatKeyRef.current
      const frozenKey = held !== null && held.signature === frozen.signature
        ? held.key
        : newIdempotencyKey()
      pendingChatKeyRef.current = { signature: frozen.signature, key: frozenKey }
      const sent = await runGuarded(
        (modelId) => {
          // D-22（评审 HIGH-1）：键必须在**真正派发的那一刻**释放，而不是在
          // runGuarded 返回时——需要 consent 时 runGuarded 只登记并返回
          // undefined，此时若不清键，确认后已完成的同一问题再问一次会复用
          // 旧键 → 命中服务端重放（拿到旧答案，D-13 表② 违规）。
          // 用键身份比对，避免释放掉后来者持有的新键。
          if (pendingChatKeyRef.current?.key === frozenKey) {
            pendingChatKeyRef.current = null
          }
          sendTurn(query, effectiveSelection, modelId, frozenKey, frozen.contract, frozen.request)
          return true
        },
        {
          scopeLabel,
          contract: frozen.contract,
          // D-22：登记的**就是**将要发出的 wire 请求（逐字段同源）
          envelope: frozen.request as unknown as Record<string, unknown>,
          idempotencyKey: frozenKey,
        },
      )
      // 取消/未放行：键保留（D-13 表①，重试复用原键）；已派发的清除在上面的
      // operation 内完成（对 consent 路径同样生效）。
      return sent === true
    },
    [confirmedModelId, runGuarded, scopeApi, sendTurn, t],
  )

  // Issue #439：persistent_job_required（不可重试）→ 用该 turn 冻结的 Scope
  // 经 v1 Search 端点重跑为持久化 Job；经 runGuarded（consent/执行守卫）与
  // 组合根一致，受理后刷新 Jobs 控制器。
  // 幂等键按 turnKey 复用：同一次点击重放（含守卫重试）不产生第二个 Job。
  const backgroundJobKeys = useRef<Map<string, string>>(new Map())

  const runChatAsBackgroundJob = useCallback(
    async (
      query: string,
      snapshot: ResearchScopeSnapshot,
      turnKey: string,
    ): Promise<BackgroundJobSubmitResult> => {
      // PR5（D-26）：CTA 属 Search 端点的另一派发点，纳入 D-11 矩阵——
      // `all` 在旧 v1 契约下无法表达 → 阻断（不发空 ID 集）；C-05 就绪时
      // 走 source_scope 分支。
      const useC05 = c05.dispatchReady('search')
      if (snapshot.mode !== 'selected' && !useC05) {
        // D-26/D-11：区分"被范围语义阻断"与"提交失败"——否则 UI 只能给
        // 通用失败文案，而 D-11 明确要求"请先选择资料"。
        return { status: 'blocked_scope' }
      }
      let idempotencyKey = backgroundJobKeys.current.get(turnKey)
      if (idempotencyKey === undefined) {
        idempotencyKey = newIdempotencyKey()
        backgroundJobKeys.current.set(turnKey, idempotencyKey)
      }
      const outcome = await runGuarded(
        async (modelId) => {
          const response = useC05
            ? await searchV1(
                projectId ?? '',
                buildC05GeneratedRequest(
                  {
                    mode: snapshot.mode,
                    sourceIds: snapshot.sourceIds,
                    noteIds: snapshot.noteIds,
                    singleSourceId: snapshot.singleSourceId,
                  },
                  { query, model_id: modelId, mode: 'auto', context_level: 'focused' },
                ),
                { idempotencyKey, contract: 'c05-v1' },
              )
            : await searchV1(
                projectId ?? '',
                {
                  query,
                  source_ids: [...snapshot.sourceIds],
                  note_ids: [...snapshot.noteIds],
                  mode: 'auto',
                  model_id: modelId,
                  context_level: 'focused',
                },
                { idempotencyKey },
              )
          // 202 = 已受理（job_id 缺失只提示刷新，不得报失败——否则重复提交）
          return response.kind === 'background'
            ? ({ status: 'queued', jobId: response.job_id ?? null } as const)
            : ({ status: 'failed' } as const)
        },
        { scopeLabel: formatScopeLabel(snapshot, t) },
      )
      // undefined = 守卫未执行（确认被取消等）：不算失败，交由用户再次点击
      if (outcome === undefined) return { status: 'not_dispatched' }
      if (outcome.status === 'queued') refreshActivity()
      return outcome
    },
    [c05, projectId, runGuarded, refreshActivity, t],
  )

  const createCompare = useCallback(
    async (
      documentIds: readonly string[],
      groupSize?: number,
    ): Promise<boolean> => {
      const scopeLabel = formatScopeLabel(
        {
          mode: 'selected',
          sourceIds: [...documentIds],
          noteIds: [],
          singleSourceId: null,
        },
        t,
      )
      const sent = await runGuarded(
        (modelId) => {
          createCompareJob(documentIds, modelId, groupSize)
          return true
        },
        { scopeLabel },
      )
      return sent === true
    },
    [createCompareJob, runGuarded, t],
  )

  // COV-09：all_selected 受理后登记进 Jobs 控制器（localStorage + 轮询）
  const submitCoverage = useCallback(
    async (
      request: CoverageSubmitRequest,
      idempotencyKey: string,
    ): Promise<CoverageSubmitAccepted> => {
      // R1-H7：Coverage 的 C-05 分支——能力就绪才走 c05-v1 + source_scope；
      // 旧契约保持既有形状（coverage_all_selected 能力仍是独立门禁）。
      const useC05 = c05.dispatchReady('coverage')
      const accepted = await createCoverageChat(
        projectId ?? '',
        useC05
          ? {
              query: request.query,
              note_ids: [],
              model_id: request.model_id,
              synthesis_scope: 'all_selected',
              source_scope: buildC05GeneratedRequest(
                {
                  mode: request.scopeMode ?? 'selected',
                  sourceIds: request.source_ids,
                  noteIds: [],
                  singleSourceId: request.singleSourceId ?? null,
                },
                { query: request.query, model_id: request.model_id },
              ).source_scope,
            }
          : {
              query: request.query,
              source_ids: request.source_ids,
              note_ids: request.note_ids,
              model_id: request.model_id,
              synthesis_scope: 'all_selected',
            },
        idempotencyKey,
        useC05 ? { contract: 'c05-v1' } : {},
      )
      // DESIGN §9.6：Jobs 登记失败**仍是已受理**——如实交出登记状态与可查回
      // 标识，绝不伪装成未受理（否则面板会误清/误导重提）。
      let registration: 'registered' | 'failed' = 'registered'
      try {
        registerCoverageJob(accepted.job_id)
      } catch {
        registration = 'failed'
      }
      return {
        job_id: accepted.job_id,
        generation_id: accepted.generation_id,
        registration,
      }
    },
    [c05, projectId, registerCoverageJob],
  )

  const sendCoverageChat = useCallback(
    (query: string, snapshot: ResearchScopeSnapshot): Promise<CoverageSubmitOutcome> => {
      const scopeLabel = formatScopeLabel(snapshot, t)
      // PR-5b（Codex P1-#5）：需要用户 confirmation 时 `runGuarded` 会先返回
      // undefined，真正派发发生在确认之后——必须用 onCompletion 把延迟执行的
      // 真实 outcome（accepted / 登记失败 / 失败）回传给面板，否则面板会把
      // “已受理”误当成未派发（不清稿、不显示可查回标识）。
      return new Promise<CoverageSubmitOutcome>((resolve) => {
        let settled = false
        let sawCompletion = false
        const finish = (outcome: CoverageSubmitOutcome): void => {
          if (settled) return
          settled = true
          resolve(outcome)
        }
        void runGuarded(
          async (modelId) => {
            const outcome = await sendCoverage(
              query,
              {
                mode: snapshot.mode,
                sourceIds: [...snapshot.sourceIds],
                noteIds: [],
                singleSourceId: snapshot.singleSourceId,
              },
              modelId,
              submitCoverage,
            )
            finish(outcome)
            return outcome
          },
          {
            scopeLabel,
            onCompletion: (completion) => {
              sawCompletion = true
              // consent 取消/身份失效/被禁用：未派发（零副作用），绝不伪装已受理。
              if (!completion.dispatched) finish({ status: 'not_dispatched' })
            },
          },
        ).then((outcome) => {
          if (outcome !== undefined) {
            finish(outcome)
            return
          }
          // Codex 第 2 轮 P1-#5：consent 已登记时 runGuarded 先返回 undefined
          // 且**不会**同步回调 onCompletion——此时必须等待用户确认后的真实
          // outcome，不能立即 resolve not_dispatched（会永久丢弃 accepted）。
          if (sawCompletion) finish({ status: 'not_dispatched' })
        })
      })
    },
    [runGuarded, sendCoverage, submitCoverage, t],
  )

  // PR-5b（D1，第 2/3 处）：session 模式下 Chat 发送只走 controller.send。
  // editor hold→flush→send 的顺序与冻结快照由本组合根负责；面板只负责 UI。
  const sendSessionChat = useCallback(
    async (query: string, selection: ResearchChatSelection): Promise<boolean> => {
      if (chatConversation === null || chatConversation === undefined) return false
      const targetSessionId = activeGlobalRef?.sessionId ?? ''
      if (targetSessionId === '') return false
      const base = deriveScopeSnapshot(selection)
      const scopeSnapshot = selection.mode === 'selected' && selection.sourceIds !== undefined
        ? { mode: 'selected' as const, sourceIds: [...selection.sourceIds], noteIds: [...(selection.noteIds ?? [])], singleSourceId: selection.singleSourceId ?? null }
        : { mode: base.mode, sourceIds: [...base.sourceIds], noteIds: [...base.noteIds], singleSourceId: base.singleSourceId }
      const scopeLabel = formatScopeLabel(scopeSnapshot, t)
      const sent = await runGuarded(
        async (modelId) => {
          const operationId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `op_${Date.now()}_${Math.random().toString(36).slice(2)}`
          chatEditor.hold('submit', operationId)
          const flushed = await chatEditor.flush('submit')
          // §9.3/I4：只有“已保存/无需保存”才允许发送；queued（未确认）、
          // conflict/blocked/readonly/unsynced/invalid 一律不得带旧版本发送。
          if (flushed !== 'saved' && flushed !== 'skipped') {
            chatEditor.release(operationId)
            return false
          }
          // 用绑定 editor controller 的**保存后**快照（不是发送前的 React
          // 快照）：保存期间用户可能又输入/改范围，旧快照会让 wire revision
          // 落后一版（Codex P1-#2）。
          const editorController = chatEditor.controller
          const editor = editorController?.getSnapshot() ?? null
          if (editor === null || editor.draftText !== query) {
            pendingSubmitTextRef.current = null
            chatEditor.release(operationId)
            return false
          }
          const freshScope =
            editor.singleSourceId !== null
              ? {
                  mode: 'single' as const,
                  sourceIds: [] as string[],
                  noteIds: [...editor.noteIds],
                  singleSourceId: editor.singleSourceId,
                }
              : {
                  mode: (editor.baseScope?.mode ?? 'all') as ResearchScopeSnapshot['mode'],
                  sourceIds: editor.baseScope !== null ? [...editor.baseScope.sourceIds] : [],
                  noteIds: [...editor.noteIds],
                  singleSourceId: null,
                }
          if (JSON.stringify(freshScope) !== JSON.stringify(scopeSnapshot)) {
            pendingSubmitTextRef.current = null
            chatEditor.release(operationId)
            return false
          }
          pendingSubmitTextRef.current = query
          // D3：幂等键必须是可复算的 submission key（marker 校验要求），
          // 随机键会让 session-cache 拒绝落盘 → 查回能力静默丢失。
          let idempotencyKey: string
          try {
            idempotencyKey = buildSubmissionKey({
              projectId,
              ownerUserId: Number(runtimeSnapshot.viewerUserId),
              kind: 'global',
              sourceId: null,
              sessionId: targetSessionId,
              draftToken: editor.draftToken,
            })
          } catch {
            pendingSubmitTextRef.current = null
            chatEditor.release(operationId)
            return false
          }
          pendingClearControllersRef.current.set(operationId, chatConversation)
          const result = await chatConversation.send({
            query,
            modelId,
            sourceIds: scopeSnapshot.sourceIds,
            noteIds: scopeSnapshot.noteIds,
            scope: {
              mode: scopeSnapshot.mode,
              sourceIds: scopeSnapshot.sourceIds,
              singleSourceId: scopeSnapshot.singleSourceId,
            },
            editorRevision: editor.revision,
            draftToken: editor.draftToken,
            editorIntentHash: editor.intentHash ?? '',
            idempotencyKey,
            operationId,
          })
          if (result.status !== 'ok') {
            pendingSubmitTextRef.current = null
            pendingClearControllersRef.current.delete(operationId)
            chatEditor.release(operationId)
            return false
          }
          return true
        },
        { scopeLabel },
      )
      return sent === true
    },
    [chatConversation, chatEditor, runGuarded, t],
  )

  // D-25：跳转被拒**不得静默**。卡片路径（CitationCard）已按
  // `canJumpToCitation` 显示降级原因且不渲染按钮；此处兜住其它调用方
  // （Activity 对话框、Workbench 组合根、直接调用）——给出可解释的拒绝，
  // 绝不"点了没反应"，也绝不改开另一版本。
  const denyCitationJump = useCallback(
    (citation: ResearchCitationDisplayItem) => {
      const asCitation = citation as unknown as ResearchCitation
      const candidate = resolveCitationCandidate(sources, asCitation) ?? null
      const evaluation = canJumpToCitation(asCitation, candidate, undefined)
      const reason = evaluation.reason ?? 'source_unavailable'
      toast({
        title: t('research.citation.jumpBlocked'),
        description: t(
          reason === 'version_mismatch'
            ? 'research.citation.degradedVersion'
            : 'research.citation.degradedSource',
          { reason },
        ),
        variant: 'destructive',
      })
    },
    [sources, t, toast],
  )

  // Chat 报告 Citation → 解析到项目内来源后联动上半屏预览
  const handleCitationJump = useCallback(
    (citation: ResearchCitationDisplayItem) => {
      const source = resolveCitationSource(
        sources,
        citation as unknown as ResearchCitation,
      )
      if (!source || source.source_id === null) {
        denyCitationJump(citation)
        return
      }
      onCitationJump(source.source_id, citation.page_idx)
    },
    [denyCitationJump, onCitationJump, sources],
  )

  // run-template（TransformationsPanel）Citation → 同一条组合根链路
  const handleTransformationCitation = useCallback(
    (citation: ResearchCitation) => {
      const source = resolveCitationSource(sources, citation)
      if (!source || source.source_id === null) {
        denyCitationJump(citation as unknown as ResearchCitationDisplayItem)
        return
      }
      onCitationJump(source.source_id, citation.page_idx)
    },
    [denyCitationJump, onCitationJump, sources],
  )

  const loadingPlaceholder = (
    <p className="p-4 text-sm text-muted-foreground">{t('research.loading')}</p>
  )

  // 资源失败时不渲染 ComparePane（禁止把失败当空 Scope）；错误 + 重试在
  // 主区顶部资源条呈现（与 Header 同 key 查询共享，重试刷新同一缓存）。
  const renderPane = (action: ResearchMainAction) => {
    switch (action) {
      case 'evidence-search':
        return loading
          ? loadingPlaceholder
          : (
              <ResearchSearchPanel
                projectId={projectId}
                active={surfaceActive && activeAction === 'evidence-search'}
                onContinueResearch={
                  onOpenResearchChatDraft !== undefined
                    ? (text) => onOpenResearchChatDraft(text)
                    : undefined
                }
                onViewInsight={
                  onRevealSavedArtifact !== undefined
                    ? (insightId) => onRevealSavedArtifact('insight', insightId)
                    : undefined
                }
                onViewNote={
                  onRevealSavedArtifact !== undefined
                    ? (noteId) => onRevealSavedArtifact('note', noteId)
                    : undefined
                }
              />
            )
      case 'research-chat':
        return (
          <ResearchChatPanel
            turns={turns}
            isStreaming={isStreaming}
            onSend={sendChat}
            onSendCoverage={sendCoverageChat}
            sendDisabled={!canExecute}
            blockedHint={blockedHint}
            coverageEnabled={coverageAllSelected}
            coverageJobs={jobs}
            onCoverageRetry={isAdminReadonly ? undefined : retryCoverage}
            onCitationJump={handleCitationJump}
            backgroundNotice={backgroundNotice}
            onRunAsBackgroundJob={runChatAsBackgroundJob}
            backgroundJobRequiresSelection={!c05.dispatchReady('search')}
            resolveChatOrigin={resolveChatOrigin}
            prefill={chatPrefill}
            editorSnapshot={chatEditorSnapshot}
            submissionReady={chatSubmissionReady}
            editorHandle={chatEditor}
            conversation={chatConversation ?? null}
            sessionRef={activeGlobalRef}
            sessionMeta={sessionMeta}
            sessionCards={sessionCards}
            submissionLookup={submissionLookup}
            markerWriteFailed={markerWriteFailed}
            refreshMarkerLookups={refreshMarkerLookups}
            onSendSession={sendSessionChat}
            conversationSnapshot={{
              isBusy: isStreaming,
              isStreaming,
              activeTurnId: null,
              phase: isStreaming ? 'streaming' : 'idle',
            }}
            scopeSources={scopeBarSources}
            scopeNotes={scopeBarNotes}
            onChangeScope={chatEditor.setScope}
            onDraftChange={chatEditor.setDraftText}
            onRetrySave={chatEditor.retrySave}
            onRestoreDraft={chatEditor.restoreDraft}
            onChatAnchorChange={chatEditor.setChatAnchor}
            onFlushPosition={() => chatEditor.flush('position')}
            surfaceActive={surfaceActive && activeAction === 'research-chat'}
            onViewInsight={
              onRevealSavedArtifact !== undefined
                ? (insightId) => onRevealSavedArtifact('insight', insightId)
                : undefined
            }
            onViewNote={
              onRevealSavedArtifact !== undefined
                ? (noteId) => onRevealSavedArtifact('note', noteId)
                : undefined
            }
          />
        )
      case 'compare':
        // M1 修复：Compare 只消费 sources（document_ids），失败/加载守卫仅
        // 依赖 sourcesQuery——notes 失败不应禁用 source-only Compare（顶部
        // workspace-resources-error 仍聚合两者并给整体重试）。
        if (sourcesQuery.isError && !sourcesQuery.isSuccess) {
          return (
            <div
              role="alert"
              className="space-y-3 p-4 text-sm text-destructive"
              data-testid="compare-resources-error"
            >
              {t('research.loadFailed')}
            </div>
          )
        }
        if (sourcesQuery.isLoading && !sourcesQuery.isSuccess) {
          return (
            <p className="p-4 text-sm text-muted-foreground" data-testid="compare-loading">
              {t('research.loading')}
            </p>
          )
        }
        return (
          <ComparePanel
            sources={sources}
            isCreating={isCreating}
            error={jobsError}
            errorCode={jobsErrorCode}
            onCreate={createCompare}
            modelBlocked={!canExecute}
            blockedHint={blockedHint}
          />
        )
      case 'mind-map':
        // #445：占位动作——无业务逻辑，仅约定文案（完整实现由后续 Issue 承接）。
        return <MindMapPlaceholder />
      case 'run-template':
        return (
          <TransformationsPanel
            onCitationJump={handleTransformationCitation}
            onEditScope={onEditScopeAllStates}
          />
        )
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* RWV2-40：主区资源查询状态（Scope Summary 已迁 Header；查询仍在本
          组件 R8-1a）。只显示失败 + 重试（加载由 evidence pane 占位呈现），
          不渲染 Scope 模式摘要/Edit scope（那是 Header Current scope 段）。 */}
      {loadErrorText !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
          data-testid="workspace-resources-error"
        >
          <span className="text-xs text-destructive">{t('research.loadFailed')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={retryResources}
            data-testid="workspace-resources-retry"
          >
            {t('research.retry')}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 border-t">
        <Tabs
          value={activeAction}
          onValueChange={(value) => onActiveActionChange(value as ResearchMainAction)}
          className="flex h-full flex-col"
        >
          {/* RWV2-UIOPT-A：Tabs 行右侧为 ResearchLayout 展开/恢复按钮预留
              固定宽度（w-36 ≥ 按钮宽 + right-3 偏移），按钮位于次级面板
              右上角时不遮挡五动作 Tab——预留真实空间而非 z-index 遮盖。
              预留与按钮可见性同条件（compact <1024px 按钮隐藏，无预留）。
              issue59 回归：窄态（根 data-narrow-secondary=true，按钮收
              icon-only ~34px）时预留经 group 变体收窄为 w-11(44px)——
              rightMin 下 332+44=376 ≤ 387 不再溢出遮挡。 */}
          <div className="flex min-w-0 items-center px-4 pt-2" data-testid="workspace-tabs-row">
            {/* #445：一级标签单行化——whitespace-nowrap 保证标签文字不折行；
                min-w-0 将 flex 项 automatic minimum size 归零（可收缩到可用
                宽度），overflow-x-auto 在内容超出时整组标签横向滚动（触发器
                的 nowrap 文本 min-content 下限构成内溢出），标签互不重叠，
                右侧展开按钮预留位（ml-auto）始终不被标签流入。
                评审 F1：overflow 容器会把 y 轴一并裁剪，触发器设计的外描
                focus ring（box-shadow 画在边框外）会被整体裁掉——经父级
                arbitrary variant 把主区触发器的 focus ring 改为 inset 描边
                并去掉 offset，焦点可见性在滚动容器内保留（active 态仍有
                border-primary + 文字变色双指示）。 */}
            <TabsList className="min-w-0 max-w-full overflow-x-auto whitespace-nowrap [&_[data-slot=tabs-trigger]]:focus-visible:ring-inset [&_[data-slot=tabs-trigger]]:focus-visible:ring-offset-0">
              <TabsTrigger value="evidence-search">{t('research.tabSearch')}</TabsTrigger>
              <TabsTrigger value="research-chat">{t('research.tabChat')}</TabsTrigger>
              <TabsTrigger value="compare">{t('research.tabCompare')}</TabsTrigger>
              <TabsTrigger value="mind-map">{t('research.mainActions.mindMap')}</TabsTrigger>
              <TabsTrigger value="run-template">{t('research.mainActions.runTemplate')}</TabsTrigger>
            </TabsList>
            <div
              aria-hidden="true"
              className="ml-auto hidden w-36 shrink-0 lg:block group-data-[narrow-secondary=true]/narrow:w-11"
              data-testid="workspace-expand-reserve"
            />
          </div>

          {RESEARCH_MAIN_ACTIONS.filter((action) => mountedActions.includes(action)).map((action) => {
            const isActive = action === activeAction
            return (
              <TabsContent
                key={action}
                value={action}
                forceMount
                className={cn('min-h-0 flex-1', !isActive && 'data-[state=inactive]:hidden')}
              >
                {renderPane(action)}
              </TabsContent>
            )
          })}
        </Tabs>
      </div>
    </div>
  )
}

/**
 * PR5（D-22）：Chat 一次逻辑提交的**冻结意图**——签名（用于判定"是否同一次
 * 提交"）、契约选择与请求信封。三者与幂等键一起在 consent 登记前成型，
 * 确认后原样派发，杜绝"同意流程换键/换契约"。
 *
 * `signatureOf` 的 `contextLevel` 对 Chat 无对应档位，传空串占位——
 * 该字段只参与签名比较，不进入 Chat 请求体。
 */
function deriveChatSubmission(
  selection: ResearchChatSelection,
  query: string,
  modelId: string | null,
  contract: 'v1' | 'c05-v1',
  sessionId: string | null,
): {
  signature: string
  contract: 'v1' | 'c05-v1'
  request: ResearchChatRequest
} {
  // 自查（审查轮 2 Part B）：mode 必须与 hook 的 `deriveScopeSnapshot` **同源**
  // ——否则冻结请求与 hook 自建请求会在"selection.mode 缺省但已选 ID"时分歧
  // （本函数给 'all'，deriveScopeSnapshot 给 'selected'），首次尝试与重连
  // 会发出语义不同的载荷。直接复用同一推导函数，杜绝这类漂移。
  const snapshot = deriveScopeSnapshot(selection)
  const scope = {
    mode: snapshot.mode,
    sourceIds: [...snapshot.sourceIds],
    noteIds: [...snapshot.noteIds],
    singleSourceId: snapshot.singleSourceId,
  }
  const signature = signatureOf({
    entry: 'chat',
    query,
    scope,
    modelId: modelId ?? '',
    contextLevel: '',
    contract,
  })
  // **就是**将要发出的 wire 请求（形如 runTurn 的构造，含 session_id 与契约
  // 形状差异）——确认后原样发送，抑制"登记体 ≠ 实际请求"的漂移。
  const request: ResearchChatRequest = contract === 'c05-v1'
    ? {
        query,
        session_id: sessionId ?? undefined,
        model_id: modelId ?? '',
        source_scope: buildSourceScope({
          mode: scope.mode,
          sourceIds: scope.sourceIds,
          noteIds: scope.noteIds,
          singleSourceId: scope.singleSourceId,
        }),
        note_ids: scope.noteIds,
      }
    : {
        query,
        source_ids: scope.sourceIds,
        note_ids: scope.noteIds,
        session_id: sessionId ?? undefined,
        model_id: modelId ?? '',
      }
  return { signature, contract, request }
}
