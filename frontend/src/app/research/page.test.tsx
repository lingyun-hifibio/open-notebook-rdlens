import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// 修复 Red：/research 上下半屏骨架。上半屏是固定 50% 高容器，内容超高时
// 若无裁剪会溢出叠画到下半屏（截图：点开笔记"编辑"后表单把卡片列表推出
// 盒底，与"来源(1/5)"选择器文字混叠）。上半屏包裹层必须裁剪溢出
// （滚动约束在 ResearchWorkbench 的 Tabs 链路内实现）。

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}))

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: () => true,
}))

vi.mock('@/lib/embedded/shell', () => ({
  ResearchWorkspaceShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}))

vi.mock('@/components/research/ResearchWorkbench', () => ({
  ResearchWorkbench: () => <div data-testid="workbench" />,
}))

vi.mock('@/components/research/ResearchWorkspace', () => ({
  ResearchWorkspace: () => <div data-testid="workspace" />,
}))

import ResearchPage from './page'

describe('/research 页面骨架', () => {
  it('上半屏包裹层固定半屏高且裁剪溢出（overflow-hidden）', () => {
    render(<ResearchPage />)
    const wrapper = screen.getByTestId('workbench').parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('h-1/2', 'min-h-0', 'overflow-hidden')
  })

  it('下半屏包裹层固定半屏高（与上半屏各占 50%，无剩余可分配空间）', () => {
    render(<ResearchPage />)
    const wrapper = screen.getByTestId('workspace').parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('h-1/2', 'min-h-0')
  })
})
