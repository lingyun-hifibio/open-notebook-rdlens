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
  scopeBlockedText = null,
}: {
  view: Exclude<TargetCenterView, 'conversation'>
  onBack: () => void
  /**
   * F4/BEH-03：空 selected 时次级视图也必须 fail-closed——即使视图已打开后
   * 范围被清空，也不能把空 source_ids 派发给搜索/比较。
   */
  scopeBlockedText?: string | null
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
        {scopeBlockedText !== null ? (
          <div
            role="alert"
            className="space-y-3 p-6"
            data-testid="rdlens-target-secondary-scope-blocked"
          >
            <p className="text-sm font-medium">{scopeBlockedText}</p>
            <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
              {t('research.target.sources.scopeBlockedHint')}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onBack}>
              {t('research.target.conversation.backToConversation')}
            </Button>
          </div>
        ) : view === 'evidence-search' ? (
          <div data-testid="rdlens-target-secondary-panel" className="h-full min-h-0">
          <ResearchSearchPanel
            projectId={projectId}
            active
            onCitationJump={onCitationJump}
            sources={sources}
            // D-UI-06：目标壳不暴露可编辑 Search context 控件；范围随操作
            // 声明并受左栏/当前对话范围约束（唯一权威仍是 ResearchScopeProvider）。
            // 审查 B F3：必须显式呈现本次实际档位并保留自动收敛提示。
            showSearchContext={false}
            showSearchContextSummary
          />
          </div>
        ) : (
          // F16：该面板内仍有少量 pre-existing 硬编码英文错误/`provider:` 标签
          // （不属于本 PR 新增文案）；已登记为 W1 已知缺口，随搜索面板 i18n
          // 收敛一起处理，不在本 PR 内改 legacy 面板。
          <div data-testid="rdlens-target-secondary-panel" className="h-full min-h-0">
          <ComparePanel
            sources={sources}
            isCreating={compare.isCreating}
            error={compare.error}
            errorCode={compare.errorCode}
            onCreate={compare.onCreate}
            modelBlocked={compare.modelBlocked}
            blockedHint={compare.blockedHint}
          />
          </div>
        )}
      </div>
    </div>
  )
}
