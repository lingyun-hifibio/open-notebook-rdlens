/**
 * NoteDeleteDialog 组件测试（Issue #1134）。
 *
 * 覆盖：confirming/pending/error 三态渲染、二次确认文案与 revision 展示、
 * 未保存本地修改提示、pending 单在途提示与按钮禁用、failureKind → 文案 key
 * 映射、retryMode 决定重试显隐与标签（same_mutation → confirmResult；
 * reconfirm → refreshAndReview；new_mutation → Retry）、终态无重试、
 * 关闭/确认/取消/重试回调。
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteDeleteDialog } from './NoteDeleteDialog'
import type { NoteDeleteFailureKind, NoteDeleteRetryMode } from '@/lib/research/issue585/note-delete'

type DialogProps = React.ComponentProps<typeof NoteDeleteDialog>

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const props: DialogProps = {
    open: true,
    phase: 'confirming',
    noteTitle: '受保护笔记',
    expectedRevision: 3,
    failureKind: null,
    retryMode: 'none',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  const utils = render(<NoteDeleteDialog {...props} />)
  return { ...utils, props }
}

const FAILURE_KEYS: Record<NoteDeleteFailureKind, string> = {
  restricted: 'research.notes.deleteDialog.errors.restricted',
  not_found: 'research.notes.deleteDialog.errors.notFound',
  conflict: 'research.notes.deleteDialog.errors.conflict',
  unsupported: 'research.notes.deleteDialog.errors.unsupported',
  unavailable: 'research.notes.deleteDialog.errors.unavailable',
  unknown: 'research.notes.deleteDialog.errors.unknown',
}

describe('NoteDeleteDialog', () => {
  it('open=false 时不渲染', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('note-delete-dialog')).toBeNull()
  })

  it('confirming：二次确认文案、引用/历史影响说明与 revision，确认/取消可点', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderDialog({ onConfirm, onCancel })

    const dialog = screen.getByTestId('note-delete-dialog')
    expect(dialog).toHaveAttribute('data-phase', 'confirming')
    expect(screen.getByText('research.notes.deleteDialog.title')).toBeInTheDocument()
    expect(screen.getByText(/research\.notes\.deleteDialog\.description/)).toBeInTheDocument()
    expect(screen.getByTestId('note-delete-impact')).toHaveTextContent(
      'research.notes.deleteDialog.impact',
    )
    expect(screen.getByTestId('note-delete-revision')).toHaveTextContent(
      'research.notes.deleteDialog.revision',
    )
    expect(screen.queryByTestId('note-delete-unsaved')).toBeNull()
    expect(screen.queryByTestId('note-delete-status')).toBeNull()
    expect(screen.queryByTestId('note-delete-error')).toBeNull()

    fireEvent.click(screen.getByTestId('note-delete-confirm'))
    fireEvent.click(screen.getByTestId('note-delete-cancel'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('confirming + 未保存本地修改：显示丢弃提示；无修改时不显示', () => {
    renderDialog({ localChangesWarning: true })
    expect(screen.getByTestId('note-delete-unsaved')).toHaveTextContent(
      'research.notes.deleteDialog.unsavedLocal',
    )
  })

  it('pending：显示单在途状态（role=status），确认/取消禁用，无关闭/重试', () => {
    const onConfirm = vi.fn()
    renderDialog({ phase: 'pending', onConfirm })

    expect(screen.getByTestId('note-delete-dialog')).toHaveAttribute('data-phase', 'pending')
    const status = screen.getByTestId('note-delete-status')
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveTextContent('research.notes.deleteDialog.pending')
    expect(screen.getByTestId('note-delete-confirm')).toBeDisabled()
    expect(screen.getByTestId('note-delete-cancel')).toBeDisabled()
    expect(screen.queryByTestId('note-delete-close')).toBeNull()
    expect(screen.queryByTestId('note-delete-retry')).toBeNull()

    fireEvent.click(screen.getByTestId('note-delete-confirm'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it.each<NoteDeleteFailureKind>([
    'restricted',
    'not_found',
    'unsupported',
    'conflict',
    'unavailable',
    'unknown',
  ])('失败分类 %s 映射稳定文案与 data-failure-kind', (failureKind) => {
    renderDialog({ phase: 'error', failureKind })
    const error = screen.getByTestId('note-delete-error')
    expect(error).toHaveAttribute('data-failure-kind', failureKind)
    expect(error).toHaveTextContent(FAILURE_KEYS[failureKind])
  })

  it.each<[NoteDeleteRetryMode, string]>([
    ['same_mutation', 'research.notes.deleteDialog.confirmResult'],
    ['reconfirm', 'research.notes.deleteDialog.refreshAndReview'],
    ['new_mutation', 'research.notes.catalog.retry'],
  ])('retryMode=%s → 重试按钮文案 %s 且可点击', (retryMode, labelKey) => {
    const onRetry = vi.fn()
    renderDialog({ phase: 'error', failureKind: 'unknown', retryMode, onRetry })

    const retry = screen.getByTestId('note-delete-retry')
    expect(retry).toHaveTextContent(labelKey)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('终态错误（retryMode=none）不显示重试，仅关闭', () => {
    const onClose = vi.fn()
    renderDialog({ phase: 'error', failureKind: 'restricted', retryMode: 'none', onClose })

    expect(screen.queryByTestId('note-delete-retry')).toBeNull()
    fireEvent.click(screen.getByTestId('note-delete-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('confirming 阶段 Esc/遮罩关闭等同取消（不触发关闭错误回调）', () => {
    const onCancel = vi.fn()
    const onClose = vi.fn()
    renderDialog({ onCancel, onClose })

    fireEvent.keyDown(screen.getByTestId('note-delete-dialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('error 阶段关闭按钮触发 onClose（不是取消）', () => {
    const onCancel = vi.fn()
    const onClose = vi.fn()
    renderDialog({ phase: 'error', failureKind: 'not_found', retryMode: 'none', onCancel, onClose })

    fireEvent.click(screen.getByTestId('note-delete-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })
})
