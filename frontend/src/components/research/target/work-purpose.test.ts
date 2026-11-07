import { describe, expect, it } from 'vitest'

import {
  parseWorkPurpose,
  parseWorkPurposePair,
  parseWorkPurposeSource,
  readPurposeInferenceCapability,
  workPurposeLabelKey,
  workPurposeSourceLabelKey,
} from '@/lib/research/types'
import { readMessageWorkPurpose } from '@/lib/research/session-contract'

// W1 #1106 PR-B：purpose 读投影/能力位纯函数（计划 §5/§6/§8.3）。
// 纪律：缺失/非法/旧行一律 fail-closed 为「未记录」，绝不回填 document_qa。

function rowWithKeys(total: number, pair?: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (let i = 0; i < total; i += 1) row[`k${i}`] = i
  return { ...row, ...(pair ?? {}) }
}

describe('parseWorkPurpose / parseWorkPurposeSource', () => {
  it('只接受三个契约值；未知/null → null（不猜测）', () => {
    expect(parseWorkPurpose('document_qa')).toBe('document_qa')
    expect(parseWorkPurpose('exploration')).toBe('exploration')
    expect(parseWorkPurpose('writing')).toBe('writing')
    expect(parseWorkPurpose('delegated_research')).toBeNull()
    expect(parseWorkPurpose('document')).toBeNull()
    expect(parseWorkPurpose(null)).toBeNull()
    expect(parseWorkPurpose(undefined)).toBeNull()
    expect(parseWorkPurpose(1)).toBeNull()
  })

  it('来源只接受 explicit/inferred/default_legacy/not_recorded；未知 → null', () => {
    for (const source of ['explicit', 'inferred', 'default_legacy', 'not_recorded']) {
      expect(parseWorkPurposeSource(source)).toBe(source)
    }
    expect(parseWorkPurposeSource('default')).toBeNull()
    expect(parseWorkPurposeSource('inferred ')).toBeNull()
    expect(parseWorkPurposeSource(null)).toBeNull()
  })
})

describe('readPurposeInferenceCapability', () => {
  it('严格 === true 才启用', () => {
    expect(readPurposeInferenceCapability({ purpose_inference: true })).toBe(true)
  })

  it('false/缺失/非法类型/旧后端 → false（fail-closed）', () => {
    expect(readPurposeInferenceCapability({ purpose_inference: false })).toBe(false)
    expect(readPurposeInferenceCapability({})).toBe(false)
    expect(readPurposeInferenceCapability({ search_history: true })).toBe(false)
    expect(readPurposeInferenceCapability({ purpose_inference: 'true' })).toBe(false)
    expect(readPurposeInferenceCapability({ purpose_inference: 1 })).toBe(false)
    expect(readPurposeInferenceCapability({ purpose_inference: { enabled: true } })).toBe(false)
    expect(readPurposeInferenceCapability({ purpose_inference: null })).toBe(false)
    expect(readPurposeInferenceCapability(null)).toBe(false)
    expect(readPurposeInferenceCapability(undefined)).toBe(false)
  })
})

describe('parseWorkPurposePair（消息行/SSE usage 共用）', () => {
  it('自洽配对：显式/推断/缺省 → 值+来源', () => {
    expect(
      parseWorkPurposePair({ work_purpose: 'document_qa', work_purpose_source: 'explicit' }),
    ).toEqual({ workPurpose: 'document_qa', workPurposeSource: 'explicit' })
    expect(
      parseWorkPurposePair({ work_purpose: 'exploration', work_purpose_source: 'inferred' }),
    ).toEqual({ workPurpose: 'exploration', workPurposeSource: 'inferred' })
    expect(
      parseWorkPurposePair({ work_purpose: 'writing', work_purpose_source: 'default_legacy' }),
    ).toEqual({ workPurpose: 'writing', workPurposeSource: 'default_legacy' })
  })

  it('未记录：null + not_recorded 合法', () => {
    expect(
      parseWorkPurposePair({ work_purpose: null, work_purpose_source: 'not_recorded' }),
    ).toEqual({ workPurpose: null, workPurposeSource: 'not_recorded' })
  })

  it('键缺失/单键/不自洽/未知值 → null（整组丢弃，不跨键拼）', () => {
    expect(parseWorkPurposePair({})).toBeNull()
    expect(parseWorkPurposePair({ work_purpose: 'document_qa' })).toBeNull()
    expect(parseWorkPurposePair({ work_purpose_source: 'explicit' })).toBeNull()
    expect(
      parseWorkPurposePair({ work_purpose: null, work_purpose_source: 'explicit' }),
    ).toBeNull()
    expect(
      parseWorkPurposePair({ work_purpose: 'exploration', work_purpose_source: 'not_recorded' }),
    ).toBeNull()
    expect(
      parseWorkPurposePair({ work_purpose: 'unknown', work_purpose_source: 'explicit' }),
    ).toBeNull()
    expect(
      parseWorkPurposePair({ work_purpose: 'exploration', work_purpose_source: 'bogus' }),
    ).toBeNull()
  })
})

describe('readMessageWorkPurpose（headed 消息行，版本/key-count fail-closed）', () => {
  it('d1c 17 键（purpose 两键）→ 正确读取', () => {
    const row = rowWithKeys(15, {
      work_purpose: 'exploration',
      work_purpose_source: 'inferred',
    })
    expect(Object.keys(row)).toHaveLength(17)
    expect(readMessageWorkPurpose(row, 'd1c')).toEqual({
      workPurpose: 'exploration',
      workPurposeSource: 'inferred',
    })
  })

  it('d1c 19 键（含 verification）→ 正确读取', () => {
    const row = rowWithKeys(17, {
      work_purpose: 'document_qa',
      work_purpose_source: 'default_legacy',
    })
    expect(Object.keys(row)).toHaveLength(19)
    expect(readMessageWorkPurpose(row, 'd1c')).toEqual({
      workPurpose: 'document_qa',
      workPurposeSource: 'default_legacy',
    })
  })

  it('d1e 18/20 键 → 正确读取', () => {
    const row18 = rowWithKeys(16, {
      work_purpose: 'writing',
      work_purpose_source: 'explicit',
    })
    expect(readMessageWorkPurpose(row18, 'd1e')).toEqual({
      workPurpose: 'writing',
      workPurposeSource: 'explicit',
    })
    const row20 = rowWithKeys(18, {
      work_purpose: null,
      work_purpose_source: 'not_recorded',
    })
    expect(readMessageWorkPurpose(row20, 'd1e')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
  })

  it('旧行 15 键 legacy → 未记录（不回填 document_qa）', () => {
    expect(readMessageWorkPurpose(rowWithKeys(15), 'legacy')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
    expect(readMessageWorkPurpose(rowWithKeys(15), 'd1c')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
  })

  it('版本已知但键数不属于该版本 → fail-closed 未记录（不按旧键集容忍新投影）', () => {
    // d1c 允许 17/19：16 键（含 purpose 两键）必须拒绝。
    const row = rowWithKeys(14, {
      work_purpose: 'exploration',
      work_purpose_source: 'inferred',
    })
    expect(Object.keys(row)).toHaveLength(16)
    expect(readMessageWorkPurpose(row, 'd1c')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
    // legacy（15 键）不允许出现 purpose 两键：17 键 legacy 也不得读值。
    const legacyWithPurpose = rowWithKeys(15, {
      work_purpose: 'exploration',
      work_purpose_source: 'inferred',
    })
    expect(readMessageWorkPurpose(legacyWithPurpose, 'legacy')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
  })

  it('键缺失/值非法/配对不自洽 → 未记录（绝不猜测）', () => {
    const d1cNoKeys = rowWithKeys(17)
    expect(readMessageWorkPurpose(d1cNoKeys, 'd1c')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
    const badValue = rowWithKeys(15, {
      work_purpose: 'document',
      work_purpose_source: 'explicit',
    })
    expect(readMessageWorkPurpose(badValue, 'd1c')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
    const inconsistent = rowWithKeys(15, {
      work_purpose: null,
      work_purpose_source: 'explicit',
    })
    expect(readMessageWorkPurpose(inconsistent, 'd1c')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
  })

  it('版本未知（响应头缺失）→ 键出现才严格解析，缺失 = 未记录', () => {
    const row = rowWithKeys(15, {
      work_purpose: 'exploration',
      work_purpose_source: 'inferred',
    })
    expect(readMessageWorkPurpose(row, null)).toEqual({
      workPurpose: 'exploration',
      workPurposeSource: 'inferred',
    })
    expect(readMessageWorkPurpose(rowWithKeys(15), null)).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
  })
})

describe('展示映射键', () => {
  it('目的/来源映射到 composer.purpose 文案键（显式/推断/缺省/未记录不互相冒充）', () => {
    expect(workPurposeLabelKey('document_qa')).toBe('research.target.composer.purpose.documentQa')
    expect(workPurposeLabelKey('exploration')).toBe('research.target.composer.purpose.exploration')
    expect(workPurposeLabelKey('writing')).toBe('research.target.composer.purpose.writing')
    expect(workPurposeSourceLabelKey('explicit')).toBe('research.target.composer.purpose.sourceExplicit')
    expect(workPurposeSourceLabelKey('inferred')).toBe('research.target.composer.purpose.sourceInferred')
    expect(workPurposeSourceLabelKey('default_legacy')).toBe(
      'research.target.composer.purpose.sourceDefaultLegacy',
    )
    expect(workPurposeSourceLabelKey('not_recorded')).toBe(
      'research.target.composer.purpose.sourceNotRecorded',
    )
  })
})

// W1 #1106 PR-B：SSE usage 事件的 purpose 两键（与消息详情/completed 重放同源；
// 严格配对、非法整组丢弃、flag off/旧后端不投影时保持 null=未知）。
import { applySseEvent, createSseState, parseResearchEvent } from '@/lib/research/sse'

describe('SSE usage work_purpose（#1106）', () => {
  it('合法两键 → 合并进状态（inferred 也接受）', () => {
    const event = parseResearchEvent({
      event_id: 1,
      type: 'usage',
      usage: { input_tokens: 1, output_tokens: 2 },
      work_purpose: 'exploration',
      work_purpose_source: 'inferred',
    })
    expect(event?.work_purpose).toBe('exploration')
    expect(event?.work_purpose_source).toBe('inferred')
    const state = applySseEvent(createSseState(), event!)
    expect(state.workPurpose).toBe('exploration')
    expect(state.workPurposeSource).toBe('inferred')
  })

  it('未记录：null + not_recorded → 状态显式未记录', () => {
    const event = parseResearchEvent({
      event_id: 1,
      type: 'usage',
      usage: { input_tokens: 1, output_tokens: 2 },
      work_purpose: null,
      work_purpose_source: 'not_recorded',
    })
    const state = applySseEvent(createSseState(), event!)
    expect(event?.work_purpose).toBeNull()
    expect(state.workPurpose).toBeNull()
    expect(state.workPurposeSource).toBe('not_recorded')
  })

  it('两键缺失（flag off/旧后端）→ 状态保持未知 null/null', () => {
    const event = parseResearchEvent({
      event_id: 1,
      type: 'usage',
      usage: { input_tokens: 1, output_tokens: 2 },
    })
    expect(event).not.toHaveProperty('work_purpose')
    expect(event).not.toHaveProperty('work_purpose_source')
    const state = applySseEvent(createSseState(), event!)
    expect(state.workPurpose).toBeNull()
    expect(state.workPurposeSource).toBeNull()
  })

  it('非法/不自洽/未知值整组丢弃（不猜值）', () => {
    const cases: Array<Record<string, unknown>> = [
      { work_purpose: 'document', work_purpose_source: 'explicit' },
      { work_purpose: 'exploration', work_purpose_source: 'bogus' },
      { work_purpose: null, work_purpose_source: 'explicit' },
      { work_purpose: 'writing', work_purpose_source: 'not_recorded' },
      { work_purpose: 'exploration' },
      { work_purpose_source: 'inferred' },
    ]
    for (const extra of cases) {
      const event = parseResearchEvent({
        event_id: 1,
        type: 'usage',
        usage: { input_tokens: 1, output_tokens: 2 },
        ...extra,
      })
      expect(event).not.toHaveProperty('work_purpose')
      expect(event).not.toHaveProperty('work_purpose_source')
    }
  })

  it('非 usage 事件不消费 purpose 键（fail-closed）', () => {
    const event = parseResearchEvent({
      event_id: 1,
      type: 'done',
      work_purpose: 'exploration',
      work_purpose_source: 'inferred',
    })
    expect(event).not.toHaveProperty('work_purpose')
    expect(event).not.toHaveProperty('work_purpose_source')
  })
})
