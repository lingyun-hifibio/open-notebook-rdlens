'use client'

import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import { ExportSection } from './ExportSection'
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
 */
export function ResearchWorkbench() {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const [tab, setTab] = useState<ResearchTab>('sources')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [highlightPageIdx, setHighlightPageIdx] = useState<number | null>(null)

  const sourcesQuery = useResearchSources(projectId)

  const openSource = (sourceId: string) => {
    setSelectedSourceId(sourceId)
    setHighlightPageIdx(null)
  }

  const handleCitationJump = (citation: ResearchCitation) => {
    // 无法解析到项目内来源 → 不跳转（CitationCard 已按失效降级展示原文）
    const source = resolveCitationSource(sourcesQuery.data?.items, citation)
    if (!source) {
      return
    }
    setSelectedSourceId(source.source_id)
    setHighlightPageIdx(citation.page_idx)
    setTab('sources')
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t('research.workbench.title')}</h1>
        <ExportSection />
      </div>
      {isAdminReadonly && <AdminReadOnlyBanner />}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ResearchTab)}>
        <TabsList>
          <TabsTrigger value="sources">{t('research.workbench.tabSources')}</TabsTrigger>
          <TabsTrigger value="notes">{t('research.workbench.tabNotes')}</TabsTrigger>
          <TabsTrigger value="insights">{t('research.workbench.tabInsights')}</TabsTrigger>
          <TabsTrigger value="transformations">
            {t('research.workbench.tabTransformations')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="mt-3">
          {selectedSourceId !== null ? (
            <div className="space-y-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelectedSourceId(null)
                  setHighlightPageIdx(null)
                }}
              >
                {t('research.sources.back')}
              </Button>
              <SourceDetailPanel sourceId={selectedSourceId} highlightPageIdx={highlightPageIdx} />
            </div>
          ) : (
            <SourceListPanel onOpenSource={openSource} />
          )}
        </TabsContent>
        <TabsContent value="notes" className="mt-3">
          <NotesPanel />
        </TabsContent>
        <TabsContent value="insights" className="mt-3">
          <InsightsPanel />
        </TabsContent>
        <TabsContent value="transformations" className="mt-3">
          <TransformationsPanel onCitationJump={handleCitationJump} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
