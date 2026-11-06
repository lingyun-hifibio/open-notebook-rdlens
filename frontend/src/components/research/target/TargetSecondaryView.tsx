'use client'

import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { ResearchSearchPanel } from '../ResearchSearchPanel'
import { ComparePanel } from '../ComparePanel'
import type { TargetCenterView } from './target-types'

/**
 * 中央次级视图（W1 #1104；UI 规格 v1 §2.4/§5.5）。
 *
 * 证据搜索 / 比较资料不再是旧壳一级 Tab，而是 composer 次级操作打开的
 * **中央次级视图**：复用既有面板，带「返回对话」入口；对话保持挂载
 * （流式/未发送草稿不丢）。
 */
export function TargetSecondaryView({
  view,
  onBack,
  compare,
  onCitationJump,
}: {
  view: Exclude<TargetCenterView, 'conversation'>
  onBack: () => void
  compare: {
    isCreating: boolean
    error: string | null
    errorCode: string | null
    onCreate: (documentIds: string[], groupSize?: number) => Promise<boolean>
    modelBlocked: boolean
    blockedHint: string | null
  }
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const sourcesQuery = useResearchSources(projectId)
  const sources = sourcesQuery.data?.items ?? []

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={`rdlens-target-secondary-${view}`}>
      <div
        className="flex shrink-0 items-center gap-2 border-b px-7 py-3 max-xl:px-[18px]"
        style={{ borderColor: 'var(--rdlens-line)' }}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={onBack}
          data-testid="rdlens-target-secondary-back"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {t('research.target.conversation.backToConversation')}
        </Button>
        <h2 className="rdlens-serif min-w-0 truncate text-base font-medium">
          {view === 'evidence-search'
            ? t('research.target.secondary.search')
            : t('research.target.secondary.compare')}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'evidence-search' ? (
          <ResearchSearchPanel
            projectId={projectId}
            active
            onCitationJump={onCitationJump}
            sources={sources}
            // D-UI-06：目标壳不暴露独立 Search context；范围随操作声明并受
            // 左栏/当前对话范围约束（唯一权威仍是 ResearchScopeProvider）。
            showSearchContext={false}
          />
        ) : (
          <ComparePanel
            sources={sources}
            isCreating={compare.isCreating}
            error={compare.error}
            errorCode={compare.errorCode}
            onCreate={compare.onCreate}
            modelBlocked={compare.modelBlocked}
            blockedHint={compare.blockedHint}
          />
        )}
      </div>
    </div>
  )
}
