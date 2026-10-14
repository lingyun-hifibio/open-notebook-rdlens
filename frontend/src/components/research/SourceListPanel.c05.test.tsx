/**
 * Issue #601 PR5（C3/D-25/D-33）：SourceListPanel 6 状态 / null source_id /
 * 版本常显 + citation 版本感知解析（T6/T32/T33/T42）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, vi as _vi } from 'vitest'
import { SourceListPanel } from './SourceListPanel'
import { resolveCitationSource, canJumpToCitation } from './citation-utils'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import type { ResearchSource } from '@/lib/types/research'
import type { ResearchCitation } from '@/lib/types/research'

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, listSources: vi.fn() }
})

function source(overrides: Partial<ResearchSource> = {}): ResearchSource {
  return {
    source_id: 'src_1',
    document_id: 'doc_1',
    document_version: 'v1',
    status: 'ready',
    content_hash: null,
    synced_at: null,
    last_error: null,
    ...overrides,
  }
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="u1">
        <ResearchScopeProvider userId="u1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})
afterEach(cleanup)

describe('SourceListPanel（C3）', () => {
  it('T6：6 状态全部渲染（retiring/deleted 有独立文案）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [
        source({ source_id: 's1', status: 'pending' }),
        source({ source_id: 's2', status: 'ready' }),
        source({ source_id: 's3', status: 'stale' }),
        source({ source_id: 's4', status: 'failed' }),
        source({ source_id: 's5', status: 'retiring' }),
        source({ source_id: 's6', status: 'deleted' }),
      ],
      next_cursor: null,
    })
    render(<SourceListPanel />, { wrapper: makeWrapper() })
    await screen.findByTestId('source-list-rows')
    for (const key of [
      'research.sources.statusPending', 'research.sources.statusReady',
      'research.sources.statusStale', 'research.sources.statusFailed',
      'research.sources.statusRetiring', 'research.sources.statusDeleted',
    ]) {
      expect(screen.getAllByText(key).length).toBeGreaterThan(0)
    }
  })

  it('T6：null source_id 行复选与打开按钮禁用并说明原因', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source({ source_id: null, status: 'ready' })],
      next_cursor: null,
    })
    const onOpen = vi.fn()
    render(<SourceListPanel onOpenSource={onOpen} />, { wrapper: makeWrapper() })
    await screen.findByTestId('source-list-rows')
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeDisabled()
    expect(screen.getByText('research.sources.noSourceIdentity')).toBeInTheDocument()
    const openBtn = screen.getByRole('button', { name: 'research.sources.open' })
    expect(openBtn).toBeDisabled()
    fireEvent.click(openBtn)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('T33：版本号常显（每行 source-row-version）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source(), source({ source_id: 's2', document_version: 'v2' })],
      next_cursor: null,
    })
    render(<SourceListPanel />, { wrapper: makeWrapper() })
    await screen.findByTestId('source-list-rows')
    const versions = screen.getAllByTestId('source-row-version')
    expect(versions).toHaveLength(2)
    expect(versions[0].textContent).toContain('v1')
    expect(versions[1].textContent).toContain('v2')
  })

  it('T6：retiring/deleted 不可选（复选禁用）', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({
      items: [source({ source_id: 's1', status: 'retiring' })],
      next_cursor: null,
    })
    render(<SourceListPanel />, { wrapper: makeWrapper() })
    await screen.findByTestId('source-list-rows')
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })
})

describe('resolveCitationSource（D-25/T42）', () => {
  const sources: ResearchSource[] = [
    source({ source_id: 's_v2', document_id: 'doc_a', document_version: 'v2' }),
    source({ source_id: 's_v1', document_id: 'doc_a', document_version: 'v1' }),
  ]

  it('精确 (doc_id, doc_version) 命中（v1 引用必须打开 v1 行）', () => {
    const citation = { doc_id: 'doc_a', doc_version: 'v1', page_idx: 0, claim: '', original_text: '', chunk_id: null } as unknown as ResearchCitation
    const hit = resolveCitationSource(sources, citation)
    expect(hit?.source_id).toBe('s_v1')
  })

  it('版本不匹配 → undefined（调用方禁用跳转，不静默打开 v2）', () => {
    const citation = { doc_id: 'doc_a', doc_version: 'v3', page_idx: 0, claim: '', original_text: '', chunk_id: null } as unknown as ResearchCitation
    expect(resolveCitationSource(sources, citation)).toBeUndefined()
  })

  it('引用无版本（历史快照）→ 首条 document_id 匹配（旧行为保留）', () => {
    const citation = { doc_id: 'doc_a', page_idx: 0, claim: '', original_text: '', chunk_id: null } as unknown as ResearchCitation
    expect(resolveCitationSource(sources, citation)?.source_id).toBe('s_v2')
  })

  it('canJumpToCitation 的 version_mismatch 语义保留', () => {
    const citation = { doc_id: 'doc_a', doc_version: 'v1', page_idx: 0, claim: '', original_text: '', chunk_id: null } as unknown as ResearchCitation
    const v2Row = sources[0]
    expect(canJumpToCitation(citation, v2Row, undefined).reason).toBe('version_mismatch')
  })
})
