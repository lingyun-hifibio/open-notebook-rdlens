import { describe, expect, it, vi } from 'vitest'
import {
  detectResponseLanguage,
  resolveScopeSelection,
  type ScopeSelectionFetchers,
} from './scope-utils'
import type { ResearchScopeSnapshot } from './scope'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'

// RWV2-12 Red：Transformation 运行的共享 Scope 解析工具（RFC §3/§4.2）。
// - detectResponseLanguage：RFC §4.2 检测规则，与 RDLens agent/prompts.py
//   detect_lang 同语义（CJK > ASCII 字母 → zh，否则 en）。
// - resolveScopeSelection：selected 原样透传（副本）；entire_project 经
//   注入的 fetchers 分页枚举全部授权 source/note id（limit=100+cursor，
//   后端分页上限 1..100），跨页合并去重；中途失败向上冒泡（不吞错）。

const source = (id: string): ResearchSource => ({
  source_id: id,
  document_id: `doc_${id}`,
  document_version: 'v1',
  status: 'ready',
  content_hash: null,
  synced_at: null,
  last_error: null,
})

const note = (id: string): ResearchNote => ({
  note_id: id,
  project_id: 'proj_1',
  title: `Note ${id}`,
  content: 'body',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
})

function page<T>(items: T[], next: string | null) {
  return { items, next_cursor: next }
}

function stubFetchers(overrides: Partial<ScopeSelectionFetchers> = {}): ScopeSelectionFetchers {
  return {
    listSources: vi.fn(),
    listNotes: vi.fn(),
    ...overrides,
  }
}

describe('detectResponseLanguage（RFC §4.2 检测规则）', () => {
  it('CJK 多于 ASCII 字母 → zh', () => {
    expect(detectResponseLanguage('请总结这份研究并给出结论')).toBe('zh')
  })

  it('ASCII 字母多于 CJK / 纯英文 → en', () => {
    expect(detectResponseLanguage('Summarize the key findings')).toBe('en')
  })

  it('平局 → en（RFC §4.2：平局默认 en）', () => {
    // 1 CJK（研）+ 1 ASCII 字母（a）→ 平局 → en
    expect(detectResponseLanguage('研a')).toBe('en')
  })

  it('纯数字 / 空输入 / 纯缩写 → en', () => {
    expect(detectResponseLanguage('2026')).toBe('en')
    expect(detectResponseLanguage('   ')).toBe('en')
    expect(detectResponseLanguage('')).toBe('en')
    expect(detectResponseLanguage('DNA')).toBe('en')
  })

  it('混合文本按计数比较', () => {
    expect(detectResponseLanguage('蛋白质 structure 分析 molecule')).toBe('en')
    // CJK 占优（13 个 CJK vs 3 个 ASCII 字母）→ zh
    expect(detectResponseLanguage('蛋白质结构的分子生物学研究 xxx')).toBe('zh')
    // ASCII 占优（13 个 CJK vs 14 个 ASCII 字母）→ en
    expect(detectResponseLanguage('蛋白质结构的分子生物学研究 abcdefghijklmn')).toBe('en')
  })
})

describe('resolveScopeSelection', () => {
  const snapshot = (mode: 'entire_project' | 'selected', sourceIds = [], noteIds = []): ResearchScopeSnapshot =>
    ({ mode, sourceIds, noteIds })

  it('selected：原样透传并返回副本（不共享引用，防冻结数组泄漏）', async () => {
    const fetchers = stubFetchers()
    const input: ResearchScopeSnapshot = { mode: 'selected', sourceIds: ['src_1'], noteIds: ['note_1'] }
    const result = await resolveScopeSelection('proj_1', input, fetchers)
    expect(result).toEqual({ sourceIds: ['src_1'], noteIds: ['note_1'] })
    expect(result.sourceIds).not.toBe(input.sourceIds)
    expect(result.noteIds).not.toBe(input.noteIds)
    expect(fetchers.listSources).not.toHaveBeenCalled()
    expect(fetchers.listNotes).not.toHaveBeenCalled()
  })

  it('entire_project：跨页枚举全部 sources 与 notes，limit=100 且逐页消费 cursor', async () => {
    const sourcesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([source('s1'), source('s2')], 'c1'))
      .mockResolvedValueOnce(page([source('s3')], 'c2'))
      .mockResolvedValueOnce(page([source('s4')], null))
    const notesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1')], 'c3'))
      .mockResolvedValueOnce(page([note('n2'), note('n3')], null))
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), {
      listSources: sourcesFetcher,
      listNotes: notesFetcher,
    })
    expect(result.sourceIds).toEqual(['s1', 's2', 's3', 's4'])
    expect(result.noteIds).toEqual(['n1', 'n2', 'n3'])
    expect(sourcesFetcher).toHaveBeenNthCalledWith(1, 'proj_1', { limit: 100, cursor: undefined })
    expect(sourcesFetcher).toHaveBeenNthCalledWith(2, 'proj_1', { limit: 100, cursor: 'c1' })
    expect(sourcesFetcher).toHaveBeenNthCalledWith(3, 'proj_1', { limit: 100, cursor: 'c2' })
    expect(notesFetcher).toHaveBeenNthCalledWith(1, 'proj_1', { limit: 100, cursor: undefined })
    expect(notesFetcher).toHaveBeenNthCalledWith(2, 'proj_1', { limit: 100, cursor: 'c3' })
  })

  it('entire_project：跨页重复 id 只保留一份（去重防抖）', async () => {
    const sourcesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([source('s1')], 'c1'))
      .mockResolvedValueOnce(page([source('s1'), source('s2')], null))
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), {
      listSources: sourcesFetcher,
      listNotes: vi.fn().mockResolvedValue(page([], null)),
    })
    expect(result.sourceIds).toEqual(['s1', 's2'])
  })

  it('entire_project：空项目 → 空列表（由调用方阻断并引导）', async () => {
    const fetchers = stubFetchers({
      listSources: vi.fn().mockResolvedValue(page([], null)),
      listNotes: vi.fn().mockResolvedValue(page([], null)),
    })
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), fetchers)
    expect(result).toEqual({ sourceIds: [], noteIds: [] })
  })

  it('entire_project：枚举中途失败向上冒泡（不吞错，调用方 toast）', async () => {
    const sourcesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([source('s1')], 'c1'))
      .mockRejectedValueOnce(new Error('gateway down'))
    await expect(
      resolveScopeSelection('proj_1', snapshot('entire_project'), {
        listSources: sourcesFetcher,
        listNotes: vi.fn().mockResolvedValue(page([], null)),
      }),
    ).rejects.toThrow('gateway down')
  })
})
