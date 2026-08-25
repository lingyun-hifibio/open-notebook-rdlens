import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ResearchWorkspace } from './ResearchWorkspace'
import * as api from '@/lib/research/api'
import * as tokenStore from '@/lib/embedded/token-store'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'

// UI-03 Red：工作区组合（REQ-SCOPE-04）——无项目上下文 fail-closed 错误态；
// 有上下文时加载 Source/Note 并渲染四个面板 Tab。

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>()
  return {
    ...actual,
    listSources: vi.fn(),
    listNotes: vi.fn(),
    getJob: vi.fn(),
    createCompare: vi.fn(),
    cancelJob: vi.fn(),
    openResearchChatStream: vi.fn(() => () => {}),
  }
})

function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function researchToken(): string {
  const payload = JSON.stringify({ sub: 'u1', project_id: 'proj_1', aud: 'research-workspace' })
  return `h.${b64url(payload)}.s`
}

const source: ResearchSource = {
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: null,
  synced_at: '2026-08-06T02:00:00Z',
  last_error: null,
}

const note: ResearchNote = {
  note_id: 'note_1',
  project_id: 'proj_1',
  title: 'Note One',
  content: 'body',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
}

describe('ResearchWorkspace', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(api.listSources).mockResolvedValue({ items: [source], next_cursor: null })
    vi.mocked(api.listNotes).mockResolvedValue({ items: [note], next_cursor: null })
  })

  afterEach(() => {
    cleanup()
    tokenStore.clearResearchToken()
  })

  it('无项目上下文（无 Token）显示错误态而非面板', async () => {
    tokenStore.clearResearchToken()
    render(<ResearchWorkspace />)
    expect(await screen.findByText('research.noProjectContext')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /chat/i })).toBeNull()
  })

  it('有 Token 时默认收起选择器，展开后显示 Source/Note 与四个 Tab', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    render(<ResearchWorkspace />)
    expect(await screen.findByTestId('research-context-scope')).toHaveTextContent('research.layout.projectScope')
    expect(screen.getByText('Note One').closest('#research-context-selection')).toHaveAttribute('hidden')
    const contextButton = screen.getByRole('button', { name: 'research.layout.expandContext' })
    expect(contextButton).toHaveClass('border', 'bg-background', 'shadow-sm')
    fireEvent.click(contextButton)
    expect(await screen.findByText('Note One')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual([
      'research.tabSearch',
      'research.tabChat',
      'research.tabCompare',
      'research.tabJobs',
    ])
    expect(api.listSources).toHaveBeenCalledWith('proj_1')
    expect(api.listNotes).toHaveBeenCalledWith('proj_1')
  })

  it('Source/Note 长列表在各自最多 200px 的区域内纵向滚动', async () => {
    const sources = Array.from({ length: 12 }, (_, index): ResearchSource => ({
      ...source,
      source_id: `src_${index + 1}`,
      document_id: `doc_${index + 1}`,
    }))
    const notes = Array.from({ length: 12 }, (_, index): ResearchNote => ({
      ...note,
      note_id: `note_${index + 1}`,
      title: `Note ${index + 1}`,
    }))
    vi.mocked(api.listSources).mockResolvedValue({ items: sources, next_cursor: null })
    vi.mocked(api.listNotes).mockResolvedValue({ items: notes, next_cursor: null })
    tokenStore.setResearchToken(researchToken(), 9999999999)

    render(<ResearchWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'research.layout.expandContext' }))

    const sourceList = screen.getByTestId('source-selection-list')
    const noteList = screen.getByTestId('note-selection-list')
    expect(sourceList).toHaveClass('max-h-[200px]', 'overflow-y-auto')
    expect(noteList).toHaveClass('max-h-[200px]', 'overflow-y-auto')
    expect(sourceList.contains(screen.getByTestId('source-src_12'))).toBe(true)
    expect(noteList.contains(screen.getByTestId('note-note_12'))).toBe(true)
  })

  it('加载失败显示错误与重试按钮', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    vi.mocked(api.listSources).mockRejectedValue(new Error('network down'))
    render(<ResearchWorkspace />)
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
