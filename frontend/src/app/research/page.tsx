'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { getResearchProjectId } from '@/lib/research/project'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { ResearchWorkbench } from '@/components/research/ResearchWorkbench'
import { ResearchWorkspace } from '@/components/research/ResearchWorkspace'
import { ResearchSourceChatPanel } from '@/components/research/ResearchSourceChatPanel'
import { ResearchLayout } from '@/components/research/ResearchLayout'

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
 * `highlightPageIdx`，定位上半屏 SourceDetailPanel 对应 chunk/page
 * （0-based 存储仅展示 +1，REQ-DATA-03）；不强制切换上半屏 tab。
 */
export default function ResearchPage() {
  const router = useRouter()

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [highlightPageIdx, setHighlightPageIdx] = useState<number | null>(null)
  const hasUsableHeight = useMediaQuery('(min-height: 560px)')

  const handleSelectSource = useCallback(
    (sourceId: string, opts?: { highlightPageIdx?: number | null }) => {
      setSelectedSourceId(sourceId)
      // 默认重置高亮页（防上次高亮泄漏到新来源）
      setHighlightPageIdx(opts?.highlightPageIdx ?? null)
    },
    [],
  )

  const handleCloseSource = useCallback(() => {
    setSelectedSourceId(null)
    setHighlightPageIdx(null)
  }, [])

  const handleHighlightPage = useCallback((pageIdx: number) => {
    setHighlightPageIdx(pageIdx)
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

  return (
    <div className="h-screen">
      <ResearchWorkspaceShell>
        <ResearchLayout
          axis="vertical"
          compact={!hasUsableHeight}
          defaultRatio={40}
          minPrimary={200}
          minSecondary={300}
          primaryLabel="Research artifacts"
          secondaryLabel="Research workspace"
          separatorLabel="Resize research panels"
          expandSecondaryLabel="Expand workspace"
          restoreLabel="Restore layout"
          compactPrimaryLabel="Research artifacts"
          compactSecondaryLabel="Workspace"
        >
          {[
            <div key="workbench" className="h-full min-h-0 overflow-hidden">
            <ResearchWorkbench
              selectedSourceId={selectedSourceId}
              highlightPageIdx={highlightPageIdx}
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
