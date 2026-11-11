import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChatPanel } from './ChatPanel'
import type { SourceChatMessage } from '@/lib/types/api'

// 这两个 mock 在模块级闭包里固定对象/函数身份，使组件的 useCallback 依赖不会在
// 每次 render 时失效（真实实现中的 openModal/t 同样是稳定引用）。
vi.mock('@/lib/hooks/use-modal-manager', () => {
  const openModal = vi.fn()
  return { useModalManager: () => ({ openModal }) }
})

vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t, language: 'en-US', setLanguage: vi.fn() }) }
})

// Keep the message-content deps light for this composer-focused test.
vi.mock('@/components/sources/MessageActions', () => ({
  MessageActions: () => null,
}))

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom does not implement scrollIntoView (used by the auto-scroll effect).
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  const getTextarea = () => screen.getByRole('textbox') as HTMLTextAreaElement

  it('sends the typed message and clears the input on send-button click', () => {
    const onSendMessage = vi.fn()
    render(
      <ChatPanel
        messages={[]}
        isStreaming={false}
        contextIndicators={null}
        onSendMessage={onSendMessage}
      />
    )

    const textarea = getTextarea()
    fireEvent.change(textarea, { target: { value: '  hello world  ' } })

    const sendButton = screen.getByRole('button')
    fireEvent.click(sendButton)

    expect(onSendMessage).toHaveBeenCalledTimes(1)
    expect(onSendMessage).toHaveBeenCalledWith('hello world', undefined)
    expect(textarea.value).toBe('')
  })

  it('sends on Cmd+Enter on macOS', () => {
    const uaSpy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    )
    const onSendMessage = vi.fn()
    render(
      <ChatPanel
        messages={[]}
        isStreaming={false}
        contextIndicators={null}
        onSendMessage={onSendMessage}
      />
    )

    const textarea = getTextarea()
    fireEvent.change(textarea, { target: { value: 'via cmd' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true, ctrlKey: false })

    expect(onSendMessage).toHaveBeenCalledWith('via cmd', undefined)
    expect(textarea.value).toBe('')
    uaSpy.mockRestore()
  })

  it('sends on Ctrl+Enter on non-macOS', () => {
    const uaSpy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const onSendMessage = vi.fn()
    render(
      <ChatPanel
        messages={[]}
        isStreaming={false}
        contextIndicators={null}
        onSendMessage={onSendMessage}
      />
    )

    const textarea = getTextarea()
    fireEvent.change(textarea, { target: { value: 'via ctrl' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, metaKey: false })

    expect(onSendMessage).toHaveBeenCalledWith('via ctrl', undefined)
    expect(textarea.value).toBe('')
    uaSpy.mockRestore()
  })

  it('does not send while streaming', () => {
    const onSendMessage = vi.fn()
    render(
      <ChatPanel
        messages={[]}
        isStreaming={true}
        contextIndicators={null}
        onSendMessage={onSendMessage}
      />
    )

    const textarea = getTextarea()
    // Textarea is disabled while streaming, but the guard must also hold.
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    expect(onSendMessage).not.toHaveBeenCalled()
  })

  // #1202：MarkdownRenderer 的 `a` 覆盖项必须由调用方保持引用稳定，否则父级
  // 重渲染（如流式结束、消息列表刷新）会卸载重建链接子树，链接上的选区被折叠。
  it('keeps the reference link override stable across re-renders of a message', () => {
    const messages: SourceChatMessage[] = [
      { id: 'm1', type: 'human', content: 'Where is it documented?' },
      { id: 'm2', type: 'ai', content: 'See [docs](https://example.com) for details.' },
    ]
    const { container, rerender } = render(
      <ChatPanel
        messages={messages}
        isStreaming={false}
        contextIndicators={null}
        onSendMessage={vi.fn()}
      />
    )
    const link = container.querySelector('a[href="https://example.com"]')
    expect(link).not.toBeNull()

    // 同样的 id/内容，但换成新的消息对象：模拟消息列表刷新导致的 ChatMessage
    // 重渲染（memo 因 message 引用变化而放行）。
    rerender(
      <ChatPanel
        messages={messages.map((message) => ({ ...message }))}
        isStreaming={false}
        contextIndicators={null}
        onSendMessage={vi.fn()}
      />
    )

    expect(container.querySelector('a[href="https://example.com"]')).toBe(link)
  })
})
