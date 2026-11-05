/**
 * 本地草稿 Markdown 下载单测（Issue #1046 PR4 / D2-B2，方案 §4.4）。
 *
 * 覆盖：文件名前缀/slug、标记行（明确“非已保存导出”）、原始正文逐字节保留、
 * DOM 下载依赖注入与不可用降级。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  NOTE_LOCAL_DRAFT_FILENAME_PREFIX,
  NOTE_LOCAL_DRAFT_MARKER_PREFIX,
  buildLocalDraftMarkdown,
  downloadLocalDraftMarkdown,
  localDraftFilename,
} from './note-download'

describe('buildLocalDraftMarkdown', () => {
  it('preserves raw content byte-for-byte after an explicit local-draft marker', () => {
    const content = '  前导空格\n\n# 标题 🚀\r\n尾随空格  \n'
    const file = buildLocalDraftMarkdown({
      title: '周报 / 2026-Q4',
      content,
      noteId: 'note_1',
      savedAt: '2026-11-05T00:00:00.000Z',
    })
    expect(file.contents.startsWith(NOTE_LOCAL_DRAFT_MARKER_PREFIX)).toBe(true)
    expect(file.contents).toContain('not-a-saved-export')
    expect(file.contents).toContain('note_id=note_1')
    expect(file.contents.endsWith(content)).toBe(true)
    // 不 strip、不归一化换行/Unicode。
    expect(file.contents.includes(content)).toBe(true)
  })

  it('marks anonymous drafts explicitly', () => {
    const file = buildLocalDraftMarkdown({ title: '', content: '' })
    expect(file.contents).toContain('note_id=none')
    expect(file.contents).toContain('saved_at=unknown')
  })

  it('builds a prefixed, filesystem-safe filename', () => {
    expect(localDraftFilename('周报 / 2026-Q4')).toBe(
      `${NOTE_LOCAL_DRAFT_FILENAME_PREFIX}-周报-2026-Q4.md`,
    )
    expect(localDraftFilename('   ')).toBe(`${NOTE_LOCAL_DRAFT_FILENAME_PREFIX}-untitled.md`)
    expect(localDraftFilename('a\\b:c*d?e"f<g>h|i')).not.toMatch(/[\\/:*?"<>|]/)
    expect(localDraftFilename('x'.repeat(200)).length).toBeLessThanOrEqual(
      NOTE_LOCAL_DRAFT_FILENAME_PREFIX.length + 60 + 1 + 3,
    )
  })
})

describe('downloadLocalDraftMarkdown', () => {
  it('creates and clicks an anchor then revokes the object URL', () => {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: { display: '' },
      click: vi.fn(),
    }
    const appendChild = vi.fn()
    const removeChild = vi.fn()
    const doc = {
      createElement: vi.fn(() => anchor),
      body: { appendChild, removeChild },
      documentElement: { appendChild, removeChild },
    } as unknown as Document
    const createObjectURL = vi.fn(() => 'blob:local-draft')
    const revokeObjectURL = vi.fn()
    const scheduled: Array<() => void> = []

    const ok = downloadLocalDraftMarkdown(
      { title: 'T', content: 'body', noteId: 'n1' },
      {
        document: doc,
        createObjectURL,
        revokeObjectURL,
        scheduleRevoke: (callback) => scheduled.push(callback),
      },
    )
    expect(ok).toBe(true)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(anchor.download).toBe(`${NOTE_LOCAL_DRAFT_FILENAME_PREFIX}-T.md`)
    expect(anchor.href).toBe('blob:local-draft')
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(appendChild).toHaveBeenCalled()
    expect(removeChild).toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-draft')
  })

  it('degrades to false when DOM/object URLs are unavailable (SSR/unsupported)', () => {
    expect(
      downloadLocalDraftMarkdown({ title: 'T', content: 'c' }, { document: null }),
    ).toBe(false)
    const doc = {
      createElement: vi.fn(),
      body: null,
      documentElement: null,
    } as unknown as Document
    expect(
      downloadLocalDraftMarkdown(
        { title: 'T', content: 'c' },
        { document: doc, createObjectURL: null },
      ),
    ).toBe(false)
    expect(
      downloadLocalDraftMarkdown(
        { title: 'T', content: 'c' },
        {
          document: doc,
          createObjectURL: () => {
            throw new Error('no blob support')
          },
        },
      ),
    ).toBe(false)
  })

  it('revokes the URL if anchor interaction throws', () => {
    const doc = {
      createElement: () => {
        throw new Error('blocked')
      },
    } as unknown as Document
    const revokeObjectURL = vi.fn()
    const ok = downloadLocalDraftMarkdown(
      { title: 'T', content: 'c' },
      { document: doc, createObjectURL: () => 'blob:x', revokeObjectURL },
    )
    expect(ok).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })
})
