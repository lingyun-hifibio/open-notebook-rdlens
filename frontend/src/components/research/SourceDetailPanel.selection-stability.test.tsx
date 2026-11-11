import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SourceDetailPanel } from './SourceDetailPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'

/**
 * 选段入口稳定性（#1192 / W3-G12）：
 * 来源 chunk 的 Markdown 在父组件重渲染后必须保持 DOM 节点身份，否则浏览器会
 * 因选中文本节点被替换而折叠选区；随后 `selectionchange` 让选段浮层自行消失，
 * 用户看到「选段后没有任何入口」。本文件刻意使用**真实** MarkdownRenderer
 * （同目录 SourceDetailPanel.test.tsx 用 mock），覆盖根因链路。
 */

vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  listSources: vi.fn(),
  getSource: vi.fn(),
  listModels: vi.fn(),
  getSourcePageImage: vi.fn(),
  getSourceFile: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.page ?? '')}` : key,
  }),
}))

const sourceMocks = vi.hoisted(() => ({
  useRuntimeOptional: vi.fn(() => null as unknown),
  editor: {
    snapshot: { readerAnchor: null, positionUnavailable: false },
    controller: null,
    transportWired: false,
    setDraftText: vi.fn(),
    setScope: vi.fn(),
    setChatAnchor: vi.fn(),
    setReaderAnchor: vi.fn(),
    flush: vi.fn(),
    hold: vi.fn(),
    release: vi.fn(),
    retrySave: vi.fn(),
    adoptServerVersion: vi.fn(),
    saveLocalOverServer: vi.fn(),
    clearAfterSubmission: vi.fn(),
    markTokenConsumed: vi.fn(),
    canSubmit: () => ({ allowed: false, reason: 'not_loaded' as const }),
    restoreDraft: vi.fn(),
    refreshDraftCandidates: vi.fn(),
    releaseDocument: vi.fn(),
  },
}))

vi.mock('@/lib/hooks/research-session-runtime', () => ({
  useResearchSessionRuntimeOptional: sourceMocks.useRuntimeOptional,
}))
vi.mock('@/lib/hooks/use-research-editor', () => ({
  useResearchEditor: () => sourceMocks.editor,
}))

const PER_CHUNK_HASH = 'a'.repeat(64)
const D1E_CAPABILITY = {
  'd1e_roundtrip': { contract: 'd1e-roundtrip-v1', enabled: true },
}

const SOURCE = {
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: 'h',
  synced_at: null,
  last_error: null,
  title: 'Paper A',
  markdown_chunks: [
    {
      chunk_id: 'chunk_sel',
      chunk_ordinal: 3,
      content_hash: PER_CHUNK_HASH,
      page_idx: 2,
      markdown: 'alpha beta gamma delta epsilon',
    },
  ],
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner">
        <ResearchScopeProvider userId="u1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper }
}

function textNodeContaining(container: HTMLElement, needle: string): Text {
  const chunk = container.querySelector('[data-chunk-id="chunk_sel"]')
  if (chunk === null) throw new Error('chunk not rendered')
  const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    if ((node.textContent ?? '').includes(needle)) return node as Text
    node = walker.nextNode()
  }
  throw new Error(`no text node containing ${needle}`)
}

function selectBeta(container: HTMLElement): void {
  const node = textNodeContaining(container, 'beta')
  const text = node.textContent ?? ''
  const start = text.indexOf('beta')
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + 'beta'.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('SourceDetailPanel · 选段入口重渲染稳定性（#1192）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sourceMocks.useRuntimeOptional.mockReturnValue(null)
    vi.mocked(researchApi.getSource).mockResolvedValue(SOURCE as never)
    vi.mocked(researchApi.listModels).mockResolvedValue({
      models: [],
      capabilities: D1E_CAPABILITY,
    } as never)
  })

  it('父级重渲染后选区与「讨论选段」入口仍然可用（Markdown DOM 不被替换）', async () => {
    const { wrapper } = makeWrapper()
    const onDiscuss = vi.fn()
    const view = render(
      <SourceDetailPanel sourceId="src_1" onDiscussSelection={onDiscuss} />,
      { wrapper },
    )
    await screen.findByRole('heading', { name: 'Paper A' })
    await waitFor(() => expect(researchApi.listModels).toHaveBeenCalled())
    await waitFor(() => {
      selectBeta(view.container)
      act(() => {
        document.dispatchEvent(new MouseEvent('mouseup'))
      })
      expect(screen.queryByTestId('source-selection-discuss')).not.toBeNull()
    })

    // 模拟浏览器行为：重渲染若替换了选中的 DOM 节点，浏览器会折叠选区并触发
    // selectionchange/mouseup；处理器看到空选区后必须**不**丢弃已捕获的选段。
    view.rerender(
      <SourceDetailPanel sourceId="src_1" onDiscussSelection={onDiscuss} />,
    )
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(screen.queryByTestId('source-selection-discuss')).not.toBeNull()
    expect(window.getSelection()?.toString()).toBe('beta')
  })
})
