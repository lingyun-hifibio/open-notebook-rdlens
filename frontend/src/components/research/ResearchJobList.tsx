'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { canCancelJob, jobProgressPercent } from '@/lib/research/jobs'
import { CoverageJobDetails } from './CoverageJobDetails'
import { CompareReportView } from './CompareReportView'
import type { ResearchCitationDisplayItem, ResearchJob } from '@/lib/research/types'

/**
 * Job 列表（UI-03，契约 §10）。每张卡片是服务端 GET 快照的展示：
 * 状态/阶段/进度/结果引用（result_ref，正文不经 Job API 返回）。
 * 取消必须显式且仅 queued/running 可取消；终态（含 cancelling）无取消按钮。
 *
 * COV-09：research_coverage Job 额外展示 CoverageJobDetails（stage/
 * progress、requested/analyzed/failed、逐文档状态、verification_status、
 * outcome_unknown 人工重试、固定 snapshot 与最终报告，§12.3）。
 */
export function ResearchJobList({
  jobs,
  isCreating,
  onCancel,
  onCoverageRetry,
  onCitationJump,
}: {
  jobs: ResearchJob[]
  isCreating: boolean
  onCancel: (jobId: string) => void
  /** COV-09：outcome_unknown 人工重试（§12.2） */
  onCoverageRetry?: (jobId: string) => Promise<boolean>
  /** COV-09：报告 Citation 跳转 */
  onCitationJump?: (citation: ResearchCitationDisplayItem) => void
}) {
  const { t } = useTranslation()

  if (jobs.length === 0 && !isCreating) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t('research.jobsEmpty')}
      </div>
    )
  }

  return (
    <div className="space-y-3 p-4">
      {isCreating && (
        <p className="text-sm text-muted-foreground">{t('research.compareCreating')}</p>
      )}
      {jobs.map((job) => (
        <div
          key={job.job_id}
          data-testid={`job-${job.job_id}`}
          className="space-y-2 rounded-lg border p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{job.job_type}</Badge>
              <Badge
                data-testid="job-status"
                variant={job.status === 'failed' ? 'destructive' : job.status === 'completed' ? 'default' : 'secondary'}
              >
                {job.status}
              </Badge>
              {job.retry_count > 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('research.jobsRetries')}: {job.retry_count}
                </span>
              )}
            </div>
            {canCancelJob(job.status) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCancel(job.job_id)}
                data-testid={`cancel-${job.job_id}`}
              >
                {job.status === 'cancelling' ? t('research.jobsCancelling') : t('research.jobsCancel')}
              </Button>
            )}
          </div>

          {(job.status === 'running' || job.status === 'queued' || job.status === 'cancelling') && (
            <div className="space-y-1">
              {job.stage && (
                <p className="text-xs text-muted-foreground">
                  {t('research.jobsStage')}: {job.stage}
                </p>
              )}
              <Progress value={jobProgressPercent(job)} data-testid="job-progress" />
              <p className="text-xs text-muted-foreground">
                {jobProgressPercent(job)}%
              </p>
            </div>
          )}

          {job.status === 'failed' && job.last_error && (
            <p className="text-xs text-destructive">{job.last_error}</p>
          )}

          {job.status === 'completed' && job.result_ref && (
            job.job_type === 'deep_compare' ? (
              // #307：compare 完成后提供报告查看入口（替代裸 result_ref 文本）
              <CompareReportView job={job} onCitationJump={onCitationJump} />
            ) : (
              <div className="text-xs text-muted-foreground">
                {t('research.jobsResultRef')}: <code>{job.result_ref}</code>
              </div>
            )
          )}

          {job.coverage !== undefined && (
            <CoverageJobDetails
              job={job}
              onRetry={onCoverageRetry ?? (async () => false)}
              onCitationJump={onCitationJump}
            />
          )}
        </div>
      ))}
    </div>
  )
}
