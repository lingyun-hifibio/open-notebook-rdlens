/**
 * NoteCapabilityBlocked 组件测试（Issue #1046 PR4，方案 §4.1/§8.2）。
 *
 * 能力关闭/故障/权限受限/删除必须显示明确阻断原因与取回入口，且绝不渲染
 * 可编辑标题/正文（不退回无 revision 旧表单）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteCapabilityBlocked } from './NoteCapabilityBlocked'

describe('NoteCapabilityBlocked', () => {
  it('能力关闭：显示稳定原因文案，并提示已有受保护笔记仍可编辑', () => {
    render(<NoteCapabilityBlocked reason="disabled_by_flag" canEditExisting />)
    const root = screen.getByTestId('note-capability-blocked')
    expect(root).toHaveAttribute('data-reason', 'disabled_by_flag')
    expect(screen.getByTestId('note-capability-reason')).toHaveTextContent(
      'research.notes.capability.reasons.disabled_by_flag',
    )
    expect(screen.getByTestId('note-capability-existing-hint')).toHaveTextContent(
      'research.notes.capability.existingEditableHint',
    )
  })

  it('能力故障：note_store_unavailable 显示阻断并可重试', () => {
    const onRetry = vi.fn()
    render(<NoteCapabilityBlocked reason="note_store_unavailable" onRetry={onRetry} />)
    expect(screen.getByTestId('note-capability-reason')).toHaveTextContent(
      'research.notes.editor.errors.note_store_unavailable',
    )
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.capability.retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['note_access_restricted', 'research.notes.editor.errors.note_access_restricted'],
    ['note_not_found', 'research.notes.editor.errors.note_not_found'],
    ['note_edit_schema_unsupported', 'research.notes.editor.errors.note_edit_schema_unsupported'],
    ['note_dependency_unavailable', 'research.notes.editor.errors.note_dependency_unavailable'],
  ])('权限/删除/格式/依赖阻断 %s 映射稳定文案', (reason, expectedKey) => {
    render(<NoteCapabilityBlocked reason={reason} />)
    expect(screen.getByTestId('note-capability-reason')).toHaveTextContent(expectedKey)
  })

  it('未知原因 fail-closed 到通用文案（不展示原始机器码正文）', () => {
    render(<NoteCapabilityBlocked reason="some_new_server_code" />)
    expect(screen.getByTestId('note-capability-reason')).toHaveTextContent(
      'research.notes.capability.unknown',
    )
    expect(screen.queryByText('some_new_server_code')).toBeNull()
  })

  it('删除后保留本地文本取回入口（复制/下载），不自动无来源新建', () => {
    const onCopyLocal = vi.fn()
    const onDownload = vi.fn()
    const onClose = vi.fn()
    render(
      <NoteCapabilityBlocked
        reason="note_not_found"
        onCopyLocal={onCopyLocal}
        onDownloadLocalMarkdown={onDownload}
        onClose={onClose}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.capability.copyLocal' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.capability.downloadMarkdown' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.capability.close' }))
    expect(onCopyLocal).toHaveBeenCalledTimes(1)
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /new note|新建/i })).toBeNull()
  })

  it('本地有未保存文本时关闭需二次确认，确认后才回调 onClose（不静默丢弃）', () => {
    const onClose = vi.fn()
    render(<NoteCapabilityBlocked reason="note_not_found" onClose={onClose} closeNeedsConfirm />)
    fireEvent.click(screen.getByTestId('note-capability-close'))
    expect(onClose).not.toHaveBeenCalled()
    const confirmPanel = screen.getByTestId('note-capability-close-confirm')
    expect(confirmPanel).toHaveTextContent('research.notes.leave.discardConfirm')
    fireEvent.click(screen.getByTestId('note-capability-close-confirm-action'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('二次确认可取消（留在阻断态，不丢弃本地文本）', () => {
    const onClose = vi.fn()
    render(<NoteCapabilityBlocked reason="note_not_found" onClose={onClose} closeNeedsConfirm />)
    fireEvent.click(screen.getByTestId('note-capability-close'))
    fireEvent.click(screen.getByTestId('note-capability-close-confirm-cancel'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('note-capability-close')).toBeInTheDocument()
    expect(screen.queryByTestId('note-capability-close-confirm')).toBeNull()
  })

  it('无未保存文本时关闭直接回调（阻断态不是死胡同）', () => {
    const onClose = vi.fn()
    render(<NoteCapabilityBlocked reason="note_access_restricted" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('note-capability-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('note-capability-close-confirm')).toBeNull()
  })

  it('阻断态不渲染任何可编辑标题/正文控件', () => {
    render(<NoteCapabilityBlocked reason="note_access_restricted" />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByLabelText('research.notes.titleLabel')).toBeNull()
    expect(screen.queryByLabelText('research.notes.contentLabel')).toBeNull()
  })
})
