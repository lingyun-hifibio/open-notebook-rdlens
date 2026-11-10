/**
 * NoteRecoveryInbox 组件测试（Issue #1136：工作台父级导航「自动保存＋可恢复」）。
 *
 * 覆盖：空列表不渲染（避免噪声）、草稿标题/缓存时间/打开动作、空标题兜底、
 * 非法 savedAt 不伪造时间、多草稿逐条可恢复、复制/下载取回入口（HIGH-1）、
 * 已知 restricted 的笔记标题脱敏且不提供取回动作（MEDIUM-2）、非 assertive
 * live region（LOW-3）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { RecoverableNoteDraftSummary } from '@/lib/research/issue585/note-draft-cache'
import { NoteRecoveryInbox } from './NoteRecoveryInbox'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

function draft(overrides: Partial<RecoverableNoteDraftSummary> = {}): RecoverableNoteDraftSummary {
  return {
    noteId: 'note_1',
    title: '未保存的笔记',
    savedAt: '2026-11-10T04:00:00.000Z',
    ...overrides,
  }
}

describe('NoteRecoveryInbox', () => {
  it('没有可恢复草稿时不渲染（避免噪声）', () => {
    const { container } = render(<NoteRecoveryInbox drafts={[]} onOpen={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('列出草稿标题/缓存时间并可通过“打开笔记”恢复', () => {
    const onOpen = vi.fn()
    render(<NoteRecoveryInbox drafts={[draft()]} onOpen={onOpen} />)

    expect(screen.getByTestId('note-recovery-inbox')).toHaveTextContent(
      'research.notes.editor.saveStatus.pending',
    )
    expect(screen.getByTestId('note-recovery-inbox')).toHaveTextContent(
      'research.notes.leave.unsaved',
    )
    expect(screen.getByTestId('note-recovery-title-note_1')).toHaveTextContent('未保存的笔记')
    expect(screen.getByTestId('note-recovery-saved-at-note_1')).toHaveTextContent(
      'research.notes.editor.recovery.savedAt',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'research.notes.catalog.openNote' }),
    )
    expect(onOpen).toHaveBeenCalledWith('note_1')
  })

  it('非阻塞恢复入口使用 status 而非 assertive alert（LOW-3）', () => {
    render(<NoteRecoveryInbox drafts={[draft()]} onOpen={vi.fn()} />)
    const container = screen.getByTestId('note-recovery-inbox')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })

  it('打开前即可复制/下载本地草稿（HIGH-1 取回入口）', () => {
    const onCopyLocal = vi.fn()
    const onDownloadLocal = vi.fn()
    render(
      <NoteRecoveryInbox
        drafts={[draft()]}
        onOpen={vi.fn()}
        onCopyLocal={onCopyLocal}
        onDownloadLocal={onDownloadLocal}
      />,
    )
    fireEvent.click(screen.getByTestId('note-recovery-copy-note_1'))
    fireEvent.click(screen.getByTestId('note-recovery-download-note_1'))
    expect(onCopyLocal).toHaveBeenCalledWith('note_1')
    expect(onDownloadLocal).toHaveBeenCalledWith('note_1')
  })

  it('已知 restricted 的笔记标题脱敏且不提供取回动作（MEDIUM-2）', () => {
    render(
      <NoteRecoveryInbox
        drafts={[draft({ title: '机密标题' })]}
        restrictedNoteIds={new Set(['note_1'])}
        onOpen={vi.fn()}
        onCopyLocal={vi.fn()}
        onDownloadLocal={vi.fn()}
      />,
    )
    const title = screen.getByTestId('note-recovery-title-note_1')
    expect(title).toHaveTextContent('research.notes.catalog.restricted')
    expect(title).not.toHaveTextContent('机密标题')
    expect(screen.queryByTestId('note-recovery-copy-note_1')).toBeNull()
    expect(screen.queryByTestId('note-recovery-download-note_1')).toBeNull()
    expect(screen.queryByTestId('note-recovery-saved-at-note_1')).toBeNull()
    // 打开入口保留：点开走 PR4 403 路径并清理该笔记草稿。
    expect(screen.getByTestId('note-recovery-open-note_1')).toBeInTheDocument()
  })

  it('空标题使用未命名成果兜底（不渲染空行）', () => {
    render(<NoteRecoveryInbox drafts={[draft({ title: '   ' })]} onOpen={vi.fn()} />)
    expect(screen.getByTestId('note-recovery-title-note_1')).toHaveTextContent(
      'research.notes.editor.untitled',
    )
  })

  it('非法 savedAt 不伪造缓存时间', () => {
    render(<NoteRecoveryInbox drafts={[draft({ savedAt: 'not-a-date' })]} onOpen={vi.fn()} />)
    expect(screen.queryByTestId('note-recovery-saved-at-note_1')).toBeNull()
  })

  it('多条草稿逐条展示且各自可打开', () => {
    const onOpen = vi.fn()
    render(
      <NoteRecoveryInbox
        drafts={[draft(), draft({ noteId: 'note_2', title: '第二条' })]}
        onOpen={onOpen}
      />,
    )
    expect(screen.getByTestId('note-recovery-row-note_1')).toBeInTheDocument()
    expect(screen.getByTestId('note-recovery-row-note_2')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('note-recovery-open-note_2'))
    expect(onOpen).toHaveBeenCalledWith('note_2')
  })
})
