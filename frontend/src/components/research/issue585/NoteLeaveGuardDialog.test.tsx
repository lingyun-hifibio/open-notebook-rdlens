/**
 * NoteLeaveGuardDialog 组件测试（Issue #1046 PR4，方案 §4.4）。
 *
 * 未完成保存/未知结果/冲突/失败/受限/IME 未结束时阻止静默离开，并提供
 * 重试保存 / 复制本地文本 / 下载本地 Markdown / 确认放弃（二次确认）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteLeaveGuardDialog } from './NoteLeaveGuardDialog'
import type { NoteLeaveBlockReason } from '@/lib/research/issue585/types'

function renderDialog(overrides: Partial<React.ComponentProps<typeof NoteLeaveGuardDialog>> = {}) {
  const props: React.ComponentProps<typeof NoteLeaveGuardDialog> = {
    open: true,
    reason: 'unsaved',
    onRetrySave: vi.fn(),
    onCopyLocal: vi.fn(),
    onDownloadLocalMarkdown: vi.fn(),
    onDiscardAndLeave: vi.fn(),
    onStay: vi.fn(),
    ...overrides,
  }
  const utils = render(<NoteLeaveGuardDialog {...props} />)
  return { ...utils, props }
}

describe('NoteLeaveGuardDialog', () => {
  it.each<NoteLeaveBlockReason>([
    'unsaved',
    'saving',
    'unknown',
    'conflict',
    'failed',
    'restricted',
    'composing',
  ])('原因 %s 映射稳定文案', (reason) => {
    renderDialog({ reason })
    expect(screen.getByTestId('note-leave-guard-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('note-leave-reason')).toHaveTextContent(
      `research.notes.leave.${reason}`,
    )
  })

  it('重试保存 / 复制本地文本 / 下载本地 Markdown 分别触发回调', () => {
    const onRetrySave = vi.fn()
    const onCopyLocal = vi.fn()
    const onDownload = vi.fn()
    renderDialog({ onRetrySave, onCopyLocal, onDownloadLocalMarkdown: onDownload })
    fireEvent.click(screen.getByTestId('note-leave-retry'))
    fireEvent.click(screen.getByTestId('note-leave-copy'))
    fireEvent.click(screen.getByTestId('note-leave-download'))
    expect(onRetrySave).toHaveBeenCalledTimes(1)
    expect(onCopyLocal).toHaveBeenCalledTimes(1)
    expect(onDownload).toHaveBeenCalledTimes(1)
  })

  it('放弃需二次确认，确认后才回调 onDiscardAndLeave', () => {
    const onDiscardAndLeave = vi.fn()
    renderDialog({ onDiscardAndLeave })
    fireEvent.click(screen.getByTestId('note-leave-discard'))
    expect(onDiscardAndLeave).not.toHaveBeenCalled()
    expect(screen.getByTestId('note-leave-discard-confirm')).toHaveTextContent(
      'research.notes.leave.discardConfirm',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.leave.discardConfirmAction' }),
    )
    expect(onDiscardAndLeave).toHaveBeenCalledTimes(1)
  })

  it('二次确认时可取消（留在当前文档）', () => {
    const onDiscardAndLeave = vi.fn()
    renderDialog({ onDiscardAndLeave })
    fireEvent.click(screen.getByTestId('note-leave-discard'))
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.leave.stay' }))
    expect(onDiscardAndLeave).not.toHaveBeenCalled()
    expect(screen.getByTestId('note-leave-retry')).toBeInTheDocument()
  })

  it('“留下”关闭对话框且不导航', () => {
    const onStay = vi.fn()
    renderDialog({ onStay })
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.leave.stay' }))
    expect(onStay).toHaveBeenCalledTimes(1)
  })

  it('复制失败时提示手动复制，不假装成功', () => {
    renderDialog({ copyState: 'failed' })
    expect(screen.getByTestId('note-leave-copy-failed')).toHaveTextContent(
      'research.notes.conflict.copyFailed',
    )
  })

  it('open=false 时不渲染', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('note-leave-guard-dialog')).toBeNull()
  })
})
