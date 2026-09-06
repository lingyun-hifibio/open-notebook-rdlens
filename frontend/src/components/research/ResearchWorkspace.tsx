'use client'

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { createCoverageChat } from '@/lib/research/api'
import { useResearchChat, type CoverageSubmitRequest, type ResearchChatSelection, deriveScopeSnapshot } from '@/lib/hooks/use-research-chat'
import { formatScopeLabel, useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import { researchModelBlockedHint, useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { useResearchJobs } from '@/lib/hooks/use-research-jobs'
import { useResearchNotes, useResearchSources } from '@/lib/hooks/use-research'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { SourceNoteSelector } from './SourceNoteSelector'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import { ResearchChatPanel } from './ResearchChatPanel'
import { ComparePanel } from './ComparePanel'
import { ResearchJobList } from './ResearchJobList'
import { resolveCitationSource } from './citation-utils'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ResearchCitation } from '@/lib/types/research'

/**
 * Research 工作区组合（UI-03，REQ-SCOPE-04，设计 §9.3）。
 *
 * 项目上下文由认证 Shell 注入；缺少 Provider 时 fail-closed。Source/Note
 * 查询复用 Query Cache，选择由根级 ResearchScopeProvider 共享；Chat 与 Job
 * hooks 挂在工作区层，切换 Tab 不丢失流/轮询状态。
 *
 * COV-09：all_selected 经 `sendCoverage`（202 受理 → Chat 任务卡 +
 * Jobs 页登记，刷新后同一 Job 继续轮询）；报告 Citation 点击经
 * `onCitationJump` 联动上半屏来源预览。
 */
export function ResearchWorkspace({
  onCitationJump,
}: {
  /** COV-09：报告 Citation → 现有授权预览/来源链路（已解析 source_id + 页码） */
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const {
    mode,
    selectedSourceIds,
    selectedNoteIds,
    setMode,
    toggleSource,
    toggleNote,
  } = useResearchScope()
  const sourcesQuery = useResearchSources(projectId)
  const notesQuery = useResearchNotes(projectId)
  const sources = useMemo(() => sourcesQuery.data?.items ?? [], [sourcesQuery.data])
  const notes = useMemo(() => notesQuery.data?.items ?? [], [notesQuery.data])
  const loading = sourcesQuery.isLoading || notesQuery.isLoading
  const loadError = sourcesQuery.error ?? notesQuery.error
  const [tab, setTab] = useState('search')

  const {
    turns,
    isStreaming,
    backgroundNotice,
    send: sendTurn,
    sendCoverage,
  } = useResearchChat({ projectId: projectId ?? '' })
  const {
    jobs,
    isCreating,
    error: jobsError,
    createCompare: createCompareJob,
    cancel,
    registerCoverageJob,
    retryCoverage,
  } = useResearchJobs({
    projectId: projectId ?? '',
  })
  // #243 §6.4：Chat/Compare 统一走顶层执行守卫——传入调用时刻捕获的
  // confirmed 模型快照；外部模型需确认时只登记不执行，取消零副作用
  // （不发请求、不建 Job，不变量 9）。
  // 注意：Chat/Source Chat 固定 focused、Compare 固定 workspace 的档位
  // 是**省略** context_level 字段、依赖后端默认实现的（评审 Minor-6）——
  // 前端不提供局部覆盖控件；若后端默认变化，需同步本注释并补显式字段。
  const { runGuarded, canExecute, blockedReason } = useResearchGlobalModel()
  // 各生成入口共用同一禁用文案映射（与 Search/SourceChat 一致）
  const blockedHint = researchModelBlockedHint(blockedReason, t)

  const sendChat = useCallback(
    async (
      query: string,
      selection: ResearchChatSelection | undefined,
    ): Promise<boolean> => {
      // RWV2-11（K11）：consent 摘要由「面板转发来的 selection」推导（与
      // 最终请求同一快照），禁止回读本组件 provider 态——弹窗摘要必须等
      // 于派发载荷。
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
      // RWV2-11（K11）：Compare 只走显式 `selected` 模式（K2）——摘要按
      // 传入 document_ids 数量从快照形状推导（与入库载荷同源）。
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

  // COV-09：all_selected 提交体——202 受理后把 Job 登记进 Jobs 页
  // （localStorage + 轮询；刷新后同一 Job 与固定 snapshot 继续可见）。
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
      // RWV2-11（K9/K11）：快照由面板在派发时刻冻结并转发——本组件不再
      // 回读 provider 态；consent 摘要与该快照同源；note_ids 恒空（后端
      // Notes 不支持 Coverage）。
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

  // COV-09：报告 Citation → 解析到项目内来源后联动上半屏预览（现有链路）；
  // 传入已解析的 source_id（citation.doc_id 是 document_id，不能直接用作
  // 来源选择键）
  const handleCitationJump = useCallback(
    (citation: ResearchCitationDisplayItem) => {
      const source = resolveCitationSource(
        sources,
        citation as unknown as ResearchCitation,
      )
      if (!source || onCitationJump === undefined) return
      onCitationJump(source.source_id, citation.page_idx)
    },
    [onCitationJump, sources],
  )

  return (
    <div className="flex h-full flex-col">
      <SourceNoteSelector
        sources={sources}
        notes={notes}
        mode={mode}
        selectedSourceIds={selectedSourceIds}
        selectedNoteIds={selectedNoteIds}
        onModeChange={setMode}
        onToggleSource={toggleSource}
        onToggleNote={toggleNote}
        loading={loading}
        loadError={loadError instanceof Error ? loadError.message : loadError === null ? null : String(loadError)}
        onRetry={() => {
          void sourcesQuery.refetch()
          void notesQuery.refetch()
        }}
      />

      <div className="min-h-0 flex-1 border-t">
        <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col">
          <TabsList className="mx-4 mt-2 w-fit">
            <TabsTrigger value="search">{t('research.tabSearch')}</TabsTrigger>
            <TabsTrigger value="chat">{t('research.tabChat')}</TabsTrigger>
            <TabsTrigger value="compare">{t('research.tabCompare')}</TabsTrigger>
            <TabsTrigger value="jobs">
              {t('research.tabJobs')}
              {jobs.length > 0 ? ` (${jobs.length})` : ''}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="search" className="min-h-0 flex-1">
            {loading ? (
              <p className="p-4 text-sm text-muted-foreground">{t('research.loading')}</p>
            ) : (
              <ResearchSearchPanel
                projectId={projectId}
              />
            )}
          </TabsContent>
          <TabsContent value="chat" className="min-h-0 flex-1">
            <ResearchChatPanel
              turns={turns}
              isStreaming={isStreaming}
              onSend={sendChat}
              onSendCoverage={sendCoverageChat}
              sendDisabled={!canExecute}
              blockedHint={blockedHint}
              coverageJobs={jobs}
              onCoverageRetry={retryCoverage}
              onCitationJump={handleCitationJump}
              backgroundNotice={backgroundNotice}
            />
          </TabsContent>
          <TabsContent value="compare" className="min-h-0 flex-1">
            <ComparePanel
              sources={sources}
              isCreating={isCreating}
              error={jobsError}
              onCreate={createCompare}
              modelBlocked={!canExecute}
              blockedHint={blockedHint}
            />
          </TabsContent>
          <TabsContent value="jobs" className="min-h-0 flex-1">
            <ResearchJobList
              jobs={jobs}
              isCreating={isCreating}
              onCancel={cancel}
              onCoverageRetry={retryCoverage}
              onCitationJump={handleCitationJump}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
