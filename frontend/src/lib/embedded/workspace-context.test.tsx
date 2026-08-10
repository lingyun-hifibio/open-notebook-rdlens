import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useResearchWorkspace, ResearchWorkspaceProvider } from './workspace-context'

// UI-02 Red：工作台上下文（REQ-SCOPE-04）——Shell 认证后把 projectId/role
// 交给工作台面板；未认证/缺 claims 时上下文缺失，面板 fail-closed。

const wrapperOwner = ({ children }: { children: React.ReactNode }) => (
  <ResearchWorkspaceProvider projectId="proj_1" role="owner">
    {children}
  </ResearchWorkspaceProvider>
)

const wrapperAdmin = ({ children }: { children: React.ReactNode }) => (
  <ResearchWorkspaceProvider projectId="proj_1" role="admin_readonly">
    {children}
  </ResearchWorkspaceProvider>
)

describe('useResearchWorkspace', () => {
  it('owner 会话：projectId/role/isOwner 正确', () => {
    const { result } = renderHook(() => useResearchWorkspace(), { wrapper: wrapperOwner })
    expect(result.current.projectId).toBe('proj_1')
    expect(result.current.role).toBe('owner')
    expect(result.current.isOwner).toBe(true)
    expect(result.current.isAdminReadonly).toBe(false)
  })

  it('admin_readonly 会话：isAdminReadonly 为 true，isOwner 为 false', () => {
    const { result } = renderHook(() => useResearchWorkspace(), { wrapper: wrapperAdmin })
    expect(result.current.role).toBe('admin_readonly')
    expect(result.current.isOwner).toBe(false)
    expect(result.current.isAdminReadonly).toBe(true)
  })

  it('缺少 Provider 时抛错（fail-closed：面板不允许在无项目上下文下渲染）', () => {
    expect(() => renderHook(() => useResearchWorkspace())).toThrow(/workspace context/i)
  })
})
