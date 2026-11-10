/**
 * NoteEnableDialog 组件测试（Issue #1135）。
 *
 * 覆盖：confirming/pending/error 三态渲染、pending 状态提示与按钮禁用、
 * failureKind → 文案 key 映射、retryMode 决定重试显隐与标签（same_mutation →
 * confirmResult）、终态无重试、note 标题展示、关闭/确认/取消/重试回调。
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteEnableDialog } from './NoteEnableDialog'
import type { NoteEnableFailureKind } from '@/lib/research/issue585/note-enable'

type DialogProps = React.ComponentProps<typeof NoteEnableDialog>

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const props: DialogProps = {
    open: true,
    phase: 'confirming',
    noteTitle: '旧笔记',
    failureKind: null,
    retryMode: 'none',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  const utils = render(<NoteEnableDialog {...props} />)
  return { ...utils, props }
}

describe('NoteEnableDialog', () => {
  it('open=false 时不渲染', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('note-enable-dialog')).toBeNull()
  })

  it('confirming：显示标题/说明/note 标题，确认与取消可点', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })

    const dialog = screen.getByTestId('note-enable-dialog')
    expect(dialog).toHaveAttribute('data-phase', 'confirming')
    expect(screen.getByText('research.notes.enable.title')).toBeInTheDocument()
    expect(screen.getByText('research.notes.enable.description')).toBeInTheDocument()
    expect(screen.getByTestId('note-enable-note-title')).toHaveTextContent('旧笔记')
    expect(screen.queryByTestId('note-enable-status')).toBeNull()
    expect(screen.queryByTestId('note-enable-error')).toBeNull()

    fireEvent.click(screen.getByTestId('note-enable-confirm'))
    fireEvent.click(screen.getByTestId('note-enable-cancel'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('pending：显示单在途状态（role=status），确认/取消禁用，无关闭/重试', () => {
    const onConfirm = vi.fn()
    renderDialog({ phase: 'pending', onConfirm })

    expect(screen.getByTestId('note-enable-dialog')).toHaveAttribute('data-phase', 'pending')
    const status = screen.getByTestId('note-enable-status')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent('research.notes.enable.pending')
    expect(screen.getByTestId('note-enable-confirm')).toBeDisabled()
    expect(screen.getByTestId('note-enable-cancel')).toBeDisabled()
    expect(screen.queryByTestId('note-enable-close')).toBeNull()
    expect(screen.queryByTestId('note-enable-retry')).toBeNull()

    fireEvent.click(screen.getByTestId('note-enable-confirm'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it.each<NoteEnableFailureKind>([
    'restricted',
    'not_found',
    'unsupported',
    'conflict',
    'unavailable',
    'unknown',
  ])('失败分类 %s 映射稳定文案与 data-failure-kind', (failureKind) => {
    const expectedKey = {
      restricted: 'research.notes.enable.errors.restricted',
      not_found: 'research.notes.enable.errors.notFound',
      unsupported: 'research.notes.enable.errors.unsupported',
      conflict: 'research.notes.enable.errors.conflict',
      unavailable: 'research.notes.enable.errors.unavailable',
      unknown: 'research.notes.enable.errors.unknown',
    }[failureKind]

    renderDialog({ phase: 'error', failureKind, retryMode: 'none' })
    const error = screen.getByTestId('note-enable-error')
    expect(error).toHaveAttribute('data-failure-kind', failureKind)
    expect(error).toHaveTextContent(expectedKey)
    expect(screen.getByTestId('note-enable-dialog')).toHaveAttribute('data-phase', 'error')
  })

  it('终态失败（retryMode=none）不提供重试，只提供关闭', () => {
    const onClose = vi.fn()
    renderDialog({ phase: 'error', failureKind: 'restricted', retryMode: 'none', onClose })

    expect(screen.queryByTestId('note-enable-retry')).toBeNull()
    expect(screen.queryByTestId('note-enable-confirm')).toBeNull()
    fireEvent.click(screen.getByTestId('note-enable-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('same_mutation 重试用「确认结果」文案（结果未知/依赖不可判定）', () => {
    const onRetry = vi.fn()
    renderDialog({
      phase: 'error',
      failureKind: 'unknown',
      retryMode: 'same_mutation',
      onRetry,
    })

    const retry = screen.getByTestId('note-enable-retry')
    expect(retry).toHaveTextContent('research.notes.enable.confirmResult')
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('new_mutation 重试用目录通用「重试」文案（冲突类）', () => {
    renderDialog({ phase: 'error', failureKind: 'conflict', retryMode: 'new_mutation' })
    expect(screen.getByTestId('note-enable-retry')).toHaveTextContent(
      'research.notes.catalog.retry',
    )
  })

  it('失败分类缺失时兜底为 unknown 文案（不显示空白/原始错误）', () => {
    renderDialog({ phase: 'error', failureKind: null, retryMode: 'none' })
    const error = screen.getByTestId('note-enable-error')
    expect(error).toHaveAttribute('data-failure-kind', 'unknown')
    expect(error).toHaveTextContent('research.notes.enable.errors.unknown')
  })

  it('note 标题缺失时展示空串（不臆造标题）', () => {
    renderDialog({ noteTitle: '' })
    expect(screen.getByTestId('note-enable-note-title').textContent).toBe('')
  })
})
