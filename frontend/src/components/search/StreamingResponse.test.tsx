import { render } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StreamingResponse } from './StreamingResponse'

// 模块级闭包固定 openModal/t 的身份，避免 useCallback 依赖在每次 render 时失效
//（真实实现中的 openModal/t 同样是稳定引用）。
vi.mock('@/lib/hooks/use-modal-manager', () => {
  const openModal = vi.fn()
  return { useModalManager: () => ({ openModal }) }
})

vi.mock('@/lib/hooks/use-translation', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t, language: 'en-US', setLanguage: vi.fn() }) }
})

describe('StreamingResponse', () => {
  // #1202：最终答案里的 MarkdownRenderer `a` 覆盖项必须由调用方保持引用稳定，
  // 否则流式过程中的重渲染会卸载重建链接子树，链接上的选区被折叠。
  it('keeps the reference link override stable across re-renders', () => {
    const finalAnswer = 'See [docs](https://example.com) for details.'
    const { container, rerender } = render(
      <StreamingResponse
        isStreaming={false}
        strategy={null}
        answers={[]}
        finalAnswer={finalAnswer}
      />
    )
    const link = container.querySelector('a[href="https://example.com"]')
    expect(link).not.toBeNull()

    rerender(
      <StreamingResponse
        isStreaming={false}
        strategy={null}
        answers={[]}
        finalAnswer={finalAnswer}
      />
    )

    expect(container.querySelector('a[href="https://example.com"]')).toBe(link)
  })
})
