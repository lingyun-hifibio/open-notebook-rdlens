'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { ResearchWorkbench } from '@/components/research/ResearchWorkbench'

/**
 * /research：嵌入式 Research Workspace 入口路由（UI-01，设计 §4.1）。
 *
 * 父页面（RDLens 主页面）以 iframe 嵌入本路由；嵌入式模式关闭时
 * 重定向回普通 Notebook 首页（上游行为不变）。UI-02：Shell 认证后
 * 渲染 Sources/Notes/Insights/Transformations 工作台。
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
        <ResearchWorkbench />
      </ResearchWorkspaceShell>
    </div>
  )
}
