import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * W1 #1104：/research 路由分支（UI 规格 v1 §5.10 / BEH-13）。
 *
 * - 默认渲染目标壳（TargetShell）；
 * - 只有 iframe URL 显式带 `legacy=1` 才渲染旧壳组合根；
 * - 旧壳组合层自身的断言见 page.test.tsx / page.sessions*.test.tsx。
 */

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

vi.mock('@/lib/embedded/shell', () => ({
  ResearchWorkspaceShell: ({ children }: { children?: ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}))

vi.mock('@/components/research/ResearchJobsProvider', () => ({
  ResearchJobsProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

// 目标壳：本文件只验证路由选择，目标壳内部另有 TargetShell.test.tsx。
vi.mock('@/components/research/target/TargetShell', () => ({
  TargetShell: () => <div data-testid="target-shell" />,
}))

// 旧壳组合层：只保留可识别的探针（其内部组件各自有测试）。
vi.mock('@/components/research/ResearchHeader', () => ({
  ResearchHeader: () => <div data-testid="legacy-header" />,
}))

vi.mock('@/components/research/ResearchEgressConsentDialog', () => ({
  ResearchEgressConsentDialog: () => null,
}))

vi.mock('@/components/research/ResearchLayout', () => ({
  ResearchLayout: ({ children }: { children?: ReactNode }) => (
    <div data-testid="legacy-layout">{children}</div>
  ),
}))

vi.mock('@/components/research/ResearchWorkbench', () => ({
  ResearchWorkbench: () => <div data-testid="legacy-workbench" />,
}))

vi.mock('@/components/research/ResearchWorkspace', () => ({
  ResearchWorkspace: () => <div data-testid="legacy-workspace" />,
}))

vi.mock('@/components/research/ResearchSourceChatPanel', () => ({
  ResearchSourceChatPanel: () => <div data-testid="legacy-source-chat" />,
}))

vi.mock('@/components/research/ResearchSessionSwitcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/research/ResearchSessionSwitcher')>()
  return {
    ...actual,
    ResearchSessionSwitcher: () => <div data-testid="legacy-session-switcher" />,
  }
})

vi.mock('@/lib/hooks/use-research-sessions', () => ({
  useResearchSessions: () => ({
    sessions: [],
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    unauthorized: false,
    sourceUnavailable: false,
    hasMore: false,
    capabilitiesReady: false,
    canList: false,
    canCreate: false,
    listDisabledReason: 'runtime_unavailable',
    createDisabledReason: 'runtime_unavailable',
    creating: false,
    createError: null,
    created: null,
    refresh: vi.fn(),
    loadMore: vi.fn(),
    create: vi.fn(async () => null),
  }),
}))

import ResearchPage from './page'

function setUrl(search: string) {
  window.history.replaceState(null, '', `/research${search}`)
}

beforeEach(() => {
  cleanup()
  setUrl('')
})

describe('/research 路由：默认目标壳 / legacy=1 旧壳', () => {
  it('默认（无 legacy 参数）渲染目标壳，不渲染旧壳组合根', () => {
    setUrl('')
    render(<ResearchPage />)
    const mode = screen.getByTestId('research-page-mode')
    expect(mode).toHaveAttribute('data-mode', 'target')
    expect(screen.getByTestId('target-shell')).toBeInTheDocument()
    expect(screen.queryByTestId('legacy-workbench')).toBeNull()
    expect(screen.queryByTestId('legacy-header')).toBeNull()
  })

  it('legacy=1 → 渲染现有旧壳（代码保留、路由可回退）', () => {
    setUrl('?legacy=1')
    render(<ResearchPage />)
    const mode = screen.getByTestId('research-page-mode')
    expect(mode).toHaveAttribute('data-mode', 'legacy')
    expect(screen.getByTestId('legacy-header')).toBeInTheDocument()
    expect(screen.getByTestId('legacy-workbench')).toBeInTheDocument()
    expect(screen.queryByTestId('target-shell')).toBeNull()
  })

  it('legacy 参数非 1 时仍是目标壳（只有显式 legacy=1 回退）', () => {
    setUrl('?legacy=0&foo=bar')
    render(<ResearchPage />)
    expect(screen.getByTestId('research-page-mode')).toHaveAttribute('data-mode', 'target')
  })
})
