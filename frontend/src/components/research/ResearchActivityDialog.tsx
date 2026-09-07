'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchJobsController } from './ResearchJobsProvider'
import { ResearchJobList } from './ResearchJobList'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'

/**
 * RWV2-40（Fork #44）：Header 的 Activity 兼容壳（RWV2-41 前的最小容器）。
 *
 * 目标 IA 把 Jobs 从主工作区动作迁到 Header 的 Activity；本 Dialog 只
 * 包裹现有 ResearchJobList，不新增徽标/分页/恢复状态。Jobs 数据来自
 * ResearchJobsProvider（唯一实例化 useResearchJobs，与 Chat coverage
 * 任务卡共享同一 controller 与 3s 轮询）。
 *
 * - 容量/a11y：DialogContent 限定视口高度，列表区内部滚动；标题/描述
 *   完整；关闭后焦点回 trigger（Dialog 自身焦点管理）。
 * - 权限：cancel/retry 在**消费层**按 isAdminReadonly 省略——JobList 只
 *   在收到 callback 时渲染按钮（onCancel/onCoverageRetry 可选）；后端
 *   授权仍是最终权威。
 * - 报告 Citation：关闭 Dialog 后经组合根路由到 source focus + 高亮。
 */
export function ResearchActivityDialog({
  open,
  onOpenChange,
  onCitationJump,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const { isAdminReadonly } = useResearchWorkspace()
  const { jobs, isCreating, cancel, retryCoverage } = useResearchJobsController()

  const handleCitationJump = (citation: ResearchCitationDisplayItem): void => {
    onOpenChange(false)
    onCitationJump?.(citation.source_id, citation.page_idx)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[80vh] flex-col gap-0 p-0"
        data-testid="activity-dialog"
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{t('research.activity.title')}</DialogTitle>
          <DialogDescription>{t('research.activity.description')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ResearchJobList
            jobs={jobs}
            isCreating={isCreating}
            onCancel={isAdminReadonly ? undefined : cancel}
            onCoverageRetry={isAdminReadonly ? undefined : retryCoverage}
            onCitationJump={handleCitationJump}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
