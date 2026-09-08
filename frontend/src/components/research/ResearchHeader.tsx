'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources, useResearchNotes } from '@/lib/hooks/use-research'
import { countActiveJobs } from '@/lib/research/jobs'
import { useResearchJobsController } from './ResearchJobsProvider'
import { ResearchScopeSummary } from './ResearchScopeSummary'
import { ResearchGlobalModelBar } from './ResearchGlobalModelBar'
import { ExportSection } from './ExportSection'
import { ResearchActivityDialog } from './ResearchActivityDialog'

/**
 * RWV2-40（Fork #44）：/research 顶层 Header。
 * RWV2-UIOPT-A（fork #57）：收敛为「左侧上下文 + 右侧操作」结构——
 *
 * - 左侧：Current scope（紧凑 Scope Summary；loading/error/retry 来自同 key
 *   source/note 查询——与 Workspace 共享 TanStack 缓存，不产生第二网络
 *   请求；Edit scope 经组合根 `onEditScopeAllStates`：退出 Source focus/
 *   最大化 → 回左栏编辑面 → 递增聚焦请求，本组件不持有第二选择权威）；
 * - 右侧（`ml-auto` 聚合，桌面 ≥1024px 单行）：Global model（紧凑
 *   Trigger + Popover）| Activity（RWV2-41 Activity Center；trigger 徽标
 *   只计非终态任务数——由 countActiveJobs 保证）| Export；
 * - 技术 Project ID 段删除（RWV2-UIOPT-A）：可读项目名称仍由 RDLens 父
 *   页面展示，iframe 内不再出现 `Project usr_...`；
 * - Header 统一负责外层 `border-b` 与 padding（Scope Summary 不再自带
 *   边框/外层 padding，全 Header 只有一个视觉边界）。
 *
 * 小于桌面断点允许受控折行（flex-wrap），不产生水平滚动或操作顺序变化。
 * 本组件常驻页面顶部（含 Source focus 态），不依赖 /research 布局状态。
 */
export function ResearchHeader({
  onEditScopeAllStates,
  onCitationJump,
}: {
  /** Edit scope → 组合根统一链路（退出 focus/最大化 → 左栏编辑面） */
  onEditScopeAllStates: () => void
  /** Activity 报告 Citation → 组合根：关闭 Dialog → 选源 → source focus */
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const { jobs } = useResearchJobsController()
  const [activityOpen, setActivityOpen] = useState(false)
  const activeCount = countActiveJobs(jobs)

  // RWV2-43（fork #47，评审 R2-2/C-H2）：非终态计数的隐藏 live region。
  // - 3s 轮询下计数频繁变化，裸 aria-live 会刷屏 → 只在文本变化时写；
  // - Dialog 打开时不写（Dialog 自身是显式查看目的地，避免与焦点冲突）；
  // - Dialog 关闭转移时无条件重同步当前计数（等价文本不重复播报）→
  //   修复「Dialog 打开期间计数变化被抑制后关闭永不播报」的陈旧缺陷。
  const [announcement, setAnnouncement] = useState('')
  const lastAnnouncedRef = useRef<string | null>(null)
  useEffect(() => {
    if (activityOpen) return
    const text = activeCount > 0
      ? t('research.activity.badgeActive', { count: activeCount })
      : ''
    if (text === lastAnnouncedRef.current) return
    lastAnnouncedRef.current = text
    setAnnouncement(text)
  }, [activeCount, activityOpen, t])

  // Current scope 段的 loading/error/retry：与 Workspace 同 key 共享缓存
  // （TanStack 去重），Header 只观察状态，不新建查询权威。
  const sourcesQuery = useResearchSources(projectId)
  const notesQuery = useResearchNotes(projectId)
  const scopeLoading = sourcesQuery.isLoading || notesQuery.isLoading
  const scopeError = sourcesQuery.error ?? notesQuery.error
  const retryScope = useCallback(() => {
    void sourcesQuery.refetch()
    void notesQuery.refetch()
  }, [notesQuery, sourcesQuery])

  return (
    <header
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2"
      data-testid="research-header"
    >
      {/* 左侧：Current scope（紧凑摘要 + Edit scope，无第二选择权威） */}
      <div className="flex min-w-0 items-center gap-2" data-testid="header-current-scope">
        <ResearchScopeSummary
          loading={scopeLoading}
          loadError={scopeError instanceof Error ? scopeError.message : scopeError === null ? null : String(scopeError)}
          onRetry={retryScope}
          onEditScope={onEditScopeAllStates}
        />
      </div>

      {/* 右侧操作组：Global model | Activity | Export（桌面单行聚合到行尾） */}
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2" data-testid="header-actions">
        <ResearchGlobalModelBar />

        {/* Activity（徽标只计非终态任务；RWV2-41） */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="activity-trigger"
          aria-label={
            activeCount > 0
              ? t('research.activity.badgeActive', { count: activeCount })
              : t('research.activity.title')
          }
          onClick={() => setActivityOpen(true)}
        >
          {t('research.activity.title')}
          {activeCount > 0 && (
            <span
              className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
              data-testid="activity-badge"
              aria-hidden="true"
            >
              {activeCount}
            </span>
          )}
        </Button>

        {/* RWV2-43：非终态计数隐藏播报（Dialog 打开时不写；关闭重同步） */}
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          data-testid="activity-live-region"
        >
          {announcement}
        </span>

        <ExportSection />
      </div>

      <ResearchActivityDialog
        open={activityOpen}
        onOpenChange={setActivityOpen}
        onCitationJump={onCitationJump}
      />
    </header>
  )
}
