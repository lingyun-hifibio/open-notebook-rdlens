/**
 * Issue #601 PR5：Preview 门禁（T26）+ 警告有界聚合（T35）+ 文档计量（T32）测试。
 */
import { describe, expect, it } from 'vitest'
import { evaluatePreviewGate, type C05Budget } from './c05-preview-gate'
import { summarizeWarnings, WARNING_DETAIL_LIMIT } from './c05-warning-summary'
import { countUniqueDocuments, uniqueDocumentIds } from './document-set'
import type { C05ScopeWarning } from './c05-scope-projection'

describe('evaluatePreviewGate（T26）', () => {
  const ready = { executionReady: true, scopeValid: true }

  it('entry 未就绪 → 阻断', () => {
    expect(evaluatePreviewGate({ ...ready, executionReady: false, budget: null }).blockedReason).toBe('entry_not_ready')
  })
  it('范围非法 → 阻断', () => {
    expect(evaluatePreviewGate({ executionReady: true, scopeValid: false, budget: null }).blockedReason).toBe('scope_invalid')
  })
  it('Preview 缺失 → 放行 + unvalidated 提示（不阻断）', () => {
    const r = evaluatePreviewGate({ ...ready, budget: null })
    expect(r.canSubmit).toBe(true)
    expect(r.notice).toBe('unvalidated')
  })

  it('必需检查 exceeded → 阻断', () => {
    const budget: C05Budget = { preflight_status: 'exceeded', checks: [
      { name: 'workspace_chars', unit: 'chars', state: 'exceeded', value: 5_000_000, limit: 4_000_000, limit_source: 'config', required_for_submit: true, reason: null },
    ] }
    expect(evaluatePreviewGate({ ...ready, budget }).blockedReason).toBe('budget_exceeded')
  })

  it('必需检查 unavailable → 阻断（budget_incomplete）', () => {
    const budget: C05Budget = { preflight_status: 'unavailable', checks: [
      { name: 'model_input', unit: 'tokens', state: 'unavailable', value: null, limit: null, limit_source: null, required_for_submit: true, reason: 'estimator missing' },
    ] }
    expect(evaluatePreviewGate({ ...ready, budget }).blockedReason).toBe('budget_incomplete')
  })

  it('非必需 not_checked（执行期检查）→ 放行 + execution_recheck', () => {
    const budget: C05Budget = { preflight_status: 'validated', checks: [
      { name: 'prompt_tokens_after_retrieval', unit: 'tokens', state: 'not_checked', value: null, limit: null, limit_source: null, required_for_submit: false, reason: 'deferred to execution' },
    ] }
    const r = evaluatePreviewGate({ ...ready, budget })
    expect(r.canSubmit).toBe(true)
    expect(r.notice).toBe('execution_recheck')
  })

  it('交互阈值 exceeded（非必需）只提示，不阻断全局（H-01）', () => {
    const budget: C05Budget = { preflight_status: 'validated', checks: [
      { name: 'interactive_input', unit: 'tokens', state: 'exceeded', value: 9000, limit: 8000, limit_source: 'config', required_for_submit: false, reason: 'interactive path only' },
    ] }
    const r = evaluatePreviewGate({ ...ready, budget })
    expect(r.canSubmit).toBe(true)
    expect(r.notice).toBe('interactive_only_exceeded')
  })

  it('全部必需 validated → 放行无提示', () => {
    const budget: C05Budget = { preflight_status: 'validated', checks: [
      { name: 'workspace_chars', unit: 'chars', state: 'validated', value: 1000, limit: 4_000_000, limit_source: 'config', required_for_submit: true, reason: null },
    ] }
    const r = evaluatePreviewGate({ ...ready, budget })
    expect(r.canSubmit).toBe(true)
    expect(r.notice).toBeNull()
  })
})

describe('summarizeWarnings（T35 有界）', () => {
  const oneWarning = (used: string): C05ScopeWarning => ({
    code: 'stale_fallback', message: 'x',
    documents: [{ document_id: `doc_${used}`, used_version: used, skipped_version: 'v9' }],
  })

  it('数百条输入 → 明细受限 + 计数正确 + truncated 正确', () => {
    const warnings: C05ScopeWarning[] = []
    for (let i = 0; i < 300; i += 1) warnings.push(oneWarning('v1'))
    for (let i = 0; i < 100; i += 1) warnings.push(oneWarning('')) // excluded
    const s = summarizeWarnings(warnings)
    expect(s.total).toBe(400)
    expect(s.detail).toHaveLength(WARNING_DETAIL_LIMIT)
    expect(s.truncated).toBe(400 - WARNING_DETAIL_LIMIT)
    expect(s.fallbackCount).toBe(300)
    expect(s.excludedCount).toBe(100)
  })

  it('used_version 空串计为排除（不虚构版本）', () => {
    const s = summarizeWarnings([oneWarning('')])
    expect(s.excludedCount).toBe(1)
    expect(s.fallbackCount).toBe(0)
  })

  it('undefined → 全零', () => {
    expect(summarizeWarnings(undefined)).toEqual({ fallbackCount: 0, excludedCount: 0, detail: [], truncated: 0, total: 0 })
  })
})

describe('countUniqueDocuments（T32 文档计量去重）', () => {
  it('同文档 v1+v2 共选 → 唯一文档数 1 + mergedDuplicates', () => {
    const r = countUniqueDocuments([
      { document_id: 'doc_a' }, { document_id: 'doc_a' }, { document_id: 'doc_b' },
    ])
    expect(r.uniqueDocumentCount).toBe(2)
    expect(r.selectionCount).toBe(3)
    expect(r.mergedDuplicates).toBe(true)
  })
  it('全部不同文档 → mergedDuplicates=false', () => {
    const r = countUniqueDocuments([{ document_id: 'a' }, { document_id: 'b' }])
    expect(r.uniqueDocumentCount).toBe(2)
    expect(r.mergedDuplicates).toBe(false)
  })
  it('uniqueDocumentIds 保留首见顺序', () => {
    expect(uniqueDocumentIds([{ document_id: 'b' }, { document_id: 'a' }, { document_id: 'b' }])).toEqual(['b', 'a'])
  })
})
