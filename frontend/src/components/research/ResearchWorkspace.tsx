'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { createCoverageChat } from '@/lib/research/api'
import {
  useResearchChat,
  type CoverageSubmitRequest,
  type ResearchChatSelection,
  deriveScopeSnapshot,
} from '@/lib/hooks/use-research-chat'
import { formatScopeLabel, useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import { researchModelBlockedHint, useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { useResearchNotes, useResearchSources } from '@/lib/hooks/use-research'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchJobsController } from './ResearchJobsProvider'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import { ResearchChatPanel } from './ResearchChatPanel'
import { ComparePanel } from './ComparePanel'
import { TransformationsPanel } from './TransformationsPanel'
import {
  RESEARCH_MAIN_ACTIONS,
  type ResearchMainAction,
} from './research-main-action'
import { resolveCitationSource } from './citation-utils'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ResearchCitation } from '@/lib/types/research'

/**
 * RWV2-40（Fork #44）：主工作区（Main workspace）组合。
 *
 * 目标 IA（RFC §2，v9 冻结）：主区固定为四个研究动作——
 * evidence-search / research-chat / compare / run-template（Jobs 迁往
 * Header 的 Activity 兼容壳，不再占用主区动作位）。动作与保活由组合根
 * （ResearchPageContent）控制：`activeAction` 受控下发，本组件维护
 * `visited` 集合 + 渲染期派生，实现「首次访问后保活」。
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
}

export function ResearchWorkspace({
  activeAction,
  onActiveActionChange,
  surfaceActive,
  onCitationJump,
  onEditScopeAllStates,
}: ResearchWorkspaceProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const { reconcileSelection } = useResearchScope()
  const sourcesQuery = useResearchSources(projectId)
  const notesQuery = useResearchNotes(projectId)
  const sources = useMemo(() => sourcesQuery.data?.items ?? [], [sourcesQuery.data])
  const notes = useMemo(() => notesQuery.data?.items ?? [], [notesQuery.data])
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
            .filter((source) => source.status === 'ready' || source.status === 'stale')
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
  } = useResearchJobsController()

  // Chat SSE 状态机保持组件层（切动作/隐藏不中断流与刷新恢复）
  const {
    turns,
    isStreaming,
    backgroundNotice,
    send: sendTurn,
    sendCoverage,
    resolveChatOrigin,
  } = useResearchChat({ projectId: projectId ?? '' })

  // #243 §6.4：Chat/Compare 统一走顶层执行守卫（invariant 9）
  const { runGuarded, canExecute, blockedReason } = useResearchGlobalModel()
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

  const sendChat = useCallback(
    async (
      query: string,
      selection: ResearchChatSelection | undefined,
    ): Promise<boolean> => {
      // RWV2-11（K11）：consent 摘要由「面板转发来的 selection」推导（与
      // 最终请求同一快照），禁止回读本组件 provider 态。
      const scopeLabel = formatScopeLabel(deriveScopeSnapshot(selection), t)
      const sent = await runGuarded(
        (modelId) => {
          sendTurn(query, selection, modelId)
          return true
        },
        { scopeLabel },
      )
      return sent === true
    },
    [runGuarded, sendTurn, t],
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
    async (request: CoverageSubmitRequest, idempotencyKey: string): Promise<{ job_id: string }> => {
      const accepted = await createCoverageChat(
        projectId ?? '',
        {
          query: request.query,
          source_ids: request.source_ids,
          note_ids: request.note_ids,
          model_id: request.model_id,
          synthesis_scope: 'all_selected',
        },
        idempotencyKey,
      )
      registerCoverageJob(accepted.job_id)
      return { job_id: accepted.job_id }
    },
    [projectId, registerCoverageJob],
  )

  const sendCoverageChat = useCallback(
    async (query: string, snapshot: ResearchScopeSnapshot): Promise<boolean> => {
      const scopeLabel = formatScopeLabel(snapshot, t)
      const sent = await runGuarded(
        (modelId) => {
          sendCoverage(
            query,
            { mode: snapshot.mode, sourceIds: [...snapshot.sourceIds], noteIds: [] },
            modelId,
            submitCoverage,
          )
          return true
        },
        { scopeLabel },
      )
      return sent === true
    },
    [runGuarded, sendCoverage, submitCoverage, t],
  )

  // Chat 报告 Citation → 解析到项目内来源后联动上半屏预览
  const handleCitationJump = useCallback(
    (citation: ResearchCitationDisplayItem) => {
      const source = resolveCitationSource(
        sources,
        citation as unknown as ResearchCitation,
      )
      if (!source) return
      onCitationJump(source.source_id, citation.page_idx)
    },
    [onCitationJump, sources],
  )

  // run-template（TransformationsPanel）Citation → 同一条组合根链路
  const handleTransformationCitation = useCallback(
    (citation: ResearchCitation) => {
      const source = resolveCitationSource(sources, citation)
      if (!source) return
      onCitationJump(source.source_id, citation.page_idx)
    },
    [onCitationJump, sources],
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
            coverageJobs={jobs}
            onCoverageRetry={isAdminReadonly ? undefined : retryCoverage}
            onCitationJump={handleCitationJump}
            backgroundNotice={backgroundNotice}
            resolveChatOrigin={resolveChatOrigin}
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
          <TabsList className="mx-4 mt-2 w-fit">
            <TabsTrigger value="evidence-search">{t('research.tabSearch')}</TabsTrigger>
            <TabsTrigger value="research-chat">{t('research.tabChat')}</TabsTrigger>
            <TabsTrigger value="compare">{t('research.tabCompare')}</TabsTrigger>
            <TabsTrigger value="run-template">{t('research.mainActions.runTemplate')}</TabsTrigger>
          </TabsList>

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
