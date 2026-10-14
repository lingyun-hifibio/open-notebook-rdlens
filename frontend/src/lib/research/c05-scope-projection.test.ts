/**
 * Issue #601 PR5：投影校验测试（T16/T31）。
 */
import { describe, expect, it } from 'vitest'
import { extractScopeProjection, parseResolvedScope } from './c05-scope-projection'

const VALID = {
  mode: 'all', contract_version: 'c05-v1',
  resolved_source_refs: [{ document_id: 'doc_a', document_version: 'v2' }],
  note_ids: [], single_source_id: null, missing_source_ids: [],
  includes_exact_versions: true, contains_document_body: false,
  warnings: [{
    code: 'stale_fallback', message: 'newest version is not readable',
    documents: [{ document_id: 'doc_a', used_version: 'v1', skipped_version: 'v2' }],
  }],
}

describe('parseResolvedScope', () => {
  it('合法投影解析成功', () => {
    const r = parseResolvedScope(VALID)
    expect(r.kind).toBe('present')
    if (r.kind === 'present') {
      expect(r.scope.mode).toBe('all')
      expect(r.scope.resolved_source_refs).toHaveLength(1)
      expect(r.scope.warnings[0].documents![0].used_version).toBe('v1')
    }
  })
  it('undefined/null → absent（不猜测，T31）', () => {
    expect(parseResolvedScope(undefined).kind).toBe('absent')
    expect(parseResolvedScope(null).kind).toBe('absent')
  })
  it.each([
    ['contains_document_body=true', { ...VALID, contains_document_body: true }],
    ['contract_version 错', { ...VALID, contract_version: 'v1' }],
    ['mode 非法', { ...VALID, mode: 'entire_project' }],
    ['refs 成员类型错', { ...VALID, resolved_source_refs: [{ document_id: 1, document_version: 'v1' }] }],
    ['warnings 形状错', { ...VALID, warnings: [{ code: 1, message: 'x' }] }],
    ['非对象', 'nope'],
  ])('畸形 → invalid（%s）', (_name, value) => {
    expect(parseResolvedScope(value).kind).toBe('invalid')
  })
  it('used_version 空串被保留（不虚构被回退版本）', () => {
    const r = parseResolvedScope({
      ...VALID,
      warnings: [{ code: 'stale_fallback', message: 'x', documents: [{ document_id: 'd', used_version: '', skipped_version: 'v9' }] }],
    })
    if (r.kind === 'present') {
      expect(r.scope.warnings[0].documents![0].used_version).toBe('')
    } else expect.fail()
  })
})

describe('extractScopeProjection', () => {
  it('无字段 → absent', () => {
    expect(extractScopeProjection({ request_id: 'r' }).kind).toBe('absent')
  })
  it('合法投影体提取成功', () => {
    const r = extractScopeProjection({ scope_contract_version: 'c05-v1', resolved_scope: VALID })
    expect(r.kind).toBe('present')
  })
  it('头值不是 c05-v1 → invalid', () => {
    expect(extractScopeProjection({ scope_contract_version: 'v1', resolved_scope: VALID }).kind).toBe('invalid')
  })
})
