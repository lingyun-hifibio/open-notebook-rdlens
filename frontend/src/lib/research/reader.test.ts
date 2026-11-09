/**
 * 阅读器纯函数测试（#1077 W2；计划 §2.4 正文按格式/§2.5 aside 摘录/§2.10）。
 *
 * 锁定：格式→正文模式、定位标签、可定位页正文块（排除 #1031 兜底 chunk）、
 * 规范化正文顺序、被引摘录匹配（chunk_id 优先、page_idx 首块、claim 回退）、
 * 下载文件名前端回退（#1080）与图表块诚实标记。
 */
import { describe, expect, it } from 'vitest'

import type { ResearchChunk } from '@/lib/types/research'
import {
  chunkHasFigureMarker,
  isFallbackPositionChunk,
  matchCitedExcerpt,
  readerBodyMode,
  readerDownloadFileName,
  readerLocatorKey,
  readerNormalizedChunks,
  readerPageChunks,
  readerSupportsPageImage,
} from '@/lib/research/reader'

function chunk(input: Partial<ResearchChunk> & { chunk_id: string }): ResearchChunk {
  return {
    page_idx: 0,
    markdown: `text ${input.chunk_id}`,
    chunk_ordinal: 0,
    content_hash: 'a'.repeat(64),
    ...input,
  }
}

describe('readerBodyMode（§2.4 正文按格式）', () => {
  it('pdf/ppt → 页图 + 同页正文块', () => {
    expect(readerBodyMode('pdf')).toBe('page-image')
    expect(readerBodyMode('ppt')).toBe('page-image')
  })

  it('xlsx/docx/csv/other → 规范化正文', () => {
    for (const sourceType of ['xlsx', 'docx', 'csv', 'other', 'PPTX ']) {
      expect(readerBodyMode(sourceType)).toBe('normalized-text')
    }
  })

  it('缺失/未知（旧 host）→ 规范化正文（不伪造页图）', () => {
    expect(readerBodyMode(null)).toBe('normalized-text')
    expect(readerBodyMode(undefined)).toBe('normalized-text')
    expect(readerBodyMode('')).toBe('normalized-text')
  })
})

describe('readerSupportsPageImage / readerLocatorKey（§2.4）', () => {
  it('只有 pdf/ppt 有页图能力', () => {
    expect(readerSupportsPageImage('pdf')).toBe(true)
    expect(readerSupportsPageImage('ppt')).toBe(true)
    for (const sourceType of ['xlsx', 'docx', 'csv', null]) {
      expect(readerSupportsPageImage(sourceType)).toBe(false)
    }
  })

  it('定位标签：page/slide/sheet；docx/csv/未知 → null（无可用定位）', () => {
    expect(readerLocatorKey('pdf')).toBe('research.target.reader.locatorPage')
    expect(readerLocatorKey('ppt')).toBe('research.target.reader.locatorSlide')
    expect(readerLocatorKey('xlsx')).toBe('research.target.reader.locatorSheet')
    expect(readerLocatorKey('docx')).toBeNull()
    expect(readerLocatorKey('csv')).toBeNull()
    expect(readerLocatorKey(null)).toBeNull()
  })
})

describe('isFallbackPositionChunk（#1031 无位置回退 chunk）', () => {
  it('PPT toc 兜底 chunk（chunk_id 以 _toc 结尾且 page_idx=0）→ true', () => {
    expect(isFallbackPositionChunk({ chunk_id: 'doc_x_toc', page_idx: 0 })).toBe(true)
  })

  it('真实第 1 页 chunk / 非 0 页 toc → false（不误伤真实页）', () => {
    expect(isFallbackPositionChunk({ chunk_id: 'doc_x_0001', page_idx: 0 })).toBe(false)
    expect(isFallbackPositionChunk({ chunk_id: 'doc_x_toc', page_idx: 3 })).toBe(false)
  })
})

describe('readerPageChunks（§2.4/§2.10-6：PDF/PPT 页模式不渲染兜底 chunk）', () => {
  const chunks = [
    chunk({ chunk_id: 'doc_toc', page_idx: 0, chunk_ordinal: 0 }),
    chunk({ chunk_id: 'p0a', page_idx: 0, chunk_ordinal: 1 }),
    chunk({ chunk_id: 'p0b', page_idx: 0, chunk_ordinal: 2 }),
    chunk({ chunk_id: 'p2a', page_idx: 2, chunk_ordinal: 3 }),
  ]

  it('返回同页 chunk 且排除兜底 chunk', () => {
    expect(readerPageChunks(chunks, 0).map((c) => c.chunk_id)).toEqual(['p0a', 'p0b'])
    expect(readerPageChunks(chunks, 2).map((c) => c.chunk_id)).toEqual(['p2a'])
  })

  it('页不存在 → 空数组（不跨页取正文）', () => {
    expect(readerPageChunks(chunks, 9)).toEqual([])
  })
})

describe('readerNormalizedChunks（XLSX/DOCX/CSV 全局正文）', () => {
  it('按输入顺序保留全部 chunk，并标记兜底 chunk（位置未知 #1031）', () => {
    const chunks = [
      chunk({ chunk_id: 'doc_toc', page_idx: 0 }),
      chunk({ chunk_id: 'a', page_idx: 0 }),
      chunk({ chunk_id: 'b', page_idx: 1 }),
    ]
    const result = readerNormalizedChunks(chunks)
    expect(result.map((entry) => entry.chunk.chunk_id)).toEqual(['doc_toc', 'a', 'b'])
    expect(result.map((entry) => entry.fallback)).toEqual([true, false, false])
  })
})

describe('matchCitedExcerpt（§2.5-1 / §2.10-9 aside 被引原文摘录）', () => {
  const chunks = [
    chunk({ chunk_id: 'chunk_9', page_idx: 3, chunk_ordinal: 1 }),
    chunk({ chunk_id: 'chunk_3', page_idx: 3, chunk_ordinal: 2 }),
    chunk({ chunk_id: 'chunk_7', page_idx: 4, chunk_ordinal: 3 }),
  ]

  it('chunk_id 命中优先于 page 匹配', () => {
    expect(
      matchCitedExcerpt({ chunks, chunkId: 'chunk_7', pageIdx: 3 }),
    ).toEqual({ chunk: chunks[2], fallback: false })
  })

  it('chunk_id 缺失（null/不存在）→ 该页首个非兜底 chunk', () => {
    expect(matchCitedExcerpt({ chunks, chunkId: null, pageIdx: 3 })).toEqual({
      chunk: chunks[0],
      fallback: false,
    })
    expect(matchCitedExcerpt({ chunks, chunkId: 'missing', pageIdx: 3 })).toEqual({
      chunk: chunks[0],
      fallback: false,
    })
  })

  it('无 chunk/page 命中 → chunk=null（调用方回退 claim，不冒称原文）', () => {
    expect(matchCitedExcerpt({ chunks, chunkId: null, pageIdx: 9 })).toEqual({
      chunk: null,
      fallback: false,
    })
  })

  it('page_idx=0 时兜底 chunk 不作同页原文依据（#1031）', () => {
    const pageZero = [
      chunk({ chunk_id: 'doc_toc', page_idx: 0, chunk_ordinal: 0 }),
      chunk({ chunk_id: 'real_page_0', page_idx: 0, chunk_ordinal: 1 }),
    ]
    expect(matchCitedExcerpt({ chunks: pageZero, chunkId: null, pageIdx: 0 })).toEqual({
      chunk: pageZero[1],
      fallback: false,
    })
    // 只有兜底 chunk 的 page 0：不得作为摘录依据，回退 claim 并标记兜底。
    expect(
      matchCitedExcerpt({ chunks: [pageZero[0]], chunkId: null, pageIdx: 0 }),
    ).toEqual({ chunk: null, fallback: true })
    // chunk_id 直接命中兜底 chunk：同样不作为原文摘录。
    expect(
      matchCitedExcerpt({ chunks: [pageZero[0]], chunkId: 'doc_toc', pageIdx: 0 }),
    ).toEqual({ chunk: null, fallback: true })
  })
})

describe('readerDownloadFileName（§2.4/#1080：前端回退口径）', () => {
  it('title + 声明格式扩展名', () => {
    expect(readerDownloadFileName('A paper', 'doc_1', 'pdf')).toBe('A paper.pdf')
    expect(readerDownloadFileName('Slides', 'doc_2', 'ppt')).toBe('Slides.pptx')
  })

  it('缺 title → document_id；未知格式 → 无扩展名', () => {
    expect(readerDownloadFileName(null, 'doc_3', 'csv')).toBe('doc_3.csv')
    expect(readerDownloadFileName('', 'doc_4', 'other')).toBe('doc_4')
    expect(readerDownloadFileName(undefined, 'doc_5', null)).toBe('doc_5')
  })

  it('扩展名去重/不干净字符按本地回退保守处理', () => {
    expect(readerDownloadFileName('paper.pdf', 'doc_6', 'pdf')).toBe('paper.pdf')
  })
})

describe('chunkHasFigureMarker（§2.4 图表块诚实提示）', () => {
  it('image_description 标记 → true；普通文本 → false', () => {
    expect(chunkHasFigureMarker('<!-- image_description -->图 1')).toBe(true)
    expect(chunkHasFigureMarker('普通正文')).toBe(false)
  })
})
