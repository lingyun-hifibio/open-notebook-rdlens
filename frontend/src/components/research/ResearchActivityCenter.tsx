'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchJobsController } from './ResearchJobsProvider'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { partitionAndSortJobs } from '@/lib/research/jobs'
import { readStoredJobIds } from '@/lib/hooks/use-research-jobs'
import { ResearchJobCard } from './ResearchJobList'
import type { ResearchCitationDisplayItem, ResearchJob } from '@/lib/research/types'

/** History 客户端切片步长：Show more 每批揭示条数（H2：有界 DOM）。 */
export const HISTORY_SLICE_STEP = 50

/**
 * RWV2-41（Fork #46）：Activity Center 主体（Header Dialog 内）。
 *
 * - Dialog 打开即触发一次全量刷新（`refreshActivity`——权威对账宿主，
 *   用户显式查看历史 = 新鲜快照，R3-2）；provider 级只读，不打断在途
 *   Chat/Compare 流。
 * - Active / History 分组；History 客户端切片（初始 50 + Show more）。
 * - coverage 富化（H1/R3-1）：对当前可见切片内、尚未附着 `coverage` 段
 *   的 research_coverage 行调用 `ensureCoverageDetails`（控制器去重）；
 *   成本与用户所见成正比。
 * - 状态互不混同（R-04/H4）：loading / list-unavailable（旧后端离线降级，
 *   非破坏）/ list-error + Retry / action-error（可关闭）/ 双空空态 /
 *   purge（卡片移除）——由 listStatus、listError、actionError 与
 *   localStorage 兜底内容共同判定，数据只来自单一 Jobs controller
 *   （不建第二注册表）。
 * - Admin 只读：消费层省略 cancel/retry 回调（后端授权仍是最终权威）。
 */
export function ResearchActivityCenter({
  onCitationJump,
}: {
  /** Coverage/Compare 报告 Citation → 组合根：关闭 Dialog → 选源 → source focus */
  onCitationJump?: (citation: ResearchCitationDisplayItem) => void
}) {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const {
    jobs,
    isCreating,
    listStatus,
    listError,
    actionError,
    clearActionError,
    retryList,
    refreshActivity,
    ensureCoverageDetails,
    cancel,
    retryCoverage,
  } = useResearchJobsController()
  const { models } = useResearchGlobalModel()
  const [historyVisibleCount, setHistoryVisibleCount] = useState(HISTORY_SLICE_STEP)

  // Dialog 打开（本组件挂载）→ 全量刷新（对账 + 富化宿主）
  useEffect(() => {
    refreshActivity()
  }, [refreshActivity])

  const { active, history } = useMemo(() => partitionAndSortJobs(jobs), [jobs])
  const historyVisible = history.slice(0, historyVisibleCount)

  // model_id → 展示名（只读映射，不建第二模型源；未解析回退 raw id）
  const modelNameById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const model of models ?? []) {
      if (model.model_id) map[model.model_id] = model.display_name ?? model.model_id
    }
    return map
  }, [models])

  // coverage 富化目标：当前可见（Active 全量 + History 可见切片）内、
  // 尚未附着 coverage 段的 research_coverage 行
  const needyCoverageIds = useMemo(() => {
    const visible = [...active, ...historyVisible]
    return visible
      .filter(
        (job) =>
          job.job_type === 'research_coverage' &&
          job.coverage === undefined,
      )
      .map((job) => job.job_id)
  }, [active, historyVisible])
  const needyKey = needyCoverageIds.join(',')
  const lastNeedyKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (needyKey === '' || lastNeedyKeyRef.current === needyKey) return
    lastNeedyKeyRef.current = needyKey
    ensureCoverageDetails(needyCoverageIds)
  }, [ensureCoverageDetails, needyCoverageIds, needyKey])

  // 列表失败分级：localStorage 有兜底 id → 非破坏提示（旧后端/离线降级）；
  // 无兜底 → 真错误态 + Retry（R3-3：依 storage 是否存在判定，不新增状态）
  const recoveredFallback = jobs.length > 0 || readStoredJobIds(projectId).length > 0
  const listFailed = listStatus === 'error' && listError !== null

  const renderCardList = (items: readonly ResearchJob[]) =>
    items.map((job) => (
      <ResearchJobCard
        key={job.job_id}
        job={job}
        modelName={job.model_id !== null ? modelNameById[job.model_id] : undefined}
        onCancel={isAdminReadonly ? undefined : cancel}
        onCoverageRetry={isAdminReadonly ? undefined : retryCoverage}
        onCitationJump={onCitationJump}
      />
    ))

  const listHasContent = active.length > 0 || history.length > 0 || isCreating

  return (
    <div className="space-y-4 p-4" data-testid="activity-center">
      {isCreating && (
        <p className="text-sm text-muted-foreground">{t('research.compareCreating')}</p>
      )}

      {/* 初始加载：无任何内容时的 loading 骨架态 */}
      {listStatus === 'loading' && !listHasContent && (
        <p className="text-sm text-muted-foreground" data-testid="activity-loading">
          {t('research.activity.loadingActivity')}
        </p>
      )}

      {/* 列表失败：非破坏提示（有兜底内容） */}
      {listFailed && recoveredFallback && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-muted bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="activity-list-unavailable"
        >
          <span>{t('research.activity.listUnavailable')}</span>
          <Button type="button" variant="outline" size="sm" onClick={retryList}>
            {t('research.activity.listRetry')}
          </Button>
        </div>
      )}

      {/* 列表失败：无兜底内容 → 真错误态 + Retry */}
      {listFailed && !recoveredFallback && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2"
          data-testid="activity-list-error"
        >
          <p className="text-xs text-destructive">{t('research.activity.listFailed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={retryList} data-testid="activity-list-retry">
            {t('research.activity.listRetry')}
          </Button>
        </div>
      )}

      {/* 动作错误（cancel/coverage-retry），可关闭 */}
      {actionError !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          data-testid="activity-action-error"
        >
          <span className="min-w-0 flex-1">{actionError}</span>
          <Button type="button" variant="ghost" size="sm" onClick={clearActionError}>
            {t('research.activity.actionErrorDismiss')}
          </Button>
        </div>
      )}

      {/* 双空空态 */}
      {!listHasContent && listStatus === 'ready' && (
        <p className="text-sm text-muted-foreground" data-testid="activity-empty">
          {t('research.jobsEmpty')}
        </p>
      )}

      {/* Active 段：非终态（徽标同口径） */}
      {active.length > 0 && (
        <section aria-labelledby="activity-active-heading" data-testid="activity-active-section">
          <h3
            id="activity-active-heading"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t('research.activity.activeSection')}
            <span className="ml-1.5 font-normal normal-case">({active.length})</span>
          </h3>
          <div className="space-y-3">{renderCardList(active)}</div>
        </section>
      )}

      {/* 有 History 无 Active 时的占位提示（非错误态） */}
      {active.length === 0 && history.length > 0 && listStatus === 'ready' && (
        <p className="text-sm text-muted-foreground">{t('research.activity.activeEmpty')}</p>
      )}

      {/* History 段：终态（可达、不计徽标；客户端切片） */}
      {history.length > 0 && (
        <section aria-labelledby="activity-history-heading" data-testid="activity-history-section">
          <h3
            id="activity-history-heading"
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {t('research.activity.historySection')}
          </h3>
          <div className="space-y-3">{renderCardList(historyVisible)}</div>
          {history.length > historyVisibleCount && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setHistoryVisibleCount((count) => count + HISTORY_SLICE_STEP)}
              data-testid="activity-history-show-more"
            >
              {t('research.activity.historyShowMore')}
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
