'use client'

import { useCallback } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { ResearchActivityCenter } from './ResearchActivityCenter'
import { resolveCitationSource } from './citation-utils'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ResearchCitation } from '@/lib/types/research'

/**
 * RWV2-40/41（Fork #44/#46）：Header 的 Activity Center Dialog。
 *
 * RWV2-40 把 Jobs 从主工作区动作迁到 Header 的 Activity 兼容壳；
 * RWV2-41 起壳内承载完整 Activity Center（徽标计数在 trigger、
 * 分组/切片/富化/失败恢复在 ResearchActivityCenter）。Jobs 数据来自
 * ResearchJobsProvider（唯一实例），与 Chat coverage 任务卡共享同一
 * controller 与 3s 轮询——不建第二注册表。
 *
 * 容量/焦点契约：Dialog 限高 + 内部滚动，标题/描述完整，关闭后焦点回
 * Activity trigger（Dialog 自身焦点管理）。Admin 会话在**消费层**省略
 * cancel/retry callback（ActivityCenter 按 isAdminReadonly 不给卡片传），
 * 按钮缺省不渲染；后端授权仍是最终权威。
 *
 * 报告 Citation：Activity 内 Coverage/Compare 报告给的是
 * ResearchCitationDisplayItem（doc_id 维度）——本组件经同 key sources
 * 查询解析到项目内 source_id 后调 `onCitationJump(sourceId, pageIdx)`
 * （组合根关闭 Dialog → 选中来源 → source focus + 高亮）。解析失败则
 * 不跳转（CitationCard 已按失效降级展示原文）。
 */
export function ResearchActivityDialog({
  open,
  onOpenChange,
  onCitationJump,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 已解析 source_id + 0-based page_idx → 组合根 */
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  // R8-1a：经同 key 查询共享缓存解析 Citation（Header/Workspace 不双拉）
  const sourcesQuery = useResearchSources(projectId)

  const handleCitationJump = useCallback((citation: ResearchCitationDisplayItem): void => {
    // #307 约定：展示条目经 resolveCitationSource 解析到项目内来源
    // （citation.doc_id 是 document_id，不能直接用作来源选择键）
    const source = resolveCitationSource(
      sourcesQuery.data?.items,
      citation as unknown as ResearchCitation,
    )
    if (!source) return
    onOpenChange(false)
    onCitationJump?.(source.source_id, citation.page_idx)
  }, [onCitationJump, onOpenChange, sourcesQuery.data?.items])

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
          <ResearchActivityCenter onCitationJump={handleCitationJump} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
