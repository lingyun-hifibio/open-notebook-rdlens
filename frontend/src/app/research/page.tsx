'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { ResearchWorkspace } from '@/components/research/ResearchWorkspace'

/**
 * /research：嵌入式 Research Workspace 入口路由（UI-01，设计 §4.1）。
 *
 * 父页面（RDLens 主页面）以 iframe 嵌入本路由；嵌入式模式关闭时
 * 重定向回普通 Notebook 首页（上游行为不变）。UI-03 在此渲染
 * Search/Chat/Compare/Jobs 工作区；UI-02 的 Sources/Citation/Artifact
 * 面板并入时与此处并列（合并冲突按 PR 依赖顺序处理）。
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
        <ResearchWorkspace />
      </ResearchWorkspaceShell>
    </div>
  )
}
