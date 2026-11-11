'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { toDisplayItem } from './CoverageJobDetails'
import { useCompareReport } from '@/lib/hooks/use-compare-report'
import { getJob } from '@/lib/research/api'
import type {
  ResearchCitationDisplayItem,
  ResearchCompareJobView,
  ResearchJob,
  ResearchVerificationRecord,
} from '@/lib/research/types'

/**
 * #307：deep_compare Job 完成后的报告查看入口。
 *
 * completed + result_ref 才渲染「查看报告」按钮；展开后一次性读取
 * GET /jobs/{id}/report（#307 后端 compare 分支），渲染 markdown
 * 正文 + 规范化 Citation（409 report_unavailable 以错误呈现，不重试）。
 *
 * #1017（D1-H）回访展示（计划 §2.5/§2.9）：
 * - 展开时并读 `GET /jobs/{id}`：顶层 `verification_record`（canonical 校验
 *   记录）+ 加性 `compare` 段（声明范围／解析版本／实际覆盖／实际模型／
 *   结果引用）；report 端点键集不变，本视图不为它新增请求键；
 * - 只读分区「声明范围与实际范围」「实际模型」「校验状态」；`not_run` /
 *   `not_recorded` **绝不**渲染成「校验通过」（只有 `status === 'pass'`
 *   显示通过文案）；
 * - report 410 `compare_report_sources_revoked` / `..._unverifiable` →
 *   受限占位：**不渲染正文/引用**（hook 同时清空旧报告，不展示缓存正文）；
 * - report 503 → 可重试（显式按钮，不自动重试）；
 * - Activity 复用既有 Job 卡 →「查看报告」→ 本组件，自动获得同一展示，
 *   不新增列表字段/端点。
 */
export function CompareReportView({
  job,
  onCitationJump,
}: {
  job: ResearchJob
  onCitationJump?: (citation: ResearchCitationDisplayItem) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const enabled = open && job.status === 'completed' && !!job.result_ref
  const { report, loading, failureKind, errorCode, retry } = useCompareReport(
    job.project_id,
    job.job_id,
    enabled,
  )
  // #1017：范围/模型/校验状态只能经 GET /jobs/{id} 读取（列表与 report 均
  // 不新增这些键）。详情失败时降级为「状态不可用」提示，不伪造状态。
  const [jobDetail, setJobDetail] = useState<ResearchJob | null>(null)
  const [detailError, setDetailError] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setJobDetail(null)
      setDetailError(false)
      return undefined
    }
    let cancelled = false
    setDetailError(false)
    getJob(job.project_id, job.job_id)
      .then((detail) => {
        if (!cancelled) setJobDetail(detail)
      })
      .catch(() => {
        if (!cancelled) setDetailError(true)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, job.job_id, job.project_id])

  if (job.status !== 'completed' || !job.result_ref) {
    return null
  }

  const detail: ResearchJob = jobDetail ?? job
  const compare: ResearchCompareJobView | undefined = detail.compare
  const verification: ResearchVerificationRecord | undefined = detail.verification_record

  return (
    <div className="space-y-2 border-t pt-2" data-testid="compare-report">
      <Button
        variant="outline"
        size="sm"
        data-testid={`compare-report-toggle-${job.job_id}`}
        onClick={() => setOpen(!open)}
      >
        {open ? t('research.compareReportHide') : t('research.compareReportView')}
      </Button>
      {open && loading && (
        <p className="text-xs text-muted-foreground">{t('research.compareReportLoading')}</p>
      )}
      {open && !loading && failureKind === 'restricted' && (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
          data-testid="compare-report-restricted"
          data-code={errorCode ?? 'unknown'}
        >
          <p className="font-medium">{t('research.compareReportRestrictedTitle')}</p>
          <p>
            {errorCode === 'compare_report_sources_revoked'
              ? t('research.compareReportRestrictedRevoked')
              : errorCode === 'compare_report_sources_unverifiable'
                ? t('research.compareReportRestrictedUnverifiable')
                : t('research.compareReportRestrictedGeneric')}
          </p>
        </div>
      )}
      {open && !loading && failureKind === 'retryable' && (
        <div className="space-y-1" data-testid="compare-report-retryable">
          <p className="text-xs text-destructive">{t('research.compareReportRetryable')}</p>
          <Button variant="outline" size="sm" data-testid="compare-report-retry" onClick={retry}>
            {t('research.compareReportRetry')}
          </Button>
        </div>
      )}
      {open && !loading && failureKind === 'unavailable' && (
        <p className="text-xs text-destructive">{t('research.compareReportError')}</p>
      )}
      {open && !loading && report && (
        <div className="space-y-2" data-testid="compare-report-content">
          {detailError && (
            <p className="text-xs text-muted-foreground" data-testid="compare-report-detail-error">
              {t('research.compareReportDetailError')}
            </p>
          )}
          <div className="space-y-1 rounded-md border p-2 text-xs" data-testid="compare-report-readback">
            {renderScopeSection(compare, t)}
            {renderCoverageSection(compare, t)}
            {renderModelSection(compare, detail, t)}
            {renderVerificationSection(verification, t)}
          </div>
          <MarkdownRenderer>
            {typeof report.report?.markdown === 'string' ? report.report.markdown : ''}
          </MarkdownRenderer>
          <ResearchCitationList
            citations={
              Array.isArray(report.citations) ? report.citations.map(toDisplayItem) : []
            }
            onCitationClick={onCitationJump}
          />
        </div>
      )}
    </div>
  )
}

/** 校验状态 → 用户文案 key（只有 `pass` 显示「通过」；未知状态不冒充）。 */
const VERIFICATION_STATUS_KEYS: Record<string, string> = {
  pass: 'research.compareReportVerificationPass',
  degraded: 'research.compareReportVerificationDegraded',
  partial: 'research.compareReportVerificationPartial',
  unavailable: 'research.compareReportVerificationUnavailable',
  not_run: 'research.compareReportVerificationNotRun',
  not_recorded: 'research.compareReportVerificationNotRecorded',
  failed: 'research.compareReportVerificationFailed',
  repaired: 'research.compareReportVerificationRepaired',
}

function renderScopeSection(
  compare: ResearchCompareJobView | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  const scope = compare?.scope
  return (
    <div className="space-y-0.5" data-testid="compare-report-scope">
      <p className="font-medium">{t('research.compareReportScopeTitle')}</p>
      {scope === null || scope === undefined ? (
        <p data-testid="compare-report-scope-empty">{t('research.compareReportScopeEmpty')}</p>
      ) : (
        <>
          <p data-testid="compare-report-scope-mode">
            {scope.contract_version === 'legacy' || !scope.contract_version
              ? t('research.compareReportScopeLegacy')
              : scope.requested_mode === 'all'
                ? t('research.compareReportScopeAll')
                : t('research.compareReportScopeSelected')}
          </p>
          {/* MEDIUM-1（计划 §2.9 :312）：声明范围展示必须含「来源数」。
              `selected` 的声明集合 = provider source ids；`all` 无客户端集合
              （服务端解析），来源规模由「版本数」体现，不伪造一个客户端计数。 */}
          {scope.requested_mode === 'selected' && Array.isArray(scope.source_ids) && (
            <p data-testid="compare-report-scope-declared-sources">
              {t('research.compareReportScopeDeclaredSources', {
                count: scope.source_ids.length,
              })}
            </p>
          )}
          <p data-testid="compare-report-scope-resolved">
            {t('research.compareReportScopeResolved', { count: scopeResolvedCount(scope) })}
          </p>
          {(scope.warnings?.length ?? 0) > 0 && (
            <p data-testid="compare-report-scope-warnings">
              {t('research.compareReportScopeWarnings', { count: scope.warnings?.length ?? 0 })}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function scopeResolvedCount(scope: NonNullable<ResearchCompareJobView['scope']>): number {
  if (typeof scope.resolved_count === 'number') return scope.resolved_count
  return Array.isArray(scope.resolved_refs) ? scope.resolved_refs.length : 0
}

function renderCoverageSection(
  compare: ResearchCompareJobView | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  const coverage = compare?.coverage
  if (coverage === null || coverage === undefined) return null
  // LOW-2（审查）：缺键/畸形值不得回落成伪造的 0——两项计数都是 number
  // 才渲染真实计数，否则显式「未记录」（诚实性优先于凑一个整数）。
  const included = typeof coverage.included_count === 'number' ? coverage.included_count : null
  const failed = typeof coverage.failed_count === 'number' ? coverage.failed_count : null
  return (
    <div className="space-y-0.5" data-testid="compare-report-coverage">
      <p className="font-medium">{t('research.compareReportCoverageTitle')}</p>
      {included !== null && failed !== null ? (
        <p data-testid="compare-report-coverage-counts">
          {t('research.compareReportCoverageCounts', { included, failed })}
        </p>
      ) : (
        <p data-testid="compare-report-coverage-unavailable">
          {t('research.compareReportCoverageUnavailable')}
        </p>
      )}
    </div>
  )
}

function renderModelSection(
  compare: ResearchCompareJobView | undefined,
  detail: ResearchJob,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  const model = compare?.model
  const modelId = model?.model_id ?? detail.model_id
  return (
    <div className="space-y-0.5" data-testid="compare-report-model">
      <p className="font-medium">{t('research.compareReportModelTitle')}</p>
      {modelId ? (
        <>
          <p data-testid="compare-report-model-id">{modelId}</p>
          {model?.provider_id ? (
            <p className="text-muted-foreground">
              {t('research.compareReportModelProvider', { provider: model.provider_id })}
            </p>
          ) : null}
          {model?.execution_revision ? (
            <p className="text-muted-foreground">
              {t('research.compareReportModelRevision', {
                revision: model.execution_revision,
              })}
            </p>
          ) : null}
        </>
      ) : (
        <p data-testid="compare-report-model-empty">{t('research.compareReportModelEmpty')}</p>
      )}
    </div>
  )
}

function renderVerificationSection(
  verification: ResearchVerificationRecord | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  const status = typeof verification?.status === 'string' ? verification.status : null
  const statusKey = status !== null ? VERIFICATION_STATUS_KEYS[status] : undefined
  const findings = verification?.deterministic?.findings
  const executor = verification?.executor
  return (
    <div className="space-y-0.5" data-testid="compare-report-verification">
      <p className="font-medium">{t('research.compareReportVerificationTitle')}</p>
      <p
        data-testid="compare-report-verification-status"
        data-status={status ?? 'missing'}
        className={status === 'pass' ? undefined : 'text-amber-800'}
      >
        {statusKey !== undefined
          ? t(statusKey)
          : t('research.compareReportVerificationUnknown')}
      </p>
      {Array.isArray(findings) && findings.length > 0 && (
        <p className="text-muted-foreground" data-testid="compare-report-verification-findings">
          {t('research.compareReportVerificationFindings', { count: findings.length })}
        </p>
      )}
      {typeof executor === 'string' && executor.length > 0 && executor !== 'none' && (
        <p className="text-muted-foreground" data-testid="compare-report-verification-executor">
          {t('research.compareReportVerificationExecutor', { executor })}
        </p>
      )}
    </div>
  )
}
