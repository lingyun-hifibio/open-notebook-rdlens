import { describe, expect, it } from 'vitest'
import {
  classifySourceMediaFailure,
  normalizeSourceType,
  pageImageCapable,
  sourceFileExtension,
  sourceFileMimeType,
  sourceFormatLabelKey,
  sourceMediaProfile,
} from './source-media'

// Issue #1011（D1-E 主单）F01 Red：声明格式表（计划 §2.6）——
// `source_type` → 定位标签（Page/Slide/Sheet，0-based 持久化、展示 +1）/
// 页图能力（仅 pdf/ppt）/ 打开原文件 MIME / 未知与缺失回退（保持旧标签、
// 不显示新格式 UI）。纯函数，无 React/网络依赖。

describe('normalizeSourceType（格式归一，§2.6）', () => {
  it('声明格式逐字归一：pdf/ppt/xlsx/docx/csv', () => {
    expect(normalizeSourceType('pdf')).toBe('pdf')
    expect(normalizeSourceType('ppt')).toBe('ppt')
    expect(normalizeSourceType('xlsx')).toBe('xlsx')
    expect(normalizeSourceType('docx')).toBe('docx')
    expect(normalizeSourceType('csv')).toBe('csv')
    expect(normalizeSourceType('other')).toBe('other')
  })

  it('大小写/空白容错（后端技术格式可能来自不同解析器）', () => {
    expect(normalizeSourceType(' PDF ')).toBe('pdf')
    expect(normalizeSourceType('PPT')).toBe('ppt')
    expect(normalizeSourceType('Xlsx')).toBe('xlsx')
  })

  it('未知技术格式 → other（不臆造声明格式）', () => {
    expect(normalizeSourceType('vlm-annotated')).toBe('other')
    expect(normalizeSourceType('markdown')).toBe('other')
  })

  it('缺失/空串/null → null（旧 host 无加性字段；保持 pin 基线）', () => {
    expect(normalizeSourceType(undefined)).toBeNull()
    expect(normalizeSourceType(null)).toBeNull()
    expect(normalizeSourceType('')).toBeNull()
    expect(normalizeSourceType('   ')).toBeNull()
  })
})

describe('sourceMediaProfile（§2.6 格式表）', () => {
  it('pdf：Page 标签 + 页图能力 + application/pdf', () => {
    expect(sourceMediaProfile('pdf')).toEqual({
      format: 'pdf',
      formatLabelKey: 'research.source.formatPdf',
      locatorKind: 'page',
      chunkLocatorKey: 'research.sources.chunkPage',
      pageImage: true,
      pageImageLabelKey: 'research.source.pageImage',
      sheetOrderNote: false,
      mimeType: 'application/pdf',
      fileExtension: 'pdf',
    })
  })

  it('ppt：Slide 标签 + 页图能力 + OOXML pptx MIME', () => {
    expect(sourceMediaProfile('ppt')).toEqual({
      format: 'ppt',
      formatLabelKey: 'research.source.formatPpt',
      locatorKind: 'slide',
      chunkLocatorKey: 'research.sources.chunkSlide',
      pageImage: true,
      pageImageLabelKey: 'research.source.slideImage',
      sheetOrderNote: false,
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      fileExtension: 'pptx',
    })
  })

  it('xlsx：Sheet 标签 + 无页图 + 注明按 sheet 名排序序号', () => {
    expect(sourceMediaProfile('xlsx')).toEqual({
      format: 'xlsx',
      formatLabelKey: 'research.source.formatXlsx',
      locatorKind: 'sheet',
      chunkLocatorKey: 'research.sources.chunkSheet',
      pageImage: false,
      pageImageLabelKey: null,
      sheetOrderNote: true,
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileExtension: 'xlsx',
    })
  })

  it('csv：声明外格式——无新格式标签/无定位标签/无页图，仅通用打开原文件', () => {
    const profile = sourceMediaProfile('csv')
    expect(profile.format).toBe('csv')
    expect(profile.formatLabelKey).toBeNull()
    expect(profile.locatorKind).toBeNull()
    // 未知/声明外格式保持旧 chunk 标签（不新增 Sheet/Slide 语义）
    expect(profile.chunkLocatorKey).toBe('research.sources.chunkPage')
    expect(profile.pageImage).toBe(false)
    expect(profile.pageImageLabelKey).toBeNull()
    expect(profile.sheetOrderNote).toBe(false)
    expect(profile.mimeType).toBe('text/csv')
    expect(profile.fileExtension).toBe('csv')
  })

  it('docx：声明外格式——无新格式标签，docx MIME', () => {
    const profile = sourceMediaProfile('docx')
    expect(profile.formatLabelKey).toBeNull()
    expect(profile.locatorKind).toBeNull()
    expect(profile.pageImage).toBe(false)
    expect(profile.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(profile.fileExtension).toBe('docx')
  })

  it('未知/缺失：全部回退（不显示格式 UI、旧标签、不提供页图）', () => {
    for (const value of [undefined, null, '', 'something-else'] as const) {
      const profile = sourceMediaProfile(value)
      expect(profile.format).toBe(value === 'something-else' ? 'other' : null)
      expect(profile.formatLabelKey).toBeNull()
      expect(profile.locatorKind).toBeNull()
      expect(profile.chunkLocatorKey).toBe('research.sources.chunkPage')
      expect(profile.pageImage).toBe(false)
      expect(profile.pageImageLabelKey).toBeNull()
      expect(profile.sheetOrderNote).toBe(false)
      expect(profile.mimeType).toBe('application/octet-stream')
      expect(profile.fileExtension).toBeNull()
    }
  })

  it('大小写容错同样生效（PDF → pdf profile）', () => {
    expect(sourceMediaProfile('PDF').locatorKind).toBe('page')
    expect(sourceMediaProfile('PDF').formatLabelKey).toBe('research.source.formatPdf')
  })
})

describe('pageImageCapable / 映射便捷函数', () => {
  it('页图只声明 pdf/ppt', () => {
    expect(pageImageCapable('pdf')).toBe(true)
    expect(pageImageCapable('ppt')).toBe(true)
    for (const value of ['xlsx', 'docx', 'csv', 'other', null, undefined]) {
      expect(pageImageCapable(value as string | null | undefined)).toBe(false)
    }
  })

  it('sourceFormatLabelKey：仅 pdf/ppt/xlsx 有格式 badge 文案', () => {
    expect(sourceFormatLabelKey('pdf')).toBe('research.source.formatPdf')
    expect(sourceFormatLabelKey('ppt')).toBe('research.source.formatPpt')
    expect(sourceFormatLabelKey('xlsx')).toBe('research.source.formatXlsx')
    expect(sourceFormatLabelKey('csv')).toBeNull()
    expect(sourceFormatLabelKey('docx')).toBeNull()
    expect(sourceFormatLabelKey(undefined)).toBeNull()
  })

  it('sourceFileMimeType：未知一律 application/octet-stream（§2.6 MIME 白名单）', () => {
    expect(sourceFileMimeType('pdf')).toBe('application/pdf')
    expect(sourceFileMimeType('csv')).toBe('text/csv')
    expect(sourceFileMimeType('unknown-type')).toBe('application/octet-stream')
    expect(sourceFileMimeType(null)).toBe('application/octet-stream')
  })

  it('sourceFileExtension：未知/缺失为 null（下载文件名回退由服务端 Content-Disposition 提供）', () => {
    expect(sourceFileExtension('pdf')).toBe('pdf')
    expect(sourceFileExtension('ppt')).toBe('pptx')
    expect(sourceFileExtension('xlsx')).toBe('xlsx')
    expect(sourceFileExtension('csv')).toBe('csv')
    expect(sourceFileExtension(undefined)).toBeNull()
    expect(sourceFileExtension('weird')).toBeNull()
  })
})

// 媒体错误 → UI 行为分类（计划 §2.10 唯一来源；NORMATIVE 18/32）。
// 只有 envelope code `source_access_restricted` 的 410 表示撤权；核心端点
// 非 envelope 410/404 不得当作撤权（NORMATIVE 30）。

describe('classifySourceMediaFailure（§2.10 重试矩阵）', () => {
  it('410 + envelope code source_access_restricted → forbidden（不重试）', () => {
    expect(
      classifySourceMediaFailure({
        status: 410,
        code: 'source_access_restricted',
        detail: null,
      }),
    ).toBe('forbidden')
  })

  it('仅 envelope 码算撤权：非 envelope 410 不得显示为撤权（可重试兜底）', () => {
    expect(classifySourceMediaFailure({ status: 410, code: null, detail: null })).toBe(
      'retryable',
    )
    expect(
      classifySourceMediaFailure({ status: 410, code: 'something_else', detail: null }),
    ).toBe('retryable')
  })

  it('404 unsupported（核心文案）→ unsupported（走打开原文件，不重试）', () => {
    expect(
      classifySourceMediaFailure({
        status: 404,
        code: null,
        detail: 'Preview not supported for xlsx; open source file directly',
      }),
    ).toBe('unsupported')
  })

  it('404 纯 detail "Source not found"（authority 行竞态缺失）→ source_unavailable（无 UI 重试）', () => {
    expect(
      classifySourceMediaFailure({ status: 404, code: null, detail: 'Source not found' }),
    ).toBe('source_unavailable')
  })

  it('422 source_ref_mismatch → source_unavailable（版本已变：重新打开来源，而非重试同一载荷）', () => {
    expect(
      classifySourceMediaFailure({
        status: 422,
        code: 'source_ref_mismatch',
        detail: null,
      }),
    ).toBe('source_unavailable')
  })

  it('非 envelope 404（页图位置/原文件不可用）→ unavailable（可手动重试一次）', () => {
    for (const detail of [
      'Page source file is not available',
      'Source file is not available',
    ]) {
      expect(classifySourceMediaFailure({ status: 404, code: null, detail })).toBe(
        'unavailable',
      )
    }
  })

  it('500 纯 detail / 503 envelope / 网络错误 → retryable', () => {
    expect(
      classifySourceMediaFailure({ status: 500, code: null, detail: 'render failed' }),
    ).toBe('retryable')
    expect(
      classifySourceMediaFailure({
        status: 503,
        code: 'session_store_unavailable',
        detail: null,
      }),
    ).toBe('retryable')
    expect(classifySourceMediaFailure({ status: null, code: null, detail: null })).toBe(
      'retryable',
    )
  })
})
