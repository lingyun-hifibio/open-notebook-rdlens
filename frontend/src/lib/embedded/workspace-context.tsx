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
 * RDLens #602 第三批 PR-1：额外透传认证代际 `authGeneration`
 * （= `SessionState.authEpoch`，DESIGN §3.2/§9.6、L1121）。Research 私有
 * 查询键与直接加载守卫据此区分新旧认证代，旧代响应不得回填。
 *
 * 服务端授权仍是权威（Gateway 每请求校验，REQ-AUTH-02/04）；本上下文
 * 只决定 UI 呈现与请求路径。无 Provider 时抛错——面板 fail-closed，
 * 不允许在缺少项目上下文时渲染。
 */

export interface ResearchWorkspaceValue {
  userId?: string
  projectId: string
  role: ResearchRole
  /**
   * 认证代际（单调递增；`SessionState.authEpoch`）。不得从 token 过期时间、
   * projectId 或 effect 次数派生（DESIGN §3.2）。
   *
   * 可选是为了不迫使既有面板测试（其余 PR 所有）全部补参；shell 恒显式传入，
   * 缺省 0 只用于历史测试/孤立渲染。
   */
  authGeneration?: number
  isOwner: boolean
  isAdminReadonly: boolean
}

const ResearchWorkspaceContext = createContext<ResearchWorkspaceValue | null>(null)

export function ResearchWorkspaceProvider({
  userId = '',
  projectId,
  role,
  authGeneration,
  children,
}: {
  userId?: string
  projectId: string
  role: ResearchRole
  authGeneration?: number
  children: React.ReactNode
}): React.ReactNode {
  const value: ResearchWorkspaceValue = {
    userId,
    projectId,
    role,
    authGeneration: authGeneration ?? 0,
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

/**
 * 可选读取（不抛错）：供既可在工作台内、也可在独立测试/孤立渲染中使用的
 * 数据 hook 使用。无 Provider 返回 null，调用方自行 fail-closed。
 */
export function useResearchWorkspaceOptional(): ResearchWorkspaceValue | null {
  return useContext(ResearchWorkspaceContext)
}
