/**
 * NoteCatalog 组件测试（Issue #1046 PR4，方案 §4.1）。
 *
 * 单一目录数据源：d2-v1 行走新编辑器；edit_schema=null 的旧未保护行走旧
 * 表单（本组件不直接打开）；受限行只显示“内容受限”占位（不泄露标题/正文）；
 * 空白新建入口只在 capabilities.noteEditor.available 时可用。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NoteCatalog } from './NoteCatalog'
import type { NoteApiError, ResearchNoteD2 } from '@/lib/research/issue585/types'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

const d2Note = (overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 => ({
  note_id: 'note_d2',
  project_id: 'proj_1',
  title: '受保护笔记',
  content: '受保护正文',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
  revision: 3,
  snapshot_hash: 'hash-3',
  edit_schema: 'd2-v1',
  access_state: 'visible',
  ...overrides,
})

const legacyNote = (overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 =>
  d2Note({
    note_id: 'note_legacy',
    title: '旧笔记',
    content: '旧正文',
    revision: null,
    snapshot_hash: null,
    edit_schema: null,
    access_state: null,
    ...overrides,
  })

const restrictedNote = (overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 =>
  d2Note({
    note_id: 'note_restricted',
    title: null as unknown as string,
    content: null as unknown as string,
    revision: 9,
    snapshot_hash: 'hash-9',
    access_state: 'restricted',
    ...overrides,
  })

function renderCatalog(overrides: Partial<React.ComponentProps<typeof NoteCatalog>> = {}) {
  const props: React.ComponentProps<typeof NoteCatalog> = {
    items: [d2Note(), legacyNote()],
    isLoading: false,
    error: null,
    search: '',
    onSearchChange: vi.fn(),
    canCreate: true,
    onCreateBlank: vi.fn(),
    canEdit: true,
    onOpenNote: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  }
  const utils = render(<NoteCatalog {...props} />)
  return { ...utils, props }
}

describe('NoteCatalog', () => {
  it('渲染 d2-v1 与旧未保护行，并标注 revision / legacy', () => {
    renderCatalog()
    expect(screen.getByTestId('note-catalog-row-note_d2')).toHaveAttribute('data-edit-schema', 'd2-v1')
    expect(screen.getByTestId('note-revision-note_d2')).toHaveTextContent('3')
    expect(screen.getByTestId('note-catalog-row-note_legacy')).toHaveAttribute('data-edit-schema', 'legacy')
    expect(screen.getByTestId('note-legacy-note_legacy')).toHaveTextContent(
      'research.notes.catalog.legacyBadge',
    )
  })

  it('点击 d2-v1 行打开新编辑器；旧未保护行不触发新编辑器', () => {
    const onOpenNote = vi.fn()
    renderCatalog({ onOpenNote })
    fireEvent.click(screen.getByTestId('note-open-note_d2'))
    expect(onOpenNote).toHaveBeenCalledWith('note_d2')
    expect(screen.queryByTestId('note-open-note_legacy')).toBeNull()
  })

  it('受限行只显示占位，不渲染标题/正文，也不渲染摘入死入口', () => {
    renderCatalog({ items: [restrictedNote()], onExcerptNote: vi.fn() })
    const row = screen.getByTestId('note-catalog-row-note_restricted')
    expect(row).toHaveAttribute('data-restricted', 'true')
    expect(screen.getByTestId('note-catalog-restricted-note_restricted')).toHaveTextContent(
      'research.notes.catalog.restricted',
    )
    expect(row.textContent).not.toContain('受保护笔记')
    expect(row.textContent).not.toContain('受保护正文')
    expect(screen.queryByTestId('note-excerpt-note_restricted')).toBeNull()
  })

  it('空白新建入口在 canCreate=true 时可用并触发回调', () => {
    const onCreateBlank = vi.fn()
    renderCatalog({ canCreate: true, onCreateBlank })
    const button = screen.getByTestId('note-catalog-new')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onCreateBlank).toHaveBeenCalledTimes(1)
  })

  it('能力关闭（note_editor.available=false）时新建入口禁用并说明原因', () => {
    const onCreateBlank = vi.fn()
    renderCatalog({ canCreate: false, createBlockedReason: 'disabled_by_flag', onCreateBlank })
    expect(screen.getByTestId('note-catalog-new')).toBeDisabled()
    expect(screen.getByTestId('note-catalog-new-blocked')).toHaveTextContent(
      'research.notes.catalog.createUnavailable',
    )
    fireEvent.click(screen.getByTestId('note-catalog-new'))
    expect(onCreateBlank).not.toHaveBeenCalled()
  })

  it('Admin 只读：无搜索框与新建入口，但目录可见', () => {
    renderCatalog({ canEdit: false })
    expect(screen.queryByTestId('note-catalog-new')).toBeNull()
    expect(screen.queryByPlaceholderText('research.notes.search')).toBeNull()
    expect(screen.getByText('受保护笔记')).toBeInTheDocument()
  })

  it('搜索输入回传调用方（debounce 由调用方负责）', () => {
    const onSearchChange = vi.fn()
    renderCatalog({ onSearchChange })
    fireEvent.change(screen.getByPlaceholderText('research.notes.search'), {
      target: { value: '蛋白' },
    })
    expect(onSearchChange).toHaveBeenCalledWith('蛋白')
  })

  it('加载中 / 空态 / 错误重试', () => {
    const onRefresh = vi.fn()
    const { rerender } = renderCatalog({ isLoading: true })
    expect(screen.getByTestId('note-catalog-loading')).toBeInTheDocument()

    rerender(
      <NoteCatalog
        items={[]}
        isLoading={false}
        error={null}
        search=""
        onSearchChange={vi.fn()}
        canCreate
        onCreateBlank={vi.fn()}
        canEdit
        onOpenNote={vi.fn()}
        onRefresh={onRefresh}
      />,
    )
    expect(screen.getByText('research.notes.empty')).toBeInTheDocument()

    const error: NoteApiError = {
      code: 'network_error',
      message: 'down',
      retryable: true,
      status: 0,
    }
    rerender(
      <NoteCatalog
        items={[]}
        isLoading={false}
        error={error}
        search=""
        onSearchChange={vi.fn()}
        canCreate
        onCreateBlank={vi.fn()}
        canEdit
        onOpenNote={vi.fn()}
        onRefresh={onRefresh}
      />,
    )
    expect(screen.getByText('research.workbench.loadFailed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.catalog.retry' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('超过一页时提供 load more 并展开后续行', () => {
    const items = Array.from({ length: 21 }, (_, index) =>
      d2Note({ note_id: `n${index + 1}`, title: `Note ${index + 1}` }),
    )
    renderCatalog({ items })
    expect(screen.getAllByRole('listitem')).toHaveLength(20)
    fireEvent.click(screen.getByRole('button', { name: 'research.pagination.loadMore' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(21)
  })

  it('revealId 行高亮（RWV2-23）', () => {
    renderCatalog({ items: [d2Note()], revealId: 'note_d2' })
    expect(screen.getByTestId('note-catalog-row-note_d2').className).toContain('ring-primary')
  })

  // Issue #1134：d2-v1 行删除入口（仅 d2-v1 非受限行，调用方判定 canDeleteNote）。
  it('d2-v1 行提供删除入口：点击回传该行（不触网、不误伤旧行）', () => {
    const onRequestDelete = vi.fn()
    renderCatalog({ items: [d2Note(), legacyNote()], onRequestDelete })

    const entry = screen.getByTestId('note-delete-note_d2')
    expect(entry).toHaveAttribute('aria-label', 'research.notes.deleteDialog.entry')
    expect(entry).toHaveAttribute('title', 'research.notes.deleteDialog.entry')
    fireEvent.click(entry)
    expect(onRequestDelete).toHaveBeenCalledWith(expect.objectContaining({ note_id: 'note_d2' }))
    // 旧未保护行不出现 d2-v1 删除入口（旧 Delete 由 legacyActions 提供）。
    expect(screen.queryByTestId('note-delete-note_legacy')).toBeNull()
  })

  it('canDeleteNote 返回 false（能力/权限/revision 不足）时不渲染删除入口', () => {
    renderCatalog({ items: [d2Note()], onRequestDelete: vi.fn(), canDeleteNote: () => false })
    expect(screen.queryByTestId('note-delete-note_d2')).toBeNull()
  })

  it('受限行与 Admin 只读不渲染删除入口', () => {
    renderCatalog({ items: [restrictedNote()], onRequestDelete: vi.fn() })
    expect(screen.queryByTestId('note-delete-note_restricted')).toBeNull()

    renderCatalog({ items: [d2Note()], onRequestDelete: vi.fn(), canEdit: false })
    expect(screen.queryByTestId('note-delete-note_d2')).toBeNull()
  })

  it('删除入口与摘入入口共存（同一行操作区，均为紧凑控件）', () => {
    renderCatalog({ items: [d2Note()], onRequestDelete: vi.fn(), onExcerptNote: vi.fn() })
    const entry = screen.getByTestId('note-delete-note_d2')
    const excerpt = screen.getByTestId('note-excerpt-note_d2')
    expect(entry).toBeInTheDocument()
    expect(excerpt).toBeInTheDocument()
    // 删除入口是图标按钮（size-7），不得使用会挤压标题列的文本按钮。
    expect(entry.className).toContain('size-7')
  })
})
