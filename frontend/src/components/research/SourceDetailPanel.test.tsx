import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SourceDetailPanel } from './SourceDetailPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import * as researchApi from '@/lib/research/api'

// UI-02 Red：来源内容面板（REQ-SRC-04/REQ-DATA-04，契约 §6）——规范
// Markdown chunks 按阅读顺序展示，页码标记展示 page_idx+1；404/内容不可用
// 时展示降级态（Citation 原文由卡片保留）。

vi.mock('@/lib/research/api', () => ({
  listSources: vi.fn(),
  getSource: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.page ?? '')}` : key,
  }),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner">
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('SourceDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染标题、状态与按阅读顺序排列的 markdown chunks（页码标记 page_idx+1）', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue({
      source_id: 'src_1',
      document_id: 'doc_1',
      document_version: 'v3',
      status: 'ready',
      content_hash: 'h',
      synced_at: null,
      last_error: null,
      title: 'Paper A',
      markdown_chunks: [
        { chunk_id: 'chunk_0', page_idx: 0, markdown: '第一章内容' },
        { chunk_id: 'chunk_3', page_idx: 3, markdown: '第四章内容' },
      ],
    })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('Paper A')).toBeInTheDocument()
      const marks = screen.getAllByTestId('markdown').map((node) => node.textContent)
      expect(marks.join('|')).toContain('第一章内容')
      expect(marks.join('|')).toContain('第四章内容')
      // 页码标记：page_idx 0 → 第 1 页；page_idx 3 → 第 4 页
      expect(screen.getByText(/research.sources.chunkPage:1/)).toBeInTheDocument()
      expect(screen.getByText(/research.sources.chunkPage:4/)).toBeInTheDocument()
    })
  })

  it('highlightPageIdx 命中 chunk 时标记高亮（Citation 跳转定位）', async () => {
    vi.mocked(researchApi.getSource).mockResolvedValue({
      source_id: 'src_1',
      document_id: 'doc_1',
      document_version: 'v3',
      status: 'ready',
      content_hash: 'h',
      synced_at: null,
      last_error: null,
      title: 'Paper A',
      markdown_chunks: [
        { chunk_id: 'chunk_3', page_idx: 3, markdown: '第四章内容' },
      ],
    })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_1" highlightPageIdx={3} />, { wrapper })
    await waitFor(() => {
      expect(screen.getByTestId('markdown')).toHaveTextContent('第四章内容')
    })
    const highlighted = screen.getByTestId('chunk-highlight')
    expect(highlighted).toBeInTheDocument()
  })

  it('内容不可用（404）→ 展示降级态，不崩溃', async () => {
    vi.mocked(researchApi.getSource).mockRejectedValue({ response: { status: 404 } })
    const { wrapper } = makeWrapper()
    render(<SourceDetailPanel sourceId="src_gone" />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('research.workbench.loadFailed')).toBeInTheDocument()
    })
  })
})
