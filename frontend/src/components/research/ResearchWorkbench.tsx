'use client'

import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import { SourceListPanel } from './SourceListPanel'
import { SourceDetailPanel } from './SourceDetailPanel'
import { NotesPanel } from './NotesPanel'
import { InsightsPanel } from './InsightsPanel'
import { TransformationsPanel } from './TransformationsPanel'
import { resolveCitationSource } from './citation-utils'
import type { ResearchCitation } from '@/lib/types/research'

export type ResearchTab = 'sources' | 'notes' | 'insights' | 'transformations'

/**
 * Research 工作台容器（UI-02，REQ-SCOPE-04；设计 §2.1/§4.4）。
 *
 * Sources / Notes / Insights / Transformations 四个面板 + 导出；
 * Admin 会话顶部只读横幅。Citation 跳转：把转换结果中的引用解析到
 * 项目来源（按 document_id），切到 Sources 面板并定位目标页
 * （highlight，page_idx 0-based 仅展示 +1，REQ-DATA-03）。
 *
 * Issue #182：选中来源与高亮页提升到 /research 组合层（下半屏据此切换
 * Source Chat 面板）；tab 状态与 Citation 跳转链路保留在本地。
 * `onSelectSource(sourceId, opts?)` 契约：设置选中来源并**默认重置**
 * 高亮页（opts.highlightPageIdx 显式传入时除外，防高亮泄漏）；
 * `highlightRequestId` 为每次 Citation 定位请求递增的事件序号，使相同
 * page_idx 的连续请求也能重新触发焦点移动；
 * `onCloseSource` 清空两者（返回来源列表）。
 */
export interface ResearchWorkbenchProps {
  displayMode: 'workbench' | 'source-focus'
  selectedSourceId: string | null
  highlightPageIdx: number | null
  highlightRequestId: number
  onSelectSource: (sourceId: string, opts?: { highlightPageIdx?: number | null }) => void
  onCloseSource: () => void
}

export function ResearchWorkbench({
  displayMode,
  selectedSourceId,
  highlightPageIdx,
  highlightRequestId,
  onSelectSource,
  onCloseSource,
}: ResearchWorkbenchProps) {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const [tab, setTab] = useState<ResearchTab>('sources')

  const sourcesQuery = useResearchSources(projectId)

  const openSource = (sourceId: string) => {
    onSelectSource(sourceId)
  }

  const handleCitationJump = (citation: ResearchCitation) => {
    // 无法解析到项目内来源 → 不跳转（CitationCard 已按失效降级展示原文）
    const source = resolveCitationSource(sourcesQuery.data?.items, citation)
    if (!source) {
      return
    }
    onSelectSource(source.source_id, { highlightPageIdx: citation.page_idx })
    setTab('sources')
  }

  if (displayMode === 'source-focus' && selectedSourceId !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-4">
        {/* Issue #243 §6.2：标题与导出上移到顶层 Research header，此处只保留
            Source focus 的返回控制，避免重复的「研究工作台」标题 */}
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={onCloseSource}>
            {t('research.sources.back')}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SourceDetailPanel
            sourceId={selectedSourceId}
            highlightPageIdx={highlightPageIdx}
            focusRequestId={highlightPageIdx === null ? undefined : highlightRequestId}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Issue #243 §6.2：标题与导出入口已上移到顶层 Research header */}
      {isAdminReadonly && <AdminReadOnlyBanner />}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ResearchTab)} className="min-h-0 flex-1">
        {/* flex-wrap：窄栏（英文 locale 四标签超宽）时折行而非被裁剪 */}
        <TabsList className="flex-wrap">
          <TabsTrigger value="sources">{t('research.workbench.tabSources')}</TabsTrigger>
          <TabsTrigger value="notes">{t('research.workbench.tabNotes')}</TabsTrigger>
          <TabsTrigger value="insights">{t('research.workbench.tabInsights')}</TabsTrigger>
          <TabsTrigger value="transformations">
            {t('research.workbench.tabTransformations')}
          </TabsTrigger>
        </TabsList>

        {/* TabsContent 统一 min-h-0 flex-1 overflow-y-auto：面板内容超高时
            在工作台内部滚动，不溢出半屏容器（叠加页面上半屏包裹层的
            overflow-hidden 双保险） */}
        <TabsContent value="sources" className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {selectedSourceId !== null ? (
            <div className="space-y-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={onCloseSource}
              >
                {t('research.sources.back')}
              </Button>
              <SourceDetailPanel
                sourceId={selectedSourceId}
                highlightPageIdx={highlightPageIdx}
                focusRequestId={highlightPageIdx === null ? undefined : highlightRequestId}
              />
            </div>
          ) : (
            <SourceListPanel onOpenSource={openSource} />
          )}
        </TabsContent>
        <TabsContent value="notes" className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <NotesPanel />
        </TabsContent>
        <TabsContent value="insights" className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <InsightsPanel />
        </TabsContent>
        <TabsContent value="transformations" className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <TransformationsPanel onCitationJump={handleCitationJump} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
