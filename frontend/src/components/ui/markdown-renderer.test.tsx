import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'

import { MarkdownRenderer } from './markdown-renderer'

describe('MarkdownRenderer', () => {
  it('renders basic markdown', () => {
    const { container } = render(<MarkdownRenderer>{'# Title\n\nSome **bold** text'}</MarkdownRenderer>)
    expect(container.querySelector('h1')?.textContent).toBe('Title')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
  })

  it('highlights fenced code blocks for registered languages', () => {
    const { container } = render(
      <MarkdownRenderer>{'```python\ndef hello():\n    return 42\n```'}</MarkdownRenderer>
    )
    // PrismLight emits token spans when the grammar is registered; a plain
    // fallback would leave the code block without any token markup.
    expect(container.querySelectorAll('span[class*="token"]').length).toBeGreaterThan(0)
  })

  it('falls back to plain text for unknown languages without crashing', () => {
    const { container } = render(
      <MarkdownRenderer>{'```notalanguage\nsome content\n```'}</MarkdownRenderer>
    )
    expect(container.textContent).toContain('some content')
  })

  it('renders inline code without a highlighter block', () => {
    const { container } = render(<MarkdownRenderer>{'Use `npm ci` here'}</MarkdownRenderer>)
    expect(container.querySelector('code')?.textContent).toBe('npm ci')
    expect(container.querySelectorAll('span[class*="token"]').length).toBe(0)
  })

  // #1192（W3-G12）：内联 component 映射若每次 render 都新建函数，React 会把同名
  // 元素当成新类型而卸载重建 —— 浏览器随即折叠已有的文本选区，来源选段的
  // 「讨论选段/摘入文档」入口随之消失。此用例锁定「重渲染不替换正文 DOM」。
  it('keeps markdown DOM nodes and live text selections across re-renders', () => {
    const { container, rerender } = render(<MarkdownRenderer>{'alpha beta gamma'}</MarkdownRenderer>)
    const paragraph = container.querySelector('p')
    const textNode = paragraph?.firstChild ?? null
    expect(paragraph).not.toBeNull()
    expect(textNode).not.toBeNull()

    const range = document.createRange()
    range.setStart(textNode as Text, 0)
    range.setEnd(textNode as Text, 'alpha'.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    expect(selection?.toString()).toBe('alpha')

    rerender(<MarkdownRenderer>{'alpha beta gamma'}</MarkdownRenderer>)

    expect(container.querySelector('p')).toBe(paragraph)
    expect(container.querySelector('p')?.firstChild).toBe(textNode)
    expect(window.getSelection()?.toString()).toBe('alpha')
    window.getSelection()?.removeAllRanges()
  })

  // #1202：调用方传入的 components 覆盖项必须保持引用稳定；稳定的覆盖映射在
  // 重渲染后不得卸载/重建自定义元素（覆盖项按引用透传给 ReactMarkdown，元素
  // 类型因此保持同一引用）。若覆盖项每次 render 被误当成新类型，<a> 节点会被替换。
  it('keeps a stable component override mounted across re-renders', () => {
    const StableLink = ({ href, children }: { href?: string; children?: ReactNode }) => (
      <a data-testid="override-link" href={href}>
        {children}
      </a>
    )
    const components = { a: StableLink }

    const { container, rerender } = render(
      <MarkdownRenderer components={components}>{'[docs](https://example.com)'}</MarkdownRenderer>
    )
    const link = container.querySelector('a[data-testid="override-link"]')
    expect(link).not.toBeNull()

    rerender(
      <MarkdownRenderer components={components}>{'[docs](https://example.com)'}</MarkdownRenderer>
    )

    expect(container.querySelector('a[data-testid="override-link"]')).toBe(link)
  })
})
