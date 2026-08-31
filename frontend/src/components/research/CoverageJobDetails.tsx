'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { ResearchCitationList } from './ResearchCitationList'
import {
  coverageVerificationStatus,
  isCoverageOutcomeUnknown,
  isCoverageReportAvailable,
  targetCoverageCounts,
} from '@/lib/research/coverage'
import { jobProgressPercent } from '@/lib/research/jobs'
import { useCoverageReport } from '@/lib/hooks/use-coverage-report'
import type {
  ResearchCitationDisplayItem,
  ResearchCoverageCitation,
  ResearchJob,
} from '@/lib/research/types'

/**
 * COV-09：Coverage Job 详情（§12.3）——Chat 任务卡与 Jobs 页共用。
 *
 * 展示 stage/progress、requested/analyzed/failed、逐 Source 状态与
 * 固定 revision snapshot、verification_status（verified/critic_issues/
 * degraded）、partial/failed/outcome_unknown 文字状态；outcome_unknown
 * 给人工提示 + 显式重试（确认计费风险，§12.2）；completed 后读取
 * 最终报告与规范化 Citation（§12.1）。
 *
 * 所有状态都有文字表达，不只依赖颜色（验收标准）；固定 snapshot 来自
 * 提交时的 Manifest（当前选择变化不影响历史任务，§12.3）。
 */

const STAGE_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  running: 'secondary',
  failed: 'destructive',
}

const VERIFICATION_KEYS: Record<string, string> = {
  verified: 'research.coverage.verificationVerified',
  critic_issues: 'research.coverage.verificationCriticIssues',
  degraded: 'research.coverage.verificationDegraded',
}

const COVERAGE_STATUS_KEYS: Record<string, string> = {
  complete: 'research.coverage.status.complete',
  partial: 'research.coverage.status.partial',
  failed: 'research.coverage.status.failed',
}

function toDisplayItem(citation: ResearchCoverageCitation): ResearchCitationDisplayItem {
  const snapshot = citation.snapshot
  const pageIdx = typeof snapshot.page_idx === 'number' ? snapshot.page_idx : null
  return {
    citation_id: citation.canonical_citation_id,
    claim: typeof snapshot.claim === 'string' ? snapshot.claim : '',
    doc_id: typeof snapshot.doc_id === 'string' ? snapshot.doc_id : '',
    page_idx: pageIdx,
    confidence:
      typeof snapshot.confidence === 'string' || typeof snapshot.confidence === 'number'
        ? snapshot.confidence
        : undefined,
  }
}

export interface CoverageJobDetailsProps {
  /** 服务端 GET 快照；undefined = 已受理但尚未回源（展示同步中占位） */
  job: ResearchJob | undefined
  onRetry: (jobId: string) => Promise<boolean>
  onCitationJump?: (citation: ResearchCitationDisplayItem) => void
}

export function CoverageJobDetails({ job, onRetry, onCitationJump }: CoverageJobDetailsProps) {
  const { t } = useTranslation()
  const [retryError, setRetryError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  // hooks 必须在任何条件返回前调用（rules of hooks）
  const reportAvailable = job !== undefined && isCoverageReportAvailable(job)
  const { report, error: reportError, loading: reportLoading } = useCoverageReport(
    job?.project_id ?? '',
    reportAvailable ? job.job_id : null,
    reportAvailable,
  )

  if (!job?.coverage) {
    return (
      <div className="rounded-lg border px-3 py-2 text-xs text-muted-foreground" data-testid="coverage-syncing">
        {t('research.coverage.syncing')}
      </div>
    )
  }

  const view = job.coverage
  const counts = targetCoverageCounts(job)
  const verification = coverageVerificationStatus(view)
  const outcomeUnknown = isCoverageOutcomeUnknown(job)

  const confirmRetry = async (): Promise<void> => {
    setRetryError(null)
    setRetrying(true)
    const ok = await onRetry(job.job_id)
    setRetrying(false)
    if (!ok) setRetryError(t('research.coverage.retryFailed'))
  }

  const stages = view.stages ?? []
  const manifestEntries = view.manifest?.entries ?? []
  const targetResults = view.target_results ?? []

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="coverage-job-details">
      {/* 状态/阶段/进度 */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={job.status === 'failed' ? 'destructive' : 'secondary'} data-testid="coverage-status">
          {job.status}
        </Badge>
        {job.stage && (
          <span className="text-xs text-muted-foreground" data-testid="coverage-stage">
            {t('research.jobsStage')}: {job.stage}
          </span>
        )}
      </div>
      {(job.status === 'queued' || job.status === 'running' || job.status === 'cancelling') && (
        <div className="space-y-1">
          <Progress value={jobProgressPercent(job)} data-testid="coverage-progress" />
          <p className="text-xs text-muted-foreground">{jobProgressPercent(job)}%</p>
        </div>
      )}
      {stages.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="coverage-stages">
          {stages.map((stage) => (
            <Badge
              key={stage.name}
              variant={STAGE_STATUS_VARIANT[stage.status] ?? 'outline'}
              className="text-[10px]"
              data-testid={`coverage-stage-${stage.name}`}
            >
              {stage.name}
            </Badge>
          ))}
        </div>
      )}

      {/* 目标覆盖计数（requested = analyzed + failed，§6.3） */}
      {counts && (
        <div className="space-y-1 text-xs" data-testid="coverage-target-coverage">
          <p className="font-medium">{t('research.coverage.targetCoverage')}</p>
          <p className="text-muted-foreground">
            {t('research.coverage.requested')}: {counts.requested} ·{' '}
            {t('research.coverage.analyzed')}: {counts.analyzed} ·{' '}
            {t('research.coverage.failed')}: {counts.failed}
          </p>
          <Badge variant={counts.status === 'failed' ? 'destructive' : 'secondary'}>
            {t(COVERAGE_STATUS_KEYS[counts.status] ?? counts.status)}
          </Badge>
        </div>
      )}

      {/* 逐文档状态（含失败原因码） */}
      {targetResults.length > 0 && (
        <div className="space-y-1" data-testid="coverage-target-results">
          <p className="text-xs font-medium">{t('research.coverage.perDocument')}</p>
          <ul className="space-y-1 text-xs">
            {targetResults.map((result) => (
              <li
                key={`${result.document_id}:${result.document_revision}`}
                className="flex flex-wrap items-center gap-2 text-muted-foreground"
                data-testid={`coverage-target-${result.document_id}`}
              >
                <span className="min-w-0 flex-1 truncate">{result.document_id}</span>
                <span className="shrink-0">{t('research.coverage.revision')}: {result.document_revision}</span>
                <Badge variant={result.status === 'failed' ? 'destructive' : 'default'}>
                  {result.status}
                </Badge>
                {result.failure_code && (
                  <code className="shrink-0 text-[10px]">{result.failure_code}</code>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 最终校验状态（§6.4） */}
      {verification !== null && (
        <div className="flex items-center gap-2 text-xs" data-testid="coverage-verification">
          <Badge
            variant={verification === 'verified' ? 'default' : verification === 'degraded' ? 'secondary' : 'outline'}
          >
            {t(VERIFICATION_KEYS[verification])}
          </Badge>
          {verification === 'critic_issues' && Array.isArray(view.critic_issues) && (
            <span className="text-muted-foreground">
              {t('research.coverage.criticIssuesCount', { count: view.critic_issues.length })}
            </span>
          )}
        </div>
      )}

      {/* outcome_unknown：人工提示 + 显式重试（§12.2） */}
      {outcomeUnknown && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="coverage-outcome-unknown">
          <p className="font-medium text-amber-700">{t('research.coverage.outcomeUnknown')}</p>
          <p className="text-muted-foreground">{t('research.coverage.outcomeUnknownDetail')}</p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" data-testid="coverage-retry-trigger">
                {t('research.coverage.retry')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('research.coverage.retryTitle')}</AlertDialogTitle>
                <AlertDialogDescription data-testid="coverage-retry-description">
                  {t('research.coverage.retryBillingRisk')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {retryError && <p className="text-xs text-destructive">{retryError}</p>}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={retrying}>{t('research.coverage.retryCancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void confirmRetry()} disabled={retrying} data-testid="coverage-retry-confirm">
                  {retrying ? t('research.coverage.retrying') : t('research.coverage.retryConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {/* 提交时固定的 Source/revision snapshot（§12.3：选择变化不影响历史） */}
      {manifestEntries.length > 0 && (
        <div className="space-y-1" data-testid="coverage-manifest">
          <p className="text-xs font-medium">{t('research.coverage.fixedSnapshot')}</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {manifestEntries.map((entry) => (
              <li key={entry.source_id} className="flex flex-wrap gap-2" data-testid={`coverage-manifest-${entry.source_id}`}>
                <span className="min-w-0 flex-1 truncate">{entry.source_id}</span>
                <span className="shrink-0">{t('research.coverage.revision')}: {entry.document_revision}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 最终报告 + 规范化 Citation（§12.1：render_report 完成后只读） */}
      {reportAvailable && (
        <div className="space-y-2 border-t pt-2" data-testid="coverage-report">
          <p className="text-xs font-medium">{t('research.coverage.finalReport')}</p>
          {reportLoading && <p className="text-xs text-muted-foreground">{t('research.loading')}</p>}
          {reportError && <p className="text-xs text-destructive">{reportError}</p>}
          {report && (
            <>
              <div className="text-sm">
                <MarkdownRenderer>{report.report.markdown}</MarkdownRenderer>
              </div>
              <ResearchCitationList
                citations={report.citations.map(toDisplayItem)}
                onCitationClick={onCitationJump}
              />
              {report.verification_status && (
                <p className="text-xs text-muted-foreground">
                  {t('research.coverage.verificationLabel')}:{' '}
                  {t(VERIFICATION_KEYS[report.verification_status] ?? report.verification_status)}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
