import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CitationCard } from './CitationCard'
import type { ResearchCitation, ResearchChunk, ResearchSource } from '@/lib/types/research'

// UI-02 Red：Citation 卡片（REQ-DATA-03/04，设计 §5.3）——page_idx+1
// 仅展示；失效（source 缺失/版本不一致/页缺失）禁用跳转但保留原文；
// 跳转动作回调父级打开来源内容。

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.page ?? opts.reason ?? '')}` : key,
  }),
}))

const citation = (overrides: Partial<ResearchCitation> = {}): ResearchCitation => ({
  citation_id: 'c_1',
  claim: '实验结论：A 与 B 相关',
  chunk_id: 'chunk_1',
  doc_id: 'doc_1',
  doc_version: 'v3',
  page_idx: 3,
  section: null,
  original_text: '原文保留的句子',
  citation_type: null,
  confidence: null,
  doc_display_name: 'Paper A',
  short_name: 'A',
  doc_type: 'pdf',
  project_id: 'p1',
  vlm_bboxes: null,
  minio_uri: null,
  source_path: null,
  ...overrides,
})

const readySource = (overrides: Partial<ResearchSource> = {}): ResearchSource => ({
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: 'h',
  synced_at: null,
  last_error: null,
  ...overrides,
})

const chunks = (): ResearchChunk[] => [
  { chunk_id: 'chunk_3', page_idx: 3, markdown: 'page 4 content' },
]

describe('CitationCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('展示 claim、原文与 page_idx+1 页码（第 4 页，非第 3 页）', () => {
    render(
      <CitationCard
        citation={citation()}
        source={readySource()}
        chunks={chunks()}
      />,
    )
    expect(screen.getByText('实验结论：A 与 B 相关')).toBeInTheDocument()
    expect(screen.getByText('原文保留的句子')).toBeInTheDocument()
    expect(screen.getByText(/research.citation.page:4/)).toBeInTheDocument()
    expect(screen.queryByText(/research.citation.page:3/)).toBeNull()
  })

  it('可跳转时显示跳转按钮，点击回调 onJump（携带 citation）', () => {
    const onJump = vi.fn()
    render(
      <CitationCard
        citation={citation()}
        source={readySource()}
        chunks={chunks()}
        onJump={onJump}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /research.citation.jump/ }))
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onJump.mock.calls[0][0].citation_id).toBe('c_1')
  })

  it('source 缺失（文件失效）→ 跳转禁用、提示降级原因、原文保留', () => {
    render(<CitationCard citation={citation()} source={null} chunks={[]} />)
    const jumpButton = screen.queryByRole('button', { name: /research.citation.jump/ })
    expect(jumpButton).toBeNull()
    expect(screen.getByText(/research.citation.degradedSource:source_unavailable/)).toBeInTheDocument()
    expect(screen.getByText('原文保留的句子')).toBeInTheDocument()
  })

  it('版本不一致（旧文件失效）→ 禁用跳转、保留原文', () => {
    render(
      <CitationCard
        citation={citation({ doc_version: 'v2' })}
        source={readySource({ document_version: 'v3' })}
        chunks={chunks()}
      />,
    )
    expect(screen.queryByRole('button', { name: /research.citation.jump/ })).toBeNull()
    expect(screen.getByText(/research.citation.degradedVersion:version_mismatch/)).toBeInTheDocument()
    expect(screen.getByText('原文保留的句子')).toBeInTheDocument()
  })

  it('无页码 citation → 无页码标签、无跳转入口（原文照常展示）', () => {
    render(
      <CitationCard
        citation={citation({ page_idx: null })}
        source={readySource()}
        chunks={chunks()}
      />,
    )
    expect(screen.queryByText(/research.citation.page/)).toBeNull()
    expect(screen.queryByRole('button', { name: /research.citation.jump/ })).toBeNull()
    expect(screen.getByText('原文保留的句子')).toBeInTheDocument()
  })

  it('目标页在内容中缺失 → 禁用跳转', () => {
    render(
      <CitationCard
        citation={citation({ page_idx: 9 })}
        source={readySource()}
        chunks={chunks()}
      />,
    )
    expect(screen.queryByRole('button', { name: /research.citation.jump/ })).toBeNull()
    expect(screen.getByText(/research.citation.degradedPage:page_missing/)).toBeInTheDocument()
  })
})
