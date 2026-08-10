'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslation } from '@/lib/hooks/use-translation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'

/**
 * /research：嵌入式 Research Workspace 入口路由（UI-01，设计 §4.1）。
 *
 * 父页面（RDLens 主页面）以 iframe 嵌入本路由；嵌入式模式关闭时
 * 重定向回普通 Notebook 首页（上游行为不变）。业务面板由 UI-02/03
 * 在 Shell 就绪后渲染。
 */
export default function ResearchPage() {
  const router = useRouter()
  const { t } = useTranslation()

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
        {/* UI-02/03 在此填充 Sources/Citation/Artifact 工作台面板 */}
        <div className="flex h-full items-center justify-center p-8">
          <p className="text-sm text-muted-foreground">{t('research.ready')}</p>
        </div>
      </ResearchWorkspaceShell>
    </div>
  )
}
