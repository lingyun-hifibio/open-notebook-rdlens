'use client'

import { createContext, useContext } from 'react'
import type { ResearchRole } from './claims'

/**
 * 工作台会话上下文（UI-02，REQ-SCOPE-04；设计 §4.4）。
 *
 * ResearchWorkspaceShell 认证（authenticated）后把 Token claims 中的
 * projectId/role 注入本上下文，供 Sources/Notes/Insights/Transformations
 * 面板消费（Gateway 路径与 Owner 写 / Admin 只读矩阵）。
 *
 * 服务端授权仍是权威（Gateway 每请求校验，REQ-AUTH-02/04）；本上下文
 * 只决定 UI 呈现与请求路径。无 Provider 时抛错——面板 fail-closed，
 * 不允许在缺少项目上下文时渲染。
 */

export interface ResearchWorkspaceValue {
  projectId: string
  role: ResearchRole
  isOwner: boolean
  isAdminReadonly: boolean
}

const ResearchWorkspaceContext = createContext<ResearchWorkspaceValue | null>(null)

export function ResearchWorkspaceProvider({
  projectId,
  role,
  children,
}: {
  projectId: string
  role: ResearchRole
  children: React.ReactNode
}): React.ReactNode {
  const value: ResearchWorkspaceValue = {
    projectId,
    role,
    isOwner: role === 'owner',
    isAdminReadonly: role === 'admin_readonly',
  }
  return (
    <ResearchWorkspaceContext.Provider value={value}>
      {children}
    </ResearchWorkspaceContext.Provider>
  )
}

export function useResearchWorkspace(): ResearchWorkspaceValue {
  const value = useContext(ResearchWorkspaceContext)
  if (value === null) {
    throw new Error('research workspace context is not available')
  }
  return value
}
