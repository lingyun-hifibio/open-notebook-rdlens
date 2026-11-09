/**
 * NoteSaveStatus 组件测试（Issue #1046 PR4，方案 §4.1/§4.4）。
 *
 * 保存状态必须显式可辨（已保存/待保存/保存中/失败/结果待确认/冲突/受限/
 * 阻断），失败与未知结果给出重试/确认入口，缓存降级明确提示“本地恢复
 * 不可用”，绝不把未知结果显示成已保存。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteSaveStatus } from './NoteSaveStatus'
import type { NoteApiError, NoteSaveStatus as NoteSaveStatusValue } from '@/lib/research/issue585/types'

const error: NoteApiError = {
  code: 'network_error',
  message: 'network down',
  retryable: true,
  status: 0,
}

describe('NoteSaveStatus', () => {
  it.each<NoteSaveStatusValue>([
    'idle',
    'saved',
    'pending',
    'saving',
    'failed',
    'unknown',
    'conflict',
    'restricted',
    'blocked',
  ])('渲染 %s 状态文案（role=status 且 aria-live）', (status) => {
    render(<NoteSaveStatus saveStatus={status} />)
    const label = screen.getByTestId('note-save-status-label')
    expect(label).toHaveTextContent(`research.notes.editor.saveStatus.${status}`)
    expect(label).toHaveAttribute('role', 'status')
    expect(label).toHaveAttribute('aria-live', 'polite')
  })

  it('失败时显示映射后的错误文案并提供重试（不显示原始错误正文）', () => {
    const onRetry = vi.fn()
    render(<NoteSaveStatus saveStatus="failed" error={error} onRetry={onRetry} />)
    expect(screen.getByTestId('note-save-status-error')).toHaveTextContent(
      'research.notes.editor.errors.network_error',
    )
    expect(screen.queryByText('network down')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.editor.retrySave' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('结果待确认（unknown）提供确认原 mutation 入口', () => {
    const onConfirmPending = vi.fn()
    render(
      <NoteSaveStatus
        saveStatus="unknown"
        pendingMutationId="mut_1"
        onConfirmPending={onConfirmPending}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.editor.confirmPending' }),
    )
    expect(onConfirmPending).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('note-save-status-pending')).toBeInTheDocument()
  })

  it('冲突状态提供查看冲突入口（无强制覆盖入口）', () => {
    const onReviewConflict = vi.fn()
    render(<NoteSaveStatus saveStatus="conflict" onReviewConflict={onReviewConflict} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.conflict.reviewConflict' }),
    )
    expect(onReviewConflict).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /overwrite|force/i })).toBeNull()
  })

  it('缓存降级明确提示本地恢复不可用，且不改写保存状态', () => {
    render(<NoteSaveStatus saveStatus="saved" cacheStatus="memory_only" />)
    expect(screen.getByTestId('note-save-status-label')).toHaveTextContent(
      'research.notes.editor.saveStatus.saved',
    )
    const cache = screen.getByTestId('note-cache-status')
    expect(cache).toHaveTextContent('research.notes.editor.cache.memoryOnly')
    expect(cache).toHaveAttribute('data-cache-status', 'memory_only')
  })

  it('cacheStatus=ok 时不显示缓存提示', () => {
    render(<NoteSaveStatus saveStatus="saved" cacheStatus="ok" />)
    expect(screen.queryByTestId('note-cache-status')).toBeNull()
  })
})
