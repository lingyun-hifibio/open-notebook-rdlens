'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getResearchProjectId } from '@/lib/research/project'
import { createCoverageChat, listNotes, listSources } from '@/lib/research/api'
import { useResearchChat, type CoverageSubmitRequest } from '@/lib/hooks/use-research-chat'
import { researchModelBlockedHint, useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { useResearchJobs } from '@/lib/hooks/use-research-jobs'
import { SourceNoteSelector } from './SourceNoteSelector'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import { ResearchChatPanel } from './ResearchChatPanel'
import { ComparePanel } from './ComparePanel'
import { ResearchJobList } from './ResearchJobList'
import { resolveCitationSource } from './citation-utils'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ResearchCitation, ResearchNote, ResearchSource } from '@/lib/types/research'

/**
 * Research 工作区组合（UI-03，REQ-SCOPE-04，设计 §9.3）。
 *
 * 项目上下文从内存 Research Token 的 payload 读取（project.ts，
 * REQ-AUTH-03）；无上下文 fail-closed 错误态。Source/Note 选择在
 * Search/Chat/Compare 间共享；Chat 与 Job hooks 挂在工作区层，
 * 切换 Tab 不丢失流/轮询状态。Source/Note 列表复用 UI-02 的
 * `listSources/listNotes`（分页载荷 .items）。
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
  const projectId = getResearchProjectId()

  const [sources, setSources] = useState<ResearchSource[]>([])
  const [notes, setNotes] = useState<ResearchNote[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([])
  const [tab, setTab] = useState('search')

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setLoadError(null)
    try {
      const [sourcePage, notePage] = await Promise.all([
        listSources(projectId),
        listNotes(projectId),
      ])
      setSources(sourcePage.items)
      setNotes(notePage.items)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const toggleSource = useCallback((sourceId: string) => {
    setSelectedSourceIds((prev) =>
      prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId],
    )
  }, [])

  const toggleNote = useCallback((noteId: string) => {
    setSelectedNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId],
    )
  }, [])

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
      selection: Parameters<typeof sendTurn>[1],
    ): Promise<boolean> => {
      // sendTurn 返回 void，用 true 标记「已派发」，供调用方区分确认取消
      const sent = await runGuarded((modelId) => {
        sendTurn(query, selection, modelId)
        return true
      })
      return sent === true
    },
    [sendTurn, runGuarded],
  )

  const createCompare = useCallback(
    async (
      documentIds: readonly string[],
      groupSize?: number,
    ): Promise<boolean> => {
      // 与 sendChat 相同：返回「是否真正派发」，供面板区分 consent 取消，
      // 取消时不显示「已创建」提示
      const sent = await runGuarded((modelId) => {
        createCompareJob(documentIds, modelId, groupSize)
        return true
      })
      return sent === true
    },
    [createCompareJob, runGuarded],
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
    async (query: string): Promise<boolean> => {
      // 与 sendChat 相同：经顶层执行守卫，传入调用时刻的 confirmed 模型快照
      const sent = await runGuarded((modelId) => {
        sendCoverage(
          query,
          { sourceIds: selectedSourceIds, noteIds: selectedNoteIds },
          modelId,
          submitCoverage,
        )
        return true
      })
      return sent === true
    },
    [runGuarded, selectedNoteIds, selectedSourceIds, sendCoverage, submitCoverage],
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

  if (!projectId) {
    return (
      <div role="alert" className="p-8 text-center text-sm text-destructive">
        {t('research.noProjectContext')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <SourceNoteSelector
        sources={sources}
        notes={notes}
        selectedSourceIds={selectedSourceIds}
        selectedNoteIds={selectedNoteIds}
        onToggleSource={toggleSource}
        onToggleNote={toggleNote}
        loading={loading}
        loadError={loadError}
        onRetry={() => void load()}
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
                selectedSourceIds={selectedSourceIds}
                selectedNoteIds={selectedNoteIds}
              />
            )}
          </TabsContent>
          <TabsContent value="chat" className="min-h-0 flex-1">
            <ResearchChatPanel
              turns={turns}
              isStreaming={isStreaming}
              onSend={sendChat}
              onSendCoverage={sendCoverageChat}
              selectedSourceIds={selectedSourceIds}
              selectedNoteIds={selectedNoteIds}
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
              selectedSourceIds={selectedSourceIds}
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
