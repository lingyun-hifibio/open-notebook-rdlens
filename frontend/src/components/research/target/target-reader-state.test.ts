/**
 * 目标壳宽屏阅读器（#1077 W2）纯逻辑测试：入口请求/版本护栏/页边界/页导航。
 *
 * 锚点：
 * - 合并计划 `dev_docs/plans/issue1077_widescreen_reader_plan_20261109.md`
 *   §2.3（入口与 page_idx）、§2.4（页边界推导/版本护栏）、§2.6（返回）、
 *   §2.9（版本不可核对/入口禁用）、§2.10-5/7/9；
 * - Round-4 B4-L3：版本不可核对分支**不得**把 citation.page_idx 并入
 *   可定位页集合/初始页。
 */
import { describe, expect, it } from 'vitest'

import type { ResearchChunk } from '@/lib/types/research'
import {
  citationReaderRequest,
  locateReaderPages,
  readerPageNeighbor,
  resolveReaderInitialPage,
  resolveReaderVersionState,
  sourceReaderRequest,
} from './target-reader-state'

function chunk(pageIdx: number, chunkId = `c_${pageIdx}`): ResearchChunk {
  return {
    chunk_id: chunkId,
    page_idx: pageIdx,
    markdown: `page ${pageIdx}`,
    chunk_ordinal: pageIdx,
    content_hash: 'a'.repeat(64),
  }
}

describe('citationReaderRequest / sourceReaderRequest', () => {
  it('citation 入口携带 citation、message id 与成对版本（doc_id+doc_version）', () => {
    const request = citationReaderRequest({
      citation: {
        citation_id: 'c1',
        claim: 'claim',
        doc_id: 'doc_1',
        doc_version: 'v3',
        page_idx: 4,
        chunk_id: 'chunk_9',
      },
      sourceId: 'src_1',
      messageId: 'msg_1',
    })
    expect(request.origin).toBe('citation')
    expect(request.sourceId).toBe('src_1')
    expect(request.messageId).toBe('msg_1')
    expect(request.documentRef).toEqual({ documentId: 'doc_1', documentVersion: 'v3' })
    expect(request.initialPageIdx).toBe(4)
    expect(request.citation?.chunk_id).toBe('chunk_9')
  })

  it('citation 缺 doc_version → documentRef=null（版本不可核对，仍可打开）', () => {
    for (const docVersion of [null, undefined, '']) {
      const request = citationReaderRequest({
        citation: {
          citation_id: 'c1',
          claim: 'claim',
          doc_id: 'doc_1',
          doc_version: docVersion,
          page_idx: 2,
        },
        sourceId: 'src_1',
        messageId: null,
      })
      expect(request.documentRef).toBeNull()
      expect(request.initialPageIdx).toBe(2)
      expect(request.messageId).toBeNull()
    }
  })

  it('citation page_idx 非法（负数/非整数）→ initialPageIdx=null', () => {
    for (const pageIdx of [-1, 1.5, null]) {
      const request = citationReaderRequest({
        citation: {
          citation_id: 'c1',
          claim: 'claim',
          doc_id: 'doc_1',
          doc_version: 'v1',
          page_idx: pageIdx,
        },
        sourceId: 'src_1',
        messageId: null,
      })
      expect(request.initialPageIdx).toBeNull()
    }
  })

  it('资料预览入口按最新版读取：无 citation/messageId/版本，initial_page_idx 合法才保留', () => {
    const request = sourceReaderRequest({ sourceId: 'src_1', initialPageIdx: 3 })
    expect(request.origin).toBe('source')
    expect(request.citation).toBeNull()
    expect(request.messageId).toBeNull()
    expect(request.documentRef).toBeNull()
    expect(request.initialPageIdx).toBe(3)
    expect(sourceReaderRequest({ sourceId: 'src_1', initialPageIdx: -2 }).initialPageIdx).toBeNull()
  })
})

describe('resolveReaderVersionState（§2.4 版本护栏）', () => {
  const detail = { document_id: 'doc_1', document_version: 'v3' }

  it('source 入口 = latest（无被引版本可核对）', () => {
    const request = sourceReaderRequest({ sourceId: 'src_1', initialPageIdx: null })
    expect(resolveReaderVersionState(request, detail)).toEqual({ kind: 'latest' })
  })

  it('citation 版本与 source detail 一致 → match', () => {
    const request = citationReaderRequest({
      citation: { citation_id: 'c1', claim: 'x', doc_id: 'doc_1', doc_version: 'v3', page_idx: 1 },
      sourceId: 'src_1',
      messageId: null,
    })
    expect(resolveReaderVersionState(request, detail)).toEqual({ kind: 'match' })
  })

  it('citation 版本与 source detail 不一致 → mismatch（不回退最新版）', () => {
    const request = citationReaderRequest({
      citation: { citation_id: 'c1', claim: 'x', doc_id: 'doc_1', doc_version: 'v2', page_idx: 1 },
      sourceId: 'src_1',
      messageId: null,
    })
    expect(resolveReaderVersionState(request, detail)).toEqual({ kind: 'mismatch' })
    const otherDoc = citationReaderRequest({
      citation: { citation_id: 'c1', claim: 'x', doc_id: 'doc_2', doc_version: 'v3', page_idx: 1 },
      sourceId: 'src_1',
      messageId: null,
    })
    expect(resolveReaderVersionState(otherDoc, detail)).toEqual({ kind: 'mismatch' })
  })

  it('citation 缺成对版本 → unverifiable（即使 detail 存在）', () => {
    const request = citationReaderRequest({
      citation: { citation_id: 'c1', claim: 'x', doc_id: 'doc_1', doc_version: null, page_idx: 1 },
      sourceId: 'src_1',
      messageId: null,
    })
    expect(resolveReaderVersionState(request, detail)).toEqual({ kind: 'unverifiable' })
  })

  it('detail 未加载（null）时 citation 入口保持 unverifiable/mismatch 不可判定前的安全值', () => {
    const request = citationReaderRequest({
      citation: { citation_id: 'c1', claim: 'x', doc_id: 'doc_1', doc_version: 'v3', page_idx: 1 },
      sourceId: 'src_1',
      messageId: null,
    })
    // detail 未到：不能宣称 match（不提前放行被引内容匹配）。
    expect(resolveReaderVersionState(request, null)).toEqual({ kind: 'unverifiable' })
  })
})

describe('locateReaderPages（§2.4 页边界推导）', () => {
  const chunks = [chunk(2), chunk(0), chunk(5), chunk(2, 'c_2b')]

  it('可定位页集合 = markdown_chunks 页 ∪ 引用页（升序去重）', () => {
    expect(
      locateReaderPages({
        chunks,
        citationPageIdx: 3,
        versionState: { kind: 'match' },
      }),
    ).toEqual([0, 2, 3, 5])
  })

  it('版本不可核对：citation.page_idx 不并入集合（B4-L3）', () => {
    expect(
      locateReaderPages({
        chunks,
        citationPageIdx: 3,
        versionState: { kind: 'unverifiable' },
      }),
    ).toEqual([0, 2, 5])
    expect(
      locateReaderPages({
        chunks,
        citationPageIdx: 3,
        versionState: { kind: 'mismatch' },
      }),
    ).toEqual([0, 2, 5])
  })

  it('source 入口（latest）：只取 chunks 页，不并入任何引用页', () => {
    expect(
      locateReaderPages({ chunks, citationPageIdx: 3, versionState: { kind: 'latest' } }),
    ).toEqual([0, 2, 5])
  })

  it('忽略负数页 / 空 chunks → 空集合（不伪造页）', () => {
    expect(
      locateReaderPages({
        chunks: [chunk(-1), chunk(0)],
        citationPageIdx: null,
        versionState: { kind: 'match' },
      }),
    ).toEqual([0])
    expect(
      locateReaderPages({ chunks: [], citationPageIdx: null, versionState: { kind: 'match' } }),
    ).toEqual([])
  })
})

describe('resolveReaderInitialPage（§2.3/§2.10-5）', () => {
  const pages = [0, 2, 5]

  it('请求页在集合内 → 请求页（citation 被引页优先）', () => {
    expect(resolveReaderInitialPage(pages, 2, { kind: 'match' })).toBe(2)
  })

  it('请求页不在集合内 → 集合首页', () => {
    expect(resolveReaderInitialPage(pages, 4, { kind: 'match' })).toBe(0)
    expect(resolveReaderInitialPage(pages, null, { kind: 'latest' })).toBe(0)
  })

  it('版本不可核对：不采用 citation.page_idx，即使它与集合内某页重合', () => {
    expect(resolveReaderInitialPage(pages, 2, { kind: 'unverifiable' })).toBe(0)
    expect(resolveReaderInitialPage(pages, 2, { kind: 'mismatch' })).toBe(0)
  })

  it('集合为空 → null（不伪造页/无页导航）', () => {
    expect(resolveReaderInitialPage([], 3, { kind: 'latest' })).toBeNull()
    expect(resolveReaderInitialPage([], null, { kind: 'match' })).toBeNull()
  })
})

describe('readerPageNeighbor（§2.4/§2.10-7：只在可定位页集合内移动）', () => {
  const pages = [0, 2, 5]

  it('集合内上一页/下一页', () => {
    expect(readerPageNeighbor(pages, 2, -1)).toBe(0)
    expect(readerPageNeighbor(pages, 2, 1)).toBe(5)
  })

  it('边界返回 null（不做未知页探测）', () => {
    expect(readerPageNeighbor(pages, 0, -1)).toBeNull()
    expect(readerPageNeighbor(pages, 5, 1)).toBeNull()
  })

  it('当前页不在集合（异常）→ 取相邻方向最近页；无则 null', () => {
    expect(readerPageNeighbor(pages, 3, -1)).toBe(2)
    expect(readerPageNeighbor(pages, 3, 1)).toBe(5)
    expect(readerPageNeighbor([], 0, 1)).toBeNull()
  })
})
