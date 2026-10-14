import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScopeWarningSummary } from './ScopeWarningSummary'
import {
  WARNING_DETAIL_LIMIT,
  summarizeWarnings,
} from '@/lib/research/c05-warning-summary'
import type {
  C05ProjectionResult,
  C05ScopeWarning,
} from '@/lib/research/c05-scope-projection'

/**
 * PR5（D-01 / D-14 / D-17）：范围投影与警告**有界呈现**的组件断言。
 *
 * 关键点（对应 v8 §1 验收标准 12 与测试矩阵 T35 的组件半）：
 * - 合成**数百条**警告：明细条数受限、首屏 DOM 节点数不随规模增长、
 *   被截断时**标注**而不静默丢弃；
 * - `resolved_source_refs` 只出计数，**绝不**逐条渲染（服务端无上限）；
 * - 投影缺失 → 如实说明"服务端未返回范围详情"，**不猜测**（D-01/D-14）；
 * - 投影畸形 → 按不可用呈现并暴露稳定原因码，不展示半真数据。
 */

function scopeWith(
  warnings: C05ScopeWarning[],
  refs: Array<{ document_id: string; document_version: string }> = [],
): C05ProjectionResult {
  return {
    kind: 'present',
    scope: {
      mode: 'all',
      contract_version: 'c05-v1',
      resolved_source_refs: refs,
      note_ids: [],
      single_source_id: null,
      missing_source_ids: [],
      includes_exact_versions: false,
      contains_document_body: false,
      warnings,
    },
  }
}

/** "回退到旧版本"警告（used_version 非空） */
function fallbackWarning(index: number, docs = 1): C05ScopeWarning {
  return {
    code: 'stale_fallback',
    message: `fallback-${index}`,
    documents: Array.from({ length: docs }, (_, offset) => ({
      document_id: `doc_fb_${index}_${offset}`,
      used_version: 'v2',
      skipped_version: 'v3',
    })),
  }
}

/** "无可读版本被排除"警告（used_version 为空串） */
function excludedWarning(index: number, docs = 1): C05ScopeWarning {
  return {
    code: 'stale_fallback',
    message: `excluded-${index}`,
    documents: Array.from({ length: docs }, (_, offset) => ({
      document_id: `doc_ex_${index}_${offset}`,
      used_version: '',
      skipped_version: 'v9',
    })),
  }
}

describe('ScopeWarningSummary（D-17 有界呈现）', () => {
  it('T35：400 条警告 → 明细 ≤ WARNING_DETAIL_LIMIT 且标注"仅显示前 N 条"', () => {
    const warnings = Array.from({ length: 400 }, (_, index) => fallbackWarning(index))
    render(<ScopeWarningSummary projection={scopeWith(warnings)} />)

    expect(screen.getAllByTestId('scope-warning-detail')[0].querySelectorAll('li')).toHaveLength(
      WARNING_DETAIL_LIMIT,
    )
    expect(screen.getByTestId('scope-warning-truncated')).toHaveTextContent(
      'research.scopeDetails.warningsTruncated',
    )
    // 不静默丢弃：明细之外的条数由摘要/标注共同表达
    const summary = summarizeWarnings(warnings)
    expect(summary.fallbackCount).toBe(400)
    expect(summary.truncated).toBe(400 - WARNING_DETAIL_LIMIT)
  })

  it('T35：首屏 DOM 节点数不随警告规模增长（400 条 vs 800 条一致）', () => {
    const medium = Array.from({ length: 400 }, (_, index) => fallbackWarning(index))
    const huge = Array.from({ length: 800 }, (_, index) => fallbackWarning(index))

    const { container: mediumContainer, unmount } = render(
      <ScopeWarningSummary projection={scopeWith(medium)} />,
    )
    const mediumNodes = mediumContainer.querySelectorAll('*').length
    unmount()

    const { container: hugeContainer } = render(
      <ScopeWarningSummary projection={scopeWith(huge)} />,
    )
    const hugeNodes = hugeContainer.querySelectorAll('*').length

    // 超过明细上限后节点数**完全恒定**（不是"增长得慢"）
    expect(hugeNodes).toBe(mediumNodes)
    expect(hugeNodes).toBeLessThan(20)
  })

  it('T35：计数摘要区分"回退 N 篇"与"排除 M 篇"', () => {
    const warnings: C05ScopeWarning[] = [
      fallbackWarning(0, 3),
      excludedWarning(1, 2),
    ]
    render(<ScopeWarningSummary projection={scopeWith(warnings)} />)

    const summary = screen.getByTestId('scope-warning-summary')
    expect(summary).toHaveTextContent('research.scopeDetails.warningsFallback')
    expect(summary).toHaveTextContent('research.scopeDetails.warningsExcluded')
  })

  it('T35：resolved_source_refs 只出计数，绝不逐条渲染', () => {
    const refs = Array.from({ length: 300 }, (_, index) => ({
      document_id: `doc_ref_${index}`,
      document_version: 'v1',
    }))
    const { container } = render(<ScopeWarningSummary projection={scopeWith([], refs)} />)

    expect(screen.getByTestId('scope-projection-refs')).toHaveTextContent(
      'research.scopeDetails.projectionRefs',
    )
    const text = container.textContent ?? ''
    expect(text).not.toContain('doc_ref_1')
    expect(text).not.toContain('doc_ref_299')
    // 节点数与 refs 规模无关
    expect(container.querySelectorAll('*').length).toBeLessThan(10)
  })

  it('T35：混合警告**逐文档**计数（1 回退 + 1 排除），不整条归一类', () => {
    const mixed: C05ScopeWarning = {
      code: 'stale_fallback',
      message: 'mixed',
      documents: [
        { document_id: 'doc_a', used_version: 'v2', skipped_version: 'v3' },
        { document_id: 'doc_b', used_version: '', skipped_version: 'v9' },
      ],
    }
    const summary = summarizeWarnings([mixed])
    expect(summary.fallbackCount).toBe(1)
    expect(summary.excludedCount).toBe(1)
    expect(summary.undetailedCount).toBe(0)
    expect(summary.total).toBe(1)
  })

  it('T35：无 documents 的警告保持可见（undetailed），但**不虚构**文档篇数', () => {
    const summary = summarizeWarnings([{ code: 'stale_fallback', message: 'no-docs' }])
    expect(summary.undetailedCount).toBe(1)
    expect(summary.fallbackCount).toBe(0)
    expect(summary.excludedCount).toBe(0)
    expect(summary.total).toBe(1)
  })

  it('T35：undetailed 警告在 UI 里单列（不静默丢弃）', () => {
    render(<ScopeWarningSummary projection={scopeWith([
      { code: 'stale_fallback', message: 'no-docs' },
      excludedWarning(1, 2),
    ])} />)
    const summary = screen.getByTestId('scope-warning-summary')
    expect(summary).toHaveTextContent('research.scopeDetails.warningsUndetailed')
    expect(summary).toHaveTextContent('research.scopeDetails.warningsExcluded')
    expect(summary).not.toHaveTextContent('research.scopeDetails.warningsFallback')
  })

  it('非 stale_fallback 的警告不进入两类计数（但计入 total）', () => {
    const summary = summarizeWarnings([
      { code: 'other_code', message: 'x' },
      excludedWarning(1, 2),
    ])
    expect(summary.total).toBe(2)
    expect(summary.excludedCount).toBe(2)
    expect(summary.fallbackCount).toBe(0)
  })

  it('无警告时不渲染摘要与明细（不产空节点）', () => {
    render(<ScopeWarningSummary projection={scopeWith([])} />)

    expect(screen.queryByTestId('scope-warning-summary')).toBeNull()
    expect(screen.queryByTestId('scope-warning-detail')).toBeNull()
    expect(screen.queryByTestId('scope-warning-truncated')).toBeNull()
  })

  it('detailLimit 可注入（折叠展开的上限同样受控）', () => {
    const warnings = Array.from({ length: 50 }, (_, index) => fallbackWarning(index))
    const { container } = render(
      <ScopeWarningSummary projection={scopeWith(warnings)} detailLimit={2} />,
    )

    expect(container.querySelectorAll('[data-testid="scope-warning-detail"] li')).toHaveLength(2)
    expect(screen.getByTestId('scope-warning-truncated')).toBeInTheDocument()
  })
})

describe('ScopeWarningSummary（D-01 / D-14 数据来源纪律 / T31）', () => {
  it('投影缺失 → 如实说明"服务端未返回范围详情"，不猜测、不显示 stale 计数', () => {
    render(<ScopeWarningSummary projection={{ kind: 'absent' }} />)

    expect(screen.getByTestId('scope-projection-missing')).toHaveTextContent(
      'research.scopeDetails.projectionMissing',
    )
    // 缺失时不得出现任何计数/明细（stale 计数无据可依）
    expect(screen.queryByTestId('scope-warning-summary')).toBeNull()
    expect(screen.queryByTestId('scope-projection-refs')).toBeNull()
  })

  it('投影畸形 → 按不可用呈现并暴露稳定原因码（不展示半真数据）', () => {
    render(
      <ScopeWarningSummary
        projection={{ kind: 'invalid', reason: 'c05_scope_projection_invalid' }}
      />,
    )

    const node = screen.getByTestId('scope-projection-invalid')
    expect(node).toHaveTextContent('research.scopeDetails.projectionInvalid')
    expect(node).toHaveTextContent('c05_scope_projection_invalid')
    expect(screen.queryByTestId('scope-warning-detail')).toBeNull()
  })
})
