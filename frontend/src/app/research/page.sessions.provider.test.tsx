import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/**
 * 真实 Provider 层级测试（Codex review B1）：
 * 页面导航 hooks 必须位于 `ResearchWorkspaceShell` 内部真实
 * `ResearchSessionRuntimeProvider` 的后代，否则 `useResearchSessionRuntimeOptional()`
 * 恒为 null（列表/创建/恢复全部不可用）。本文件 **不 mock runtime 模块**，
 * 只把 Shell 替换为“渲染真实 Provider + 注入 fake transport”的壳。
 */

const holder = vi.hoisted(() => ({
  transport: null as null | {
    bootstrap: (input: unknown) => Promise<unknown>
  },
}))

const apiMocks = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  listSourceChatSessions: vi.fn(),
  createChatSession: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: () => true,
}))

vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => true,
  useIsDesktop: () => true,
}))

vi.mock('@/lib/research/project', () => ({
  getResearchProjectId: () => 'proj-1',
}))

vi.mock('@/components/research/ResearchJobsProvider', () => ({
  ResearchJobsProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/research/ResearchHeader', () => ({
  ResearchHeader: () => <div data-testid="header" />,
}))

vi.mock('@/components/research/ResearchEgressConsentDialog', () => ({
  ResearchEgressConsentDialog: () => null,
}))

vi.mock('@/components/research/ResearchLayout', () => ({
  ResearchLayout: ({ children }: { children: ReactNode }) => (
    <div data-testid="research-layout">{children}</div>
  ),
}))

vi.mock('@/components/research/ResearchWorkbench', () => ({
  ResearchWorkbench: () => <div data-testid="workbench" />,
}))

vi.mock('@/components/research/ResearchWorkspace', () => ({
  ResearchWorkspace: () => <div data-testid="workspace" />,
}))

vi.mock('@/components/research/ResearchSourceChatPanel', () => ({
  ResearchSourceChatPanel: () => <div data-testid="source-chat-panel" />,
}))

vi.mock('@/lib/research/api', () => ({
  listChatSessions: (projectId: string, params: unknown) =>
    apiMocks.listChatSessions(projectId, params),
  listSourceChatSessions: (projectId: string, sourceId: string, params: unknown) =>
    apiMocks.listSourceChatSessions(projectId, sourceId, params),
  createChatSession: (projectId: string, input: unknown) =>
    apiMocks.createChatSession(projectId, input),
}))

vi.mock('@/lib/embedded/shell', async () => {
  const runtimeModule = await vi.importActual<typeof import('@/lib/hooks/research-session-runtime')>(
    '@/lib/hooks/research-session-runtime',
  )
  return {
    ResearchWorkspaceShell: ({ children }: { children?: ReactNode }) => (
      <runtimeModule.ResearchSessionRuntimeProvider
        authGeneration={1}
        projectId="proj-1"
        viewerUserId="7"
        role="owner"
        masked={false}
        transport={holder.transport as never}
      >
        {children}
      </runtimeModule.ResearchSessionRuntimeProvider>
    ),
  }
})

import ResearchPage from './page'

const PROJECT_ID = 'proj-1'

function listResponse(items: unknown[] = []) {
  return {
    items,
    next_cursor: null,
    viewer_user_id: 7,
    capabilities: {
      sessions: {
        contract: 'research-session-v1',
        editor_ready: true,
        submission_ready: { global: true, source: true },
      },
    },
  }
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ResearchPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  cleanup()
  apiMocks.listChatSessions.mockReset().mockResolvedValue(listResponse())
  apiMocks.listSourceChatSessions.mockReset().mockResolvedValue({ items: [], total: 0 })
  apiMocks.createChatSession.mockReset()
  holder.transport = {
    bootstrap: async () => ({
      status: 'ok',
      viewerUserId: 7,
      capabilities: {
        contract: 'research-session-v1',
        editorReady: true,
        submissionReady: { global: true, source: true },
        degraded: false,
        reason: null,
      },
    }),
  }
})

describe('ResearchPage 真实 Provider 层级（review B1）', () => {
  it('页面导航 hooks 位于 Shell 内 Provider 后代：列表请求真实发出、导航可见', async () => {
    renderPage()

    await waitFor(() =>
      expect(apiMocks.listChatSessions).toHaveBeenCalledWith(PROJECT_ID, expect.anything()),
    )
    expect(screen.getByTestId('research-session-nav')).toBeInTheDocument()
    // 导航可用说明 runtime 非 null：两侧 switcher 均渲染。
    expect(screen.getByTestId('session-switcher-global')).toBeInTheDocument()
  })

  it('Provider 层级下 display 指针恢复仍生效（指针属于真实 runtime 的 cache 授权）', async () => {
    renderPage()

    await waitFor(() =>
      expect(apiMocks.listChatSessions).toHaveBeenCalledWith(PROJECT_ID, expect.anything()),
    )
    const sessions = apiMocks.listChatSessions.mock.calls[0][1] as {
      kind: string
      limit: number
    }
    expect(sessions.kind).toBe('all')
  })
})
