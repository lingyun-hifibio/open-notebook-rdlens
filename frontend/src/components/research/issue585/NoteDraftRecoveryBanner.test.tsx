/**
 * NoteDraftRecoveryBanner 组件测试（Issue #1046 PR4，方案 §4.2/§4.4）。
 *
 * 恢复横幅必须明确“正文来自本地未保存草稿”；缓存降级（quota/SecurityError）
 * 必须明确“本地恢复不可用”，不得显示虚假已保存状态。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteDraftRecoveryBanner } from './NoteDraftRecoveryBanner'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

describe('NoteDraftRecoveryBanner', () => {
  it('恢复本地草稿时展示横幅与缓存时间，并可忽略', () => {
    const onDismiss = vi.fn()
    render(
      <NoteDraftRecoveryBanner
        restoredFromCache
        cacheStatus="ok"
        savedAt="2026-08-06T02:00:00Z"
        onDismiss={onDismiss}
      />,
    )
    expect(screen.getByTestId('note-draft-recovery-banner')).toBeInTheDocument()
    expect(screen.getByTestId('note-draft-restored')).toHaveTextContent(
      'research.notes.editor.recovery.title',
    )
    expect(screen.getByTestId('note-draft-cached-at')).toHaveTextContent(
      'research.notes.editor.recovery.savedAt',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.editor.recovery.dismiss' }),
    )
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('缓存降级为内存草稿时明确提示本地恢复不可用', () => {
    render(<NoteDraftRecoveryBanner restoredFromCache={false} cacheStatus="memory_only" />)
    const degraded = screen.getByTestId('note-cache-degraded')
    expect(degraded).toHaveTextContent('research.notes.editor.cache.memoryOnly')
    expect(degraded).toHaveAttribute('data-cache-status', 'memory_only')
  })

  it('缓存完全不可用时给出取回提示', () => {
    render(<NoteDraftRecoveryBanner restoredFromCache={false} cacheStatus="unavailable" />)
    expect(screen.getByTestId('note-cache-degraded')).toHaveTextContent(
      'research.notes.editor.cache.unavailable',
    )
  })

  it('未恢复且缓存正常时不渲染（避免噪声）', () => {
    const { container } = render(
      <NoteDraftRecoveryBanner restoredFromCache={false} cacheStatus="ok" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('非法 savedAt 不伪造缓存时间', () => {
    render(
      <NoteDraftRecoveryBanner
        restoredFromCache
        cacheStatus="ok"
        savedAt="not-a-date"
      />,
    )
    expect(screen.queryByTestId('note-draft-cached-at')).toBeNull()
  })
})
