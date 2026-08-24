'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { ResearchWorkbench } from '@/components/research/ResearchWorkbench'
import { ResearchWorkspace } from '@/components/research/ResearchWorkspace'

/**
 * /research：嵌入式 Research Workspace 入口路由（UI-01，设计 §4.1）。
 *
 * 父页面（RDLens 主页面）以 iframe 嵌入本路由；嵌入式模式关闭时
 * 重定向回普通 Notebook 首页（上游行为不变）。合并 UI-02 + UI-03：
 * 上半屏为 Sources/Notes/Insights/Transformations 工作台
 * （ResearchWorkbench），下半屏为 Search/Chat/Compare/Jobs 工作区
 * （ResearchWorkspace）；各自内部 Tab 切换，互不共享状态。
 */
export default function ResearchPage() {
  const router = useRouter()

  useEffect(() => {
    if (!isEmbeddedMode()) {
      router.replace('/notebooks')
    }
  }, [router])

  if (!isEmbeddedMode()) {
    return null
  }

  return (
    <div className="h-screen">
      <ResearchWorkspaceShell>
        <div className="flex h-full flex-col">
          {/* overflow-hidden：上半屏是固定 50% 高容器，面板内容超高时不得溢出
              叠画到下半屏（选择器行文字混叠）；滚动约束在工作台 Tabs 链路内 */}
          <div className="h-1/2 min-h-0 overflow-hidden">
            <ResearchWorkbench />
          </div>
          <div className="h-1/2 min-h-0 border-t">
            <ResearchWorkspace />
          </div>
        </div>
      </ResearchWorkspaceShell>
    </div>
  )
}
