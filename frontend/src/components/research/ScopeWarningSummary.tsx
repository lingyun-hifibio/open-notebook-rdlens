'use client'

/**
 * Issue #601 PR5（D-01 / D-14 / D-17）：范围投影与警告的**有界**呈现。
 *
 * 数据来源纪律（D-01/D-14）：
 * - 只消费服务端投影（`extractScopeProjection` 的结果）；**存在才消费**。
 * - 缺失 → 显示"服务端未返回范围详情"，**不猜测**、不显示 stale 计数。
 * - 畸形 → 按不可用呈现并暴露稳定原因码（不展示半真数据）。
 *
 * 呈现规模纪律（D-17）：
 * - `warnings` 经 `summarizeWarnings` 聚合为"计数摘要 + ≤5 条有界明细"；
 *   被截断时标注"仅显示前 N 条"，**不静默丢弃**。
 * - `resolved_source_refs` **不作为逐条清单渲染**（它是范围身份，不是资料
 *   清单，且服务端无上限）；只出计数。
 * - 首屏渲染节点数**不随文档数增长**（合成 400 条警告仍只有固定条明细）。
 *
 * **取舍（有意为之）**：本组件**不提供展开**入口。D-17 允许"可展开但首屏不随
 * 文档数增长"，而无上限的展开恰恰是最容易把有界呈现重新变成无界的入口
 * （展开后再插入数百行）。当前做法是固定明细 + "仅显示前 N 条"标注，用户
 * 需要全量明细时应去资料列表查看（那里按 20 条分页）。若后续要加展开，
 * 必须同时加上限或虚拟化，并配"展开后节点数仍受限"的用例（`detailLimit`
 * 已为可注入参数，便于按页展开时复用同一契约）。
 */

import { useTranslation } from '@/lib/hooks/use-translation'
import {
  type C05ProjectionResult,
  type C05ScopeWarning,
} from '@/lib/research/c05-scope-projection'
import {
  WARNING_DETAIL_LIMIT,
  refCountSummary,
  summarizeWarnings,
} from '@/lib/research/c05-warning-summary'

export interface ScopeWarningSummaryProps {
  projection: C05ProjectionResult
  /** 明细上限（测试可注入；默认 `WARNING_DETAIL_LIMIT`） */
  detailLimit?: number
}

function detailLine(warning: C05ScopeWarning): string {
  const docs = warning.documents ?? []
  if (docs.length === 0) return warning.message
  const first = docs[0]
  const used = first.used_version === '' ? '—' : first.used_version
  return `${warning.message} (${first.document_id} · ${used})`
}

export function ScopeWarningSummary({
  projection,
  detailLimit = WARNING_DETAIL_LIMIT,
}: ScopeWarningSummaryProps) {
  const { t } = useTranslation()

  if (projection.kind === 'absent') {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="scope-projection-missing"
        role="status"
      >
        {t('research.scopeDetails.projectionMissing')}
      </p>
    )
  }

  if (projection.kind === 'invalid') {
    return (
      <p
        className="text-xs font-medium text-destructive"
        data-testid="scope-projection-invalid"
        role="alert"
      >
        {t('research.scopeDetails.projectionInvalid')} ({projection.reason})
      </p>
    )
  }

  const summary = summarizeWarnings(projection.scope.warnings, detailLimit)
  const refs = refCountSummary(projection.scope.resolved_source_refs)

  return (
    <div className="space-y-1" data-testid="scope-projection">
      {/* 范围身份：只出计数，绝不逐条渲染（refs 无上限）。用 `n` 而非
          `count`，避免 i18next 复数解析把键拆成 _one/_other（同
          `staleSourcesWarning` 的既有约定）。 */}
      <p className="text-xs text-muted-foreground" data-testid="scope-projection-refs">
        {t('research.scopeDetails.projectionRefs', { n: refs.documentCount })}
      </p>

      {summary.total > 0 && (
        <>
          <p className="text-xs text-muted-foreground" data-testid="scope-warning-summary">
            {[
              summary.fallbackCount > 0
                ? t('research.scopeDetails.warningsFallback', { n: summary.fallbackCount })
                : null,
              summary.excludedCount > 0
                ? t('research.scopeDetails.warningsExcluded', { n: summary.excludedCount })
                : null,
              // 无文档明细的警告：保持可见，但不混进上面两类篇数（评审 MEDIUM-8）
              summary.undetailedCount > 0
                ? t('research.scopeDetails.warningsUndetailed', { n: summary.undetailedCount })
                : null,
            ]
              .filter((part): part is string => part !== null)
              .join(' · ')}
          </p>
          <ul
            className="space-y-0.5 text-xs text-muted-foreground"
            data-testid="scope-warning-detail"
          >
            {summary.detail.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>{detailLine(warning)}</li>
            ))}
          </ul>
          {summary.truncated > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="scope-warning-truncated">
              {t('research.scopeDetails.warningsTruncated', { n: summary.detail.length })}
            </p>
          )}
        </>
      )}
    </div>
  )
}
