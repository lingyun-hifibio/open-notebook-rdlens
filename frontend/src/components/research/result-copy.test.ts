/**
 * RWV2-23（Issue #43，D7）：buildResultCopyText 纯逻辑测试。
 *
 * 覆盖：正文；0/1/N Citation；claim/原文/来源/页码组合；page null 不显示
 * 页码；空正文但仅 Citation；运行时混入未知键（Secret）绝不进入输出；
 * 空行跳过不产生悬空编号。
 */
import { describe, expect, it } from 'vitest'
import { buildResultCopyText } from './result-copy'

describe('buildResultCopyText（RWV2-23 D7）', () => {
  it('只有正文', () => {
    expect(buildResultCopyText({ content: 'ORR was 45%.' })).toBe('ORR was 45%.')
  })

  it('空输入 → 空串', () => {
    expect(buildResultCopyText({})).toBe('')
    expect(buildResultCopyText({ content: '   ', citations: [] })).toBe('')
  })

  it('正文 + 1 Citation（claim/原文/来源/页码 p.N）', () => {
    const text = buildResultCopyText({
      content: 'Conclusion.',
      citations: [
        {
          claim: 'ORR was 45%.',
          original_text: 'In the treated cohort ORR was 45%.',
          doc_id: 'd1',
          page_idx: 3,
        },
      ],
    })
    expect(text).toContain('Conclusion.')
    expect(text).toContain('Citations:')
    expect(text).toContain('1. ORR was 45%. — "In the treated cohort ORR was 45%." — d1 · p. 4')
  })

  it('page_idx 为 null/undefined 的行不输出页码；有页码的行输出 p.N；编号连续', () => {
    const text = buildResultCopyText({
      citations: [
        { claim: 'A claim.', doc_id: 'd1' },
        { claim: 'B claim.', original_text: 'quote B', doc_id: 'd2', page_idx: 0 },
      ],
    })
    expect(text).toContain('1. A claim. — d1\n2. B claim. — "quote B" — d2 · p. 1')
  })

  it('无 claim/原文且无 doc 的行被跳过，编号不悬空', () => {
    const text = buildResultCopyText({
      citations: [
        {},
        { claim: 'Only claim.' },
      ],
    })
    expect(text).toContain('Citations:\n1. Only claim.')
    expect(text).not.toContain('2.')
  })

  it('运行时混入的未知键（Secret/凭据）绝不进入输出', () => {
    const sneaky = {
      claim: 'safe claim',
      original_text: 'safe quote',
      doc_id: 'd1',
      page_idx: 2,
      token: 'SK-SUPERSECRET',
      api_key: 'AK-1234',
    } as never
    const text = buildResultCopyText({
      content: 'safe body',
      citations: [sneaky as never],
    })
    expect(text).not.toContain('SK-SUPERSECRET')
    expect(text).not.toContain('AK-1234')
    expect(text).not.toContain('token')
    expect(text).not.toContain('api_key')
    expect(text).toContain('safe claim')
  })
})
