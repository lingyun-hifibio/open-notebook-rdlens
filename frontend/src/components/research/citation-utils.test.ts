import { describe, expect, it } from 'vitest'
import {
  displayPage,
  findChunkForPage,
  canJumpToCitation,
  resolveCitationSource,
  type JumpEvaluation,
} from './citation-utils'
import type { ResearchCitation, ResearchChunk, ResearchSource } from '@/lib/types/research'

// UI-02 Red：Citation 展示与失效降级纯函数（REQ-DATA-03/04，设计 §5.3）——
// page_idx 0-based 仅展示 +1；旧文件失效保留原文并禁用跳转。

const citation = (overrides: Partial<ResearchCitation> = {}): ResearchCitation => ({
  citation_id: 'c_1',
  claim: 'claim text',
  chunk_id: 'chunk_1',
  doc_id: 'doc_1',
  doc_version: 'v3',
  page_idx: 3,
  section: null,
  original_text: 'original text of the claim',
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

const chunk = (pageIdx: number, chunkId = `chunk_${pageIdx}`): ResearchChunk => ({
  chunk_id: chunkId,
  page_idx: pageIdx,
  markdown: `content of page ${pageIdx}`,
})

const source = (overrides: Partial<ResearchSource> = {}): ResearchSource => ({
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: 'h',
  synced_at: '2026-08-06T02:00:00Z',
  last_error: null,
  ...overrides,
})

describe('displayPage（page_idx+1 仅展示，REQ-DATA-03）', () => {
  it('page_idx 3 展示为 4（1-based）', () => {
    expect(displayPage(3)).toBe(4)
  })
  it('page_idx 0 展示为 1（不出现第 0 页）', () => {
    expect(displayPage(0)).toBe(1)
  })
  it('无页码（null）不展示', () => {
    expect(displayPage(null)).toBeNull()
  })
  it('负页码视为无效（后端不可能出现，防御性）', () => {
    expect(displayPage(-1)).toBeNull()
  })
})

describe('findChunkForPage', () => {
  it('按 0-based page_idx 找到首个匹配 chunk', () => {
    const chunks = [chunk(0), chunk(1), chunk(3)]
    expect(findChunkForPage(chunks, 3)?.chunk_id).toBe('chunk_3')
  })
  it('无匹配返回 undefined（不抛错）', () => {
    expect(findChunkForPage([chunk(0), chunk(1)], 5)).toBeUndefined()
  })
})

describe('canJumpToCitation（失效降级，REQ-DATA-04/设计 §5.3）', () => {
  it('source ready 且版本一致且页存在 → 可跳转', () => {
    const result: JumpEvaluation = canJumpToCitation(
      citation(),
      source(),
      [chunk(3)],
    )
    expect(result.canJump).toBe(true)
    expect(result.reason).toBeNull()
  })

  it('source 缺失（404/已删除）→ 禁用跳转，保留原文', () => {
    const result = canJumpToCitation(citation(), null, [])
    expect(result.canJump).toBe(false)
    expect(result.reason).toBe('source_unavailable')
  })

  it('source 非 ready（stale/failed/pending）→ 禁用跳转', () => {
    for (const status of ['stale', 'failed', 'pending'] as const) {
      const result = canJumpToCitation(citation(), source({ status }), [chunk(3)])
      expect(result.canJump).toBe(false)
      expect(result.reason).toBe('source_unavailable')
    }
  })

  it('版本不一致（旧文件可能已失效）→ 禁用跳转', () => {
    const result = canJumpToCitation(
      citation({ doc_version: 'v2' }),
      source({ document_version: 'v3' }),
      [chunk(3)],
    )
    expect(result.canJump).toBe(false)
    expect(result.reason).toBe('version_mismatch')
  })

  it('citation 无页码 → 无法定位跳转', () => {
    const result = canJumpToCitation(citation({ page_idx: null }), source(), [chunk(3)])
    expect(result.canJump).toBe(false)
    expect(result.reason).toBe('no_page')
  })

  it('目标页在内容中不存在 → 禁用跳转（不误跳）', () => {
    const result = canJumpToCitation(citation({ page_idx: 9 }), source(), [chunk(3)])
    expect(result.canJump).toBe(false)
    expect(result.reason).toBe('page_missing')
  })

  it('citation 无版本信息 → 视为当前版本可跳转', () => {
    const result = canJumpToCitation(citation({ doc_version: null }), source(), [chunk(3)])
    expect(result.canJump).toBe(true)
  })

  it('内容未加载（chunks=undefined）→ 不做页检查，可跳转（由详情面板兜底）', () => {
    const result = canJumpToCitation(citation(), source(), undefined)
    expect(result.canJump).toBe(true)
    expect(result.reason).toBeNull()
  })
})

describe('resolveCitationSource（按 document_id 解析来源）', () => {
  it('按 document_id 命中来源', () => {
    const sources = [source({ source_id: 'src_1', document_id: 'doc_1' })]
    expect(resolveCitationSource(sources, citation())?.source_id).toBe('src_1')
  })
  it('无匹配返回 undefined（跨项目/已删除来源不误解析）', () => {
    const sources = [source({ source_id: 'src_x', document_id: 'doc_x' })]
    expect(resolveCitationSource(sources, citation())).toBeUndefined()
    expect(resolveCitationSource(undefined, citation())).toBeUndefined()
  })
})
