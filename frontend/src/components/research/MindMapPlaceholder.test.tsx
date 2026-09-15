import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MindMapPlaceholder } from './MindMapPlaceholder'

// #445：Mind Map 占位面板——仅渲染约定文案（标题 + 说明），无任何业务
// 逻辑/数据请求；选中态、焦点态与键盘可访问性由主区 Radix Tabs 统一
// 提供（ResearchWorkspace.test.tsx 覆盖进入/离开导航）。
describe('MindMapPlaceholder（#445 占位动作）', () => {
  it('渲染约定占位标题与说明', () => {
    render(<MindMapPlaceholder />)
    const placeholder = screen.getByTestId('mind-map-placeholder')
    expect(placeholder).toHaveTextContent('research.mindMap.title')
    expect(placeholder).toHaveTextContent('research.mindMap.description')
    // 标题语义化（heading），说明为正文
    expect(
      screen.getByRole('heading', { name: 'research.mindMap.title' }),
    ).toBeInTheDocument()
  })
})
