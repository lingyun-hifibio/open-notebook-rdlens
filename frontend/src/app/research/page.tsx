'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { getResearchProjectId } from '@/lib/research/project'
import { useIsDesktop } from '@/lib/hooks/use-media-query'
import { ResearchJobsProvider } from '@/components/research/ResearchJobsProvider'
import { ResearchHeader } from '@/components/research/ResearchHeader'
import { ResearchEgressConsentDialog } from '@/components/research/ResearchEgressConsentDialog'
import { ResearchWorkbench } from '@/components/research/ResearchWorkbench'
import { ResearchWorkspace } from '@/components/research/ResearchWorkspace'
import { ResearchSourceChatPanel } from '@/components/research/ResearchSourceChatPanel'
import { ResearchLayout } from '@/components/research/ResearchLayout'
import { type ResearchMainAction } from '@/components/research/research-main-action'
import { useTranslation } from '@/lib/hooks/use-translation'

/**
 * /research：嵌入式 Research Workspace 入口路由（UI-01，设计 §4.1；RWV2-40 IA）。
 *
 * RWV2-40（Fork #44）目标 IA：
 * - Header：Project | Current scope | Global model | Activity | Export
 *   （ResearchHeader；Scope Summary 经同 key 查询迁移至此）。
 * - 左栏（ResearchWorkbench）：Materials(Sources, Notes) / Results(Insights,
 *   Transformation runs 插槽) / Tools(Research templates 跨区命令)。
 * - 主区（ResearchWorkspace）：Evidence Search / Research Chat / Compare /
 *   Run Template 四动作；Jobs 迁往 Header Activity 兼容壳。
 * - 组合根同时保活「全局工作区」与「单个创建过的 Source Chat」：显隐只由
 *   `sourceFocusActive` 决定（Back 仅退出 focus，Source Chat 隐藏保留；
 *   A→B 用 projectId:sourceId key 隔离）。唯一 keyed Source Chat、访问便
 *   Back/Source focus 的 highlight 时序与 Citation 跳转语义与 Issue #182
 *   保持一致组件能力。
 *
 * 状态划分（冻结）：
 * - 组合根持有 `activeMainAction`；保活 visited 集合由 ResearchWorkspace
 *   内部维护并以渲染期并集（visited∪{active}）保证首访动作同帧挂载；
 * - highlightPageIdx/highlightRequestId 线程保留（同页重复 Citation 再次聚焦）；
 * - 根级 handleEditScopeAllStates/onCitationJump/onOpenResearchTemplates 统一链。
 */
export default function ResearchPage() {
  const router = useRouter()
  const { t } = useTranslation()

  // 主区当前动作（组合根受控；保活的 visited 集合由 ResearchWorkspace
  // 内部维护——渲染期并集 visited∪{active} 保证首访动作同帧挂载）
  const [activeMainAction, setActiveMainAction] =
    useState<ResearchMainAction>('evidence-search')

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  // Source 专注态与“已选中来源”分离：Back 只清 focus，不丢唯一 Source Chat。
  const [sourceFocusActive, setSourceFocusActive] = useState(false)
  const [highlightPageIdx, setHighlightPageIdx] = useState<number | null>(null)
  const [highlightRequestId, setHighlightRequestId] = useState(0)
  const [globalMaximized, setGlobalMaximized] = useState(false)
  const [scopeEditRequest, setScopeEditRequest] = useState(0)
  const isDesktop = useIsDesktop()
  const [globalCompactPanel, setGlobalCompactPanel] = useState<'primary' | 'secondary'>('secondary')
  const [sourceCompactPanel, setSourceCompactPanel] = useState<'primary' | 'secondary'>('primary')

  // Edit scope 统一链路（R8-3）：退 Source focus → 退最大化 → 回左栏编辑面 →
  // 递增聚焦请求。Header ScopeSummary / Run Template Dialog 共用本入口。
  const handleEditScopeAllStates = useCallback(() => {
    setSourceFocusActive(false)
    setGlobalMaximized(false)
    setScopeEditRequest((request) => request + 1)
  }, [])

  const activateAction = useCallback((action: ResearchMainAction) => {
    setActiveMainAction(action)
  }, [])

  // 选中来源（列表/跨区 Citation）→ 进入 Source focus（左栏 Back+详情，右栏
  // Source Chat）；默认重置高亮，显式 pageIdx 时递增请求序号（防泄漏+同页重跳）。
  const openSource = useCallback((sourceId: string, pageIdx?: number | null) => {
    setSelectedSourceId(sourceId)
    setSourceFocusActive(true)
    setSourceCompactPanel('primary')
    const nextHighlight = pageIdx ?? null
    setHighlightPageIdx(nextHighlight)
    if (nextHighlight !== null) {
      setHighlightRequestId((requestId) => requestId + 1)
    }
  }, [])

  // Back：仅退出 Source focus（Source Chat 保活隐藏，不卸载）。
  const exitSourceFocus = useCallback(() => {
    setSourceFocusActive(false)
  }, [])

  // Source Chat 内 Citation → 只需高亮左栏详情（不改变选中/专注状态）。
  const handleHighlightPage = useCallback((pageIdx: number) => {
    setHighlightPageIdx(pageIdx)
    setHighlightRequestId((requestId) => requestId + 1)
    setSourceCompactPanel('primary')
  }, [])

  // 跨区 Citation（Workspace/Activity/Transformation 报告）→ 选源 + 高亮。
  const handleCitationJump = useCallback(
    (sourceId: string, pageIdx: number | null) => {
      if (pageIdx === null) {
        openSource(sourceId)
        return
      }
      openSource(sourceId, pageIdx)
    },
    [openSource],
  )

  // Tools/Research templates 跨区命令：先归一布局（退 focus/最大化）再切动作。
  const handleOpenResearchTemplates = useCallback(() => {
    setSourceFocusActive(false)
    setGlobalMaximized(false)
    setActiveMainAction('run-template')
  }, [])

  useEffect(() => {
    if (!isEmbeddedMode()) {
      router.replace('/notebooks')
    }
  }, [router])

  if (!isEmbeddedMode()) {
    return null
  }

  const projectId = getResearchProjectId() ?? ''
  const sourceMode = sourceFocusActive && selectedSourceId !== null
  const sourceDesktop = sourceMode && isDesktop
  const compact = !isDesktop
  const focusedSourceId = sourceFocusActive && selectedSourceId !== null ? selectedSourceId : null

  return (
    // Issue #243 GMOD-FE-01 §6.2：页面根 h-screen flex-col；Header shrink-0，
    // ResearchLayout min-h-0 flex-1——不产生双滚动。
    <div className="flex h-screen flex-col">
      <ResearchWorkspaceShell>
        {/* Jobs 控制器唯一实例化点：Header Activity + 主区 Chat coverage/
            Compare 共享同一 3s 轮询与 localStorage 登记 */}
        <ResearchJobsProvider>
          <ResearchHeader
            onEditScopeAllStates={handleEditScopeAllStates}
            onCitationJump={handleCitationJump}
          />
          {/* 根级统一外发确认（§6.8 single-flight） */}
          <ResearchEgressConsentDialog />
          <div className="min-h-0 flex-1">
            <ResearchLayout
              layoutId={sourceDesktop ? 'source-desktop' : 'global'}
              axis="horizontal"
              compact={compact}
              defaultRatio={sourceDesktop ? 55 : 35}
              minPrimary={sourceDesktop ? 360 : 280}
              minSecondary={sourceDesktop ? 360 : 420}
              primaryLabel={sourceMode ? t('research.layout.sourceContent') : t('research.layout.artifacts')}
              secondaryLabel={sourceMode ? t('research.layout.sourceChat') : t('research.layout.workspace')}
              separatorLabel={sourceMode ? t('research.layout.resizeSource') : t('research.layout.resizeWorkspace')}
              expandSecondaryLabel={sourceMode ? t('research.layout.expandSourceChat') : t('research.layout.expandWorkspace')}
              restoreLabel={t('research.layout.restore')}
              compactPrimaryLabel={sourceMode ? t('research.layout.content') : t('research.layout.artifacts')}
              compactSecondaryLabel={sourceMode ? t('research.layout.chat') : t('research.layout.workspace')}
              compactPanel={sourceMode ? sourceCompactPanel : globalCompactPanel}
              onCompactPanelChange={sourceMode ? setSourceCompactPanel : setGlobalCompactPanel}
              maximized={sourceDesktop ? undefined : globalMaximized}
              onMaximizedChange={sourceDesktop ? undefined : setGlobalMaximized}
            >
              {[
                <div key="workbench" className="h-full min-h-0 overflow-hidden">
                  <ResearchWorkbench
                    focusedSourceId={focusedSourceId}
                    highlightPageIdx={highlightPageIdx}
                    highlightRequestId={highlightRequestId}
                    researchTemplatesActive={
                      !sourceMode && activeMainAction === 'run-template'
                    }
                    onOpenSource={openSource}
                    onExitSourceFocus={exitSourceFocus}
                    onOpenResearchTemplates={handleOpenResearchTemplates}
                    scopeEditRequest={scopeEditRequest}
                  />
                </div>,
                <div key="workspace" className={`h-full min-h-0 ${compact ? '' : 'border-l'}`}>
                  {/* 全局工作区保持挂载（隐藏但保活：Chat 流/Job 轮询/四动作
                      访问状态不丢）；Source Chat 也保持挂载，显隐由
                      sourceFocusActive 决定，Back 不卸载。 */}
                  <div className="h-full" hidden={sourceMode}>
                    <ResearchWorkspace
                      activeAction={activeMainAction}
                      onActiveActionChange={activateAction}
                      surfaceActive={!sourceMode}
                      onCitationJump={handleCitationJump}
                      onEditScopeAllStates={handleEditScopeAllStates}
                    />
                  </div>
                  {selectedSourceId !== null && (
                    <div className="h-full" hidden={!sourceMode}>
                      <ResearchSourceChatPanel
                        key={`${projectId}:${selectedSourceId}`}
                        projectId={projectId}
                        sourceId={selectedSourceId}
                        onHighlightPage={handleHighlightPage}
                      />
                    </div>
                  )}
                </div>,
              ]}
            </ResearchLayout>
          </div>
        </ResearchJobsProvider>
      </ResearchWorkspaceShell>
    </div>
  )
}