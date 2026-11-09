/**
 * NoteConflictDialog 组件测试（Issue #1046 PR4，方案 §4.1）。
 *
 * 冲突只提供：复制本地内容 / 受保护另存（copies）/ 加载最新版（先确认放弃）。
 * 禁止自动合并与强制覆盖——组件不得出现这类入口。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteConflictDialog } from './NoteConflictDialog'
import type { NoteEditorConflict } from '@/lib/research/issue585/types'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

const conflict: NoteEditorConflict = { currentRevision: 7, currentSnapshotHash: 'hash-7' }

function renderDialog(overrides: Partial<React.ComponentProps<typeof NoteConflictDialog>> = {}) {
  const props: React.ComponentProps<typeof NoteConflictDialog> = {
    open: true,
    conflict,
    localContent: '# local draft',
    onCopyLocal: vi.fn(),
    onSaveAsCopy: vi.fn(),
    onLoadLatest: vi.fn(),
    onKeepEditing: vi.fn(),
    ...overrides,
  }
  const utils = render(<NoteConflictDialog {...props} />)
  return { ...utils, props }
}

describe('NoteConflictDialog', () => {
  it('展示冲突说明、当前服务端版本与本地文本', () => {
    renderDialog()
    expect(screen.getByTestId('note-conflict-dialog')).toBeInTheDocument()
    expect(screen.getByText('research.notes.conflict.title')).toBeInTheDocument()
    expect(screen.getByTestId('note-conflict-current-revision')).toHaveTextContent('7')
    expect(screen.getByTestId('note-conflict-local-content')).toHaveTextContent('# local draft')
  })

  it('提供三条解决路径，且没有自动合并/强制覆盖入口', () => {
    renderDialog()
    expect(screen.getByTestId('note-conflict-copy-local')).toHaveTextContent(
      'research.notes.conflict.copyLocal',
    )
    expect(screen.getByTestId('note-conflict-save-as-copy')).toHaveTextContent(
      'research.notes.conflict.saveAsCopy',
    )
    expect(screen.getByTestId('note-conflict-load-latest')).toHaveTextContent(
      'research.notes.conflict.loadLatest',
    )
    expect(screen.queryByRole('button', { name: /merge|合并/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /overwrite|覆盖/i })).toBeNull()
  })

  it('复制本地内容与受保护另存分别触发回调', () => {
    const onCopyLocal = vi.fn()
    const onSaveAsCopy = vi.fn()
    renderDialog({ onCopyLocal, onSaveAsCopy })
    fireEvent.click(screen.getByTestId('note-conflict-copy-local'))
    fireEvent.click(screen.getByTestId('note-conflict-save-as-copy'))
    expect(onCopyLocal).toHaveBeenCalledTimes(1)
    expect(onSaveAsCopy).toHaveBeenCalledTimes(1)
  })

  it('加载最新版必须先确认放弃（二次确认后才回调）', () => {
    const onLoadLatest = vi.fn()
    renderDialog({ onLoadLatest })
    fireEvent.click(screen.getByTestId('note-conflict-load-latest'))
    expect(onLoadLatest).not.toHaveBeenCalled()
    const confirmPanel = screen.getByTestId('note-conflict-load-latest-confirm')
    expect(confirmPanel).toHaveTextContent('research.notes.conflict.loadLatestConfirmTitle')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'research.notes.conflict.loadLatestConfirmAction',
      }),
    )
    expect(onLoadLatest).toHaveBeenCalledTimes(1)
  })

  it('继续编辑关闭弹窗但不丢弃本地文本', () => {
    const onKeepEditing = vi.fn()
    renderDialog({ onKeepEditing })
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.conflict.keepEditing' }),
    )
    expect(onKeepEditing).toHaveBeenCalledTimes(1)
  })

  it('另存失败时显示明确失败提示，不假装成功', () => {
    renderDialog({ saveAsCopyError: 'failed' })
    expect(screen.getByTestId('note-conflict-save-as-copy-failed')).toHaveTextContent(
      'research.notes.conflict.saveAsCopyFailed',
    )
  })

  it('复制失败时提示手动复制', () => {
    renderDialog({ copyState: 'failed' })
    expect(screen.getByTestId('note-conflict-copy-failed')).toHaveTextContent(
      'research.notes.conflict.copyFailed',
    )
  })

  it('空本地正文时禁用另存（避免创建空副本）', () => {
    renderDialog({ localContent: '   ' })
    expect(screen.getByTestId('note-conflict-save-as-copy')).toBeDisabled()
  })

  it('open=false 时不渲染', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('note-conflict-dialog')).toBeNull()
  })
})
