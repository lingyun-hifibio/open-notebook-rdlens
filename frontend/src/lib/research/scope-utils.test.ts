import { describe, expect, it, vi } from 'vitest'
import {
  detectResponseLanguage,
  EmptyEffectiveScopeError,
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
  const snapshot = (
    mode: 'entire_project' | 'selected',
    sourceIds: string[] = [],
    noteIds: string[] = [],
  ): ResearchScopeSnapshot => ({ mode, sourceIds, noteIds })

  it('selected：原样透传并返回副本（不共享引用，防冻结数组泄漏）', async () => {
    const fetchers = stubFetchers()
    const input: ResearchScopeSnapshot = { mode: 'selected', sourceIds: ['src_1'], noteIds: ['note_1'] }
    const result = await resolveScopeSelection('proj_1', input, fetchers)
    expect(result).toEqual({ sourceIds: ['src_1'], noteIds: ['note_1'], staleSourceCount: 0 })
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
    // 首页断言用 toStrictEqual：toHaveBeenNthCalledWith 为 toEqual 语义，
    // 无法区分 { cursor: undefined } 与缺键（vitest 实验证实）
    expect(sourcesFetcher.mock.calls[0]?.[1]).toStrictEqual({ limit: 100 })
    expect(sourcesFetcher).toHaveBeenNthCalledWith(2, 'proj_1', { limit: 100, cursor: 'c1' })
    expect(sourcesFetcher).toHaveBeenNthCalledWith(3, 'proj_1', { limit: 100, cursor: 'c2' })
    expect(notesFetcher.mock.calls[0]?.[1]).toStrictEqual({ limit: 100 })
    expect(notesFetcher).toHaveBeenNthCalledWith(2, 'proj_1', { limit: 100, cursor: 'c3' })
  })

  it('entire_project：单页含 items 且首页 next_cursor=null 直接终止', async () => {
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), {
      listSources: vi.fn().mockResolvedValue(page([source('s1')], null)),
      listNotes: vi.fn().mockResolvedValue(page([note('n1')], null)),
    })
    expect(result).toEqual({ sourceIds: ['s1'], noteIds: ['n1'], staleSourceCount: 0 })
  })

  it('entire_project：notes 侧跨页重复 id 只保留一份', async () => {
    const notesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1')], 'c3'))
      .mockResolvedValueOnce(page([note('n1'), note('n2')], null))
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), {
      listSources: vi.fn().mockResolvedValue(page([], null)),
      listNotes: notesFetcher,
    })
    expect(result.noteIds).toEqual(['n1', 'n2'])
  })

  it('entire_project：notes 枚举中途失败同样向上冒泡', async () => {
    const notesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1')], 'c3'))
      .mockRejectedValueOnce(new Error('notes gateway down'))
    await expect(
      resolveScopeSelection('proj_1', snapshot('entire_project'), {
        listSources: vi.fn().mockResolvedValue(page([source('s1')], null)),
        listNotes: notesFetcher,
      }),
    ).rejects.toThrow('notes gateway down')
  })

  it('entire_project：游标不前进视为协议错误并抛错（防无界翻页）', async () => {
    const sourcesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([source('s1')], 'c1'))
      .mockResolvedValueOnce(page([source('s2')], 'c1'))
    await expect(
      resolveScopeSelection('proj_1', snapshot('entire_project'), {
        listSources: sourcesFetcher,
        listNotes: vi.fn().mockResolvedValue(page([], null)),
      }),
    ).rejects.toThrow('Research pagination returned a repeated cursor')
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

  it('entire_project：只保留 ready/stale Source，保留 stale 计数与全部 Note', async () => {
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), {
      listSources: vi.fn().mockResolvedValue(page([
        source('ready'),
        { ...source('stale'), status: 'stale' },
        { ...source('pending'), status: 'pending' },
        { ...source('failed'), status: 'failed' },
      ], null)),
      listNotes: vi.fn().mockResolvedValue(page([note('n1')], null)),
    })
    expect(result).toEqual({
      sourceIds: ['ready', 'stale'],
      noteIds: ['n1'],
      staleSourceCount: 1,
    })
  })

  it('entire_project：Source 全被过滤但仍有 Note → 合法（Note-only 交给 Host S1 路径）', async () => {
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), {
      listSources: vi.fn().mockResolvedValue(page([
        { ...source('pending'), status: 'pending' },
        { ...source('failed'), status: 'failed' },
      ], null)),
      listNotes: vi.fn().mockResolvedValue(page([note('n1'), note('n2')], null)),
    })
    expect(result).toEqual({
      sourceIds: [],
      noteIds: ['n1', 'n2'],
      staleSourceCount: 0,
    })
  })

  it('entire_project：next_cursor 空串按无 cursor 终止（不再发出 cursor= 请求）', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page([source('s1')], ''))
    const result = await resolveScopeSelection('proj_1', snapshot('entire_project'), {
      listSources: fetcher,
      listNotes: vi.fn().mockResolvedValue(page([note('n1')], null)),
    })
    expect(result.sourceIds).toEqual(['s1'])
    // 空串不构成第二页：只请求一次，且首页不带 cursor 键
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]).toStrictEqual({ limit: 100 })
  })

  it('entire_project：A→B→A cursor 循环整体失败，不使用部分范围', async () => {
    const sourcesFetcher = vi
      .fn()
      .mockResolvedValueOnce(page([source('s1')], 'a'))
      .mockResolvedValueOnce(page([source('s2')], 'b'))
      .mockResolvedValueOnce(page([source('s3')], 'a'))
    await expect(
      resolveScopeSelection('proj_1', snapshot('entire_project'), {
        listSources: sourcesFetcher,
        listNotes: vi.fn().mockResolvedValue(page([], null)),
      }),
    ).rejects.toThrow('Research pagination returned a repeated cursor')
  })

  it('entire_project：空有效范围抛 typed error（不得进入派发）', async () => {
    const fetchers = stubFetchers({
      listSources: vi.fn().mockResolvedValue(page([], null)),
      listNotes: vi.fn().mockResolvedValue(page([], null)),
    })
    await expect(
      resolveScopeSelection('proj_1', snapshot('entire_project'), fetchers),
    ).rejects.toBeInstanceOf(EmptyEffectiveScopeError)
  })

  it('selected：去重且顺序稳定（provider 已去重，此处为冻结快照的防御层）', async () => {
    const result = await resolveScopeSelection(
      'proj_1',
      snapshot('selected', ['src_2', 'src_1', 'src_2'], ['note_1', 'note_1']),
      stubFetchers(),
    )
    expect(result).toEqual({
      sourceIds: ['src_2', 'src_1'],
      noteIds: ['note_1'],
      staleSourceCount: 0,
    })
  })

  it('selected：reconciliation 后为空同样抛 typed error（不扩面，不派发）', async () => {
    const fetchers = stubFetchers()
    await expect(
      resolveScopeSelection('proj_1', snapshot('selected', [], []), fetchers),
    ).rejects.toBeInstanceOf(EmptyEffectiveScopeError)
    expect(fetchers.listSources).not.toHaveBeenCalled()
    expect(fetchers.listNotes).not.toHaveBeenCalled()
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
