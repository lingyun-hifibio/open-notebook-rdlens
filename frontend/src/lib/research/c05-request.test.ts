/**
 * Issue #601 PR5：C-05 请求体构造测试（T2）——
 * 三形态固定取值、C-05 禁非空顶层 source_ids、forbid/insight 入口排除。
 */
import { describe, expect, it } from 'vitest'
import { buildC05GeneratedRequest, buildSourceScope } from './c05-request'
import contractSamplesJson from './fixtures/issue615_c05/samples.json'

type Sample = { schema: string; expect: string; value: Record<string, unknown> }
const samples = contractSamplesJson as unknown as Record<string, Sample>

describe('buildSourceScope（三形态与 fixture 对齐）', () => {
  it('all：source_ids=[] single_source_id=null（与 scope_request.all.valid 一致）', () => {
    expect(buildSourceScope({ mode: 'all', sourceIds: [], noteIds: [] }))
      .toEqual(samples['scope_request.all.valid'].value.source_scope)
  })
  it('selected：显式集合透传', () => {
    const scope = buildSourceScope({ mode: 'selected', sourceIds: ['s1', 's2'], noteIds: [] })
    expect(scope).toEqual({ mode: 'selected', source_ids: ['s1', 's2'], single_source_id: null })
  })
  it('single：只带 single_source_id', () => {
    expect(buildSourceScope({ mode: 'single', sourceIds: [], noteIds: [], singleSourceId: 's9' }))
      .toEqual({ mode: 'single', source_ids: [], single_source_id: 's9' })
  })
  it('selected 模式下 singleSourceId 被忽略（不产生畸形载荷）', () => {
    const scope = buildSourceScope({ mode: 'selected', sourceIds: ['s1'], noteIds: [], singleSourceId: 's9' })
    expect(scope.single_source_id).toBeNull()
  })
})

describe('buildC05GeneratedRequest（T2）', () => {
  const base = { query: 'q', model_id: 'm', mode: 'auto', context_level: 'focused' }

  it('all 请求：source_scope.mode=all、顶层无 source_ids 字段', () => {
    const body = buildC05GeneratedRequest({ mode: 'all', sourceIds: [], noteIds: [] }, base)
    expect(body.source_scope.mode).toBe('all')
    expect(body.source_scope.source_ids).toEqual([])
    expect((body as unknown as Record<string, unknown>).source_ids).toBeUndefined()
    expect(body.note_ids).toEqual([])
  })

  it('Note-only：selected + 空 source_ids + 非空 note_ids', () => {
    const body = buildC05GeneratedRequest({ mode: 'selected', sourceIds: [], noteIds: ['n1'] }, base)
    expect(body.source_scope).toEqual({ mode: 'selected', source_ids: [], single_source_id: null })
    expect(body.note_ids).toEqual(['n1'])
  })

  it('空 selected（无 Note）→ 构造层拒绝（防御，面板层应先拦）', () => {
    expect(() => buildC05GeneratedRequest({ mode: 'selected', sourceIds: [], noteIds: [] }, base))
      .toThrow('c05_request_empty_selected')
  })

  it('session_id 仅在显式提供时出现（客户端不自造）', () => {
    const without = buildC05GeneratedRequest({ mode: 'all', sourceIds: [], noteIds: [] }, base)
    expect((without as unknown as Record<string, unknown>).session_id).toBeUndefined()
    const withSession = buildC05GeneratedRequest(
      { mode: 'all', sourceIds: [], noteIds: [] },
      { ...base, session_id: 'sess_abc' },
    )
    expect(withSession.session_id).toBe('sess_abc')
  })

  it('mode/context_level 可选：不传则字段不出现', () => {
    const minimal = buildC05GeneratedRequest(
      { mode: 'all', sourceIds: [], noteIds: [] },
      { query: 'q', model_id: 'm' },
    )
    expect((minimal as unknown as Record<string, unknown>).mode).toBeUndefined()
    expect((minimal as unknown as Record<string, unknown>).context_level).toBeUndefined()
  })
})
