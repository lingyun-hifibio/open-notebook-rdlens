'use client'

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { cn } from '@/lib/utils'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import { ResearchScopeEditor } from './ResearchScopeEditor'
import { SourceListPanel } from './SourceListPanel'
import { SourceDetailPanel } from './SourceDetailPanel'
import { NotesPanel } from './NotesPanel'
import { InsightsPanel } from './InsightsPanel'
import { TransformationRunsPanel } from './TransformationRunsPanel'
import { resolveCitationSource } from './citation-utils'
import { useResearchSources } from '@/lib/hooks/use-research'
import type { ResearchCitation } from '@/lib/types/research'

/** 左栏数据/插槽子视图：Materials(Sources|Notes) + Results(Insights|Runs)。 */
export type ResearchWorkbenchPane =
  | 'sources'
  | 'notes'
  | 'insights'
  | 'transformation-runs'

/**
 * 左栏 Research 工作台容器（RWV2-40 分组 IA，#44）。
 *
 * 组合根（ResearchPageContent）按 `sourceFocusActive ? selectedSourceId :
 * null` 计算 `focusedSourceId`：
 * - 非 null → Source 专注视图：Back（onExitSourceFocus）+ SourceDetailPanel
 *   （highlightPageIdx/focusRequestId 转发，同一页重复 Citation 仍重定位）；
 * - null → 常规分组视图：AdminReadOnlyBanner + ResearchScopeEditor
 *   （唯一 Scope 编辑面）+ 分组导航（Materials/Results 的子视图切换、
 *   Tools 的跨区命令按钮）。
 *
 * 分组导航为语义化按钮组（不再使用 Radix Tabs 平铺四键）。Sources/Notes/
 * Insights/Transformation runs 是 Workbench 的子视图开关（aria-current
 * 指示激活项）；「Research templates」是跨区命令：点击经
 * onOpenResearchTemplates 打开主区 Run Template（active 态由
 * researchTemplatesActive 传入）。TransformationsPanel 已迁往主区
 * Run Template 单挂载，本组件不再渲染它。
 *
 * RWV2-13 语义保留：ResearchScopeEditor 常驻顶部；Sources/Notes 行首复
 * 选框（SourceListPanel/NotesPanel 内部实现）是唯一项目选择入口，写入根
 * 级 ResearchScopeProvider。本组件不自持 useResearchX 查询——各面板自带。
 */
export interface ResearchWorkbenchProps {
  /** sourceFocusActive ? selectedSourceId : null（组合根算好传入；null=非 source focus） */
  focusedSourceId: string | null
  highlightPageIdx: number | null
  highlightRequestId: number
  /** 主区 Run Template 动作是否激活（Tools/Research templates 项的 active 态） */
  researchTemplatesActive: boolean
  onOpenSource(sourceId: string, pageIdx?: number | null): void
  onExitSourceFocus(): void
  onOpenResearchTemplates(): void
  /** Results/Transformation runs 插槽内容（RWV2-42 组件或自定义）；undefined 时
   *  默认挂载合并后的 TransformationRunsPanel（#48 已合入，不再显示 unavailable） */
  transformationRuns?: React.ReactNode
  /** 递增序号：Edit scope 请求聚焦左栏编辑面 */
  scopeEditRequest?: number
}

const MATERIALS_ITEMS: readonly { pane: 'sources' | 'notes'; labelKey: string }[] = [
  { pane: 'sources', labelKey: 'research.workbench.tabSources' },
  { pane: 'notes', labelKey: 'research.workbench.tabNotes' },
]

const RESULTS_ITEMS: readonly { pane: 'insights' | 'transformation-runs'; labelKey: string }[] = [
  { pane: 'insights', labelKey: 'research.workbench.tabInsights' },
  // #44：Results/Transformation runs 子项复用 #48 合入的 tabRuns 文案 key。
  { pane: 'transformation-runs', labelKey: 'research.workbench.tabRuns' },
]

export function ResearchWorkbench({
  focusedSourceId,
  highlightPageIdx,
  highlightRequestId,
  researchTemplatesActive,
  onOpenSource,
  onExitSourceFocus,
  onOpenResearchTemplates,
  transformationRuns,
  scopeEditRequest,
}: ResearchWorkbenchProps) {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const [pane, setPane] = useState<ResearchWorkbenchPane>('sources')
  // #44 + #48：Runs 面板 Citation → 解析到项目内来源后经组合根 source-focus
  // 跳转。查询与 RunsPanel 内部共享（同 key 缓存，不双拉）。
  const sourcesQuery = useResearchSources(projectId)
  const handleRunsCitationJump = useCallback(
    (citation: ResearchCitation) => {
      const source = resolveCitationSource(sourcesQuery.data?.items, citation)
      if (!source) return
      onOpenSource(source.source_id, citation.page_idx)
    },
    [onOpenSource, sourcesQuery.data?.items],
  )

  // Issue #182/#44：Source 专注视图。组合根决定何时进入：选中 Source /
  // Citation 跳转 → focusedSourceId 非 null → 左栏只渲染专注视图，
  // 其余 IA 内容（scope 编辑面/分组导航/面板）不渲染；Back 仅退出 focus
  // （Source Chat 保活由组合根负责，隐藏保留）。
  if (focusedSourceId !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={onExitSourceFocus}>
            {t('research.sources.back')}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SourceDetailPanel
            sourceId={focusedSourceId}
            highlightPageIdx={highlightPageIdx}
            focusRequestId={highlightPageIdx === null ? undefined : highlightRequestId}
          />
        </div>
      </div>
    )
  }

  const renderPane = () => {
    switch (pane) {
      case 'sources':
        return <SourceListPanel onOpenSource={onOpenSource} />
      case 'notes':
        return <NotesPanel />
      case 'insights':
        return <InsightsPanel />
      case 'transformation-runs':
        // #48 已合入：默认消费 TransformationRunsPanel（durable runs 历史 +
        // Rerun/详情 + citation 跳转）。组合根可用 transformationRuns 插槽覆盖。
        return transformationRuns !== undefined ? (
          transformationRuns
        ) : (
          <TransformationRunsPanel onCitationJump={handleRunsCitationJump} />
        )
    }
  }

  const paneButtonClass = (active: boolean) =>
    cn(
      'rounded-md px-2 py-1 text-sm transition-colors',
      active
        ? 'bg-accent font-medium text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
    )

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {/* RWV2-13：唯一 Scope 编辑面（模式控件）。常驻展示：无论当前子视图
          是 Materials/Results 哪一项，模式/选择仍可见可改（单一真源）。 */}
      <ResearchScopeEditor scopeEditRequest={scopeEditRequest} />

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/* 分组导航（语义化按钮组；flex-wrap：窄栏时折行而非裁剪） */}
        <div className="min-w-0 space-y-3" data-testid="workbench-group-nav">
          <section className="min-w-0 space-y-1.5" aria-labelledby="wb-group-materials">
            <h3
              id="wb-group-materials"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('research.workbench.groupMaterials')}
            </h3>
            <div className="flex min-w-0 flex-wrap gap-x-1 gap-y-1">
              {MATERIALS_ITEMS.map((item) => {
                const active = pane === item.pane
                return (
                  <button
                    key={item.pane}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    className={paneButtonClass(active)}
                    onClick={() => setPane(item.pane)}
                  >
                    {t(item.labelKey)}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="min-w-0 space-y-1.5" aria-labelledby="wb-group-results">
            <h3
              id="wb-group-results"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('research.workbench.groupResults')}
            </h3>
            <div className="flex min-w-0 flex-wrap gap-x-1 gap-y-1">
              {RESULTS_ITEMS.map((item) => {
                const active = pane === item.pane
                return (
                  <button
                    key={item.pane}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    className={paneButtonClass(active)}
                    onClick={() => setPane(item.pane)}
                  >
                    {t(item.labelKey)}
                  </button>
                )
              })}
            </div>
          </section>

          <section className="min-w-0 space-y-1.5" aria-labelledby="wb-group-tools">
            <h3
              id="wb-group-tools"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {t('research.workbench.groupTools')}
            </h3>
            <div className="flex min-w-0 flex-wrap gap-x-1 gap-y-1">
              {/* 跨区命令：打开主区 Run Template（不渲染第二模板面板）。 */}
              <Button
                size="sm"
                variant={researchTemplatesActive ? 'secondary' : 'ghost'}
                aria-current={researchTemplatesActive ? 'true' : undefined}
                data-testid="workbench-open-templates"
                onClick={onOpenResearchTemplates}
              >
                {t('research.workbench.tabTemplates')}
              </Button>
            </div>
          </section>
        </div>

        {/* 子视图内容区：独立滚动，不把面板内容顶出半屏容器 */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{renderPane()}</div>
      </div>
    </div>
  )
}
