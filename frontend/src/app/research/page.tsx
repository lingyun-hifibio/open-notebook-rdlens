'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { getResearchProjectId } from '@/lib/research/project'
import { useIsDesktop, useMediaQuery } from '@/lib/hooks/use-media-query'
import { ResearchWorkbench } from '@/components/research/ResearchWorkbench'
import { ResearchWorkspace } from '@/components/research/ResearchWorkspace'
import { ResearchSourceChatPanel } from '@/components/research/ResearchSourceChatPanel'
import { ResearchLayout } from '@/components/research/ResearchLayout'
import { useTranslation } from '@/lib/hooks/use-translation'

/**
 * /research：嵌入式 Research Workspace 入口路由（UI-01，设计 §4.1）。
 *
 * 父页面（RDLens 主页面）以 iframe 嵌入本路由；嵌入式模式关闭时
 * 重定向回普通 Notebook 首页（上游行为不变）。合并 UI-02 + UI-03：
 * 上半屏为 Sources/Notes/Insights/Transformations 工作台
 * （ResearchWorkbench），下半屏为 Search/Chat/Compare/Jobs 工作区
 * （ResearchWorkspace）；各自内部 Tab 切换，互不共享状态。
 *
 * Issue #182：`selectedSourceId`/`highlightPageIdx` 提升到组合层。
 * 上半屏选中 Source 时，下半屏切换为该 Source 专属的 Source Chat 面板；
 * 全局 Workspace 以 hidden 包裹**保持挂载**（多篇 Chat 流与 Job 轮询
 * 本地状态不丢失；浏览器隐藏期间轮询继续，服务端 turn 不受影响）。
 * 关闭来源后卸载面板并恢复全局工作区 tabs。面板内 citation 点击设置
 * `highlightPageIdx`，定位上半屏 SourceDetailPanel 对应 chunk/page；独立的
 * `highlightRequestId` 保证重复点击同一页 Citation 也会再次移动焦点
 * （0-based 存储仅展示 +1，REQ-DATA-03）；不强制切换上半屏 tab。
 */
export default function ResearchPage() {
  const router = useRouter()
  const { t } = useTranslation()

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [highlightPageIdx, setHighlightPageIdx] = useState<number | null>(null)
  const [highlightRequestId, setHighlightRequestId] = useState(0)
  const hasUsableHeight = useMediaQuery('(min-height: 560px)')
  const isDesktop = useIsDesktop()
  const [globalCompactPanel, setGlobalCompactPanel] = useState<'primary' | 'secondary'>('secondary')
  const [sourceCompactPanel, setSourceCompactPanel] = useState<'primary' | 'secondary'>('primary')

  const handleSelectSource = useCallback(
    (sourceId: string, opts?: { highlightPageIdx?: number | null }) => {
      setSelectedSourceId(sourceId)
      setSourceCompactPanel('primary')
      // 默认重置高亮页（防上次高亮泄漏到新来源）
      const nextHighlightPageIdx = opts?.highlightPageIdx ?? null
      setHighlightPageIdx(nextHighlightPageIdx)
      if (nextHighlightPageIdx !== null) {
        setHighlightRequestId((requestId) => requestId + 1)
      }
    },
    [],
  )

  const handleCloseSource = useCallback(() => {
    setSelectedSourceId(null)
    setHighlightPageIdx(null)
  }, [])

  const handleHighlightPage = useCallback((pageIdx: number) => {
    setHighlightPageIdx(pageIdx)
    setHighlightRequestId((requestId) => requestId + 1)
    setSourceCompactPanel('primary')
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
  const sourceMode = selectedSourceId !== null
  const sourceDesktop = sourceMode && isDesktop
  const compact = sourceMode ? !isDesktop : !hasUsableHeight

  return (
    <div className="h-screen">
      <ResearchWorkspaceShell>
        <ResearchLayout
          layoutId={sourceDesktop ? 'source-desktop' : 'global'}
          axis={sourceDesktop ? 'horizontal' : 'vertical'}
          compact={compact}
          defaultRatio={sourceDesktop ? 55 : 40}
          minPrimary={sourceDesktop ? 360 : 200}
          minSecondary={sourceDesktop ? 360 : 300}
          primaryLabel={sourceMode ? t('research.layout.sourceContent') : t('research.layout.artifacts')}
          secondaryLabel={sourceMode ? t('research.layout.sourceChat') : t('research.layout.workspace')}
          separatorLabel={sourceMode ? t('research.layout.resizeSource') : t('research.layout.resizeWorkspace')}
          expandSecondaryLabel={sourceMode ? t('research.layout.expandSourceChat') : t('research.layout.expandWorkspace')}
          restoreLabel={t('research.layout.restore')}
          compactPrimaryLabel={sourceMode ? t('research.layout.content') : t('research.layout.artifacts')}
          compactSecondaryLabel={sourceMode ? t('research.layout.chat') : t('research.layout.workspace')}
          compactPanel={sourceMode ? sourceCompactPanel : globalCompactPanel}
          onCompactPanelChange={sourceMode ? setSourceCompactPanel : setGlobalCompactPanel}
        >
          {[
            <div key="workbench" className="h-full min-h-0 overflow-hidden">
            <ResearchWorkbench
              displayMode={sourceMode ? 'source-focus' : 'workbench'}
              selectedSourceId={selectedSourceId}
              highlightPageIdx={highlightPageIdx}
              highlightRequestId={highlightRequestId}
              onSelectSource={handleSelectSource}
              onCloseSource={handleCloseSource}
            />
            </div>,
            <div key="workspace" className="h-full min-h-0 border-t">
            {/* 全局工作区保持挂载：选中来源时以 hidden 包裹（display:none），
                多篇 Chat 流与 Job 轮询本地状态不丢失；面板占满同一半屏槽位 */}
            <div className={`h-full ${selectedSourceId !== null ? 'hidden' : ''}`}>
              <ResearchWorkspace />
            </div>
            {selectedSourceId !== null && (
              <div className="h-full">
                <ResearchSourceChatPanel
                  projectId={projectId}
                  sourceId={selectedSourceId}
                  onHighlightPage={handleHighlightPage}
                />
              </div>
            )}
            </div>,
          ]}
        </ResearchLayout>
      </ResearchWorkspaceShell>
    </div>
  )
}
