'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchJobs, type UseResearchJobsResult } from '@/lib/hooks/use-research-jobs'

/**
 * RWV2-40（Fork #44）：Jobs 控制器唯一实例化点。
 *
 * 目标 IA 把 Jobs 从主工作区动作迁到 Header 的 Activity 兼容壳，同时
 * Chat 的 coverage 任务卡与 Compare 的创建状态仍消费同一 Jobs 控制器。
 * 为避免 3s 轮询出现第二实例，`useResearchJobs` 只能在 ResearchPageContent
 * 根（认证 Provider 子树内）实例化一次，并向下经 context 提供。
 *
 * Admin 只读的 cancel/retry 抑制发生在**消费层**（渲染按钮处按角色省略
 * callback，组件在无 callback 时不渲染按钮）；后端授权仍是最终权威。
 */

const ResearchJobsContext = createContext<UseResearchJobsResult | null>(null)

export function ResearchJobsProvider({ children }: { children: ReactNode }) {
  const { projectId } = useResearchWorkspace()
  const controller = useResearchJobs({ projectId })
  return (
    <ResearchJobsContext.Provider value={controller}>
      {children}
    </ResearchJobsContext.Provider>
  )
}

/** 消费统一 Jobs controller；缺 Provider 时 fail-closed。 */
export function useResearchJobsController(): UseResearchJobsResult {
  const value = useContext(ResearchJobsContext)
  if (value === null) {
    throw new Error('ResearchJobsProvider is not available')
  }
  return value
}
