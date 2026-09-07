'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  canCancelJob,
  jobProgressPercent,
  jobStatusLabelKey,
  jobTypeLabelKey,
} from '@/lib/research/jobs'
import { CoverageJobDetails } from './CoverageJobDetails'
import { CompareReportView } from './CompareReportView'
import type { ResearchCitationDisplayItem, ResearchJob } from '@/lib/research/types'

/** 展示用时间：当前 i18n 语言下的绝对时间；非法值回退原文。 */
function formatJobTime(iso: string, lang: string | undefined): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(lang ?? 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return iso
  }
}

/**
 * 单张 Job 卡（UI-03 契约 §10；RWV2-41 Activity Center 复用）。
 *
 * 卡片是服务端 GET 快照的展示：任务导向英文状态/类型、创建时间、模型
 * （名称可解析时用名称，否则回退 model_id）、coverage 附着后的 scope、
 * 阶段/进度、失败信息与 result 引用。
 *
 * RWV2-40（Fork #44）：Admin 只读会话不显示任何写入 affordance——
 * `onCancel`/`onCoverageRetry` 可选，**仅当回调存在时渲染**对应按钮；
 * 删除历史上 `?? (async () => false)` 假回调——静默的"假成功"会掩盖
 * 未接线。取消必须显式且仅 queued/running 可取消。
 *
 * COV-09/RWV2-41：research_coverage Job 渲染 CoverageJobDetails
 * （stage/progress、requested/analyzed/failed、逐文档状态、
 * verification_status、outcome_unknown 人工重试、固定 snapshot 与最终
 * 报告，§12.3）；coverage 段未附着（列表行/富化前）时该组件显示同步占位，
 * 富化 merge 后自动升级。
 */
export function ResearchJobCard({
  job,
  modelName,
  onCancel,
  onCoverageRetry,
  onCitationJump,
}: {
  job: ResearchJob
  /** 已解析的模型展示名（未提供时回退 model_id） */
  modelName?: string
  onCancel?: (jobId: string) => void
  onCoverageRetry?: (jobId: string) => Promise<boolean>
  onCitationJump?: (citation: ResearchCitationDisplayItem) => void
}) {
  const { t, i18n } = useTranslation()
  const typeKey = jobTypeLabelKey(job.job_type)
  const isCoverage = job.job_type === 'research_coverage'
  const scopeLabel =
    isCoverage && job.coverage?.synthesis_scope === 'all_selected'
      ? t('research.coverage.scopeAllSelected')
      : null

  return (
    <div
      data-testid={`job-${job.job_id}`}
      className="space-y-2 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" data-testid="job-type">
            {typeKey.startsWith('research.activity.type.')
              ? t(typeKey)
              : job.job_type}
          </Badge>
          <Badge
            data-testid="job-status"
            variant={job.status === 'failed' ? 'destructive' : job.status === 'completed' ? 'default' : 'secondary'}
          >
            {t(jobStatusLabelKey(job.status))}
          </Badge>
          {job.retry_count > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('research.jobsRetries')}: {job.retry_count}
            </span>
          )}
        </div>
        {onCancel !== undefined && canCancelJob(job.status) && (
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

      {/* RWV2-41：meta 行（time/model/scope-when-supplied，AC3） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <time dateTime={job.created_at} data-testid="job-created">
          {t('research.activity.createdLabel')}: {formatJobTime(job.created_at, i18n?.language)}
        </time>
        {job.model_id !== null && (
          <span data-testid="job-model">
            {t('research.activity.modelLabel')}: {modelName ?? job.model_id}
          </span>
        )}
        {scopeLabel !== null && (
          <span data-testid="job-scope">
            {t('research.activity.scopeLabel')}: {scopeLabel}
          </span>
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
        ) : !isCoverage ? (
          <div className="text-xs text-muted-foreground">
            {t('research.jobsResultRef')}: <code>{job.result_ref}</code>
          </div>
        ) : null
      )}

      {(isCoverage || job.coverage !== undefined) && (
        <CoverageJobDetails
          job={job}
          onRetry={onCoverageRetry}
          onCitationJump={onCitationJump}
        />
      )}
    </div>
  )
}

/**
 * Job 列表（UI-03，契约 §10；RWV2-40 兼容入口）。每张卡片复用
 * `ResearchJobCard`。Activity Center（RWV2-41）经切片组合该卡片。
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
  onCancel?: (jobId: string) => void
  onCoverageRetry?: (jobId: string) => Promise<boolean>
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
        <ResearchJobCard
          key={job.job_id}
          job={job}
          onCancel={onCancel}
          onCoverageRetry={onCoverageRetry}
          onCitationJump={onCitationJump}
        />
      ))}
    </div>
  )
}
