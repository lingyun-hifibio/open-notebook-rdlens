'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useIsDesktop } from '@/lib/hooks/use-media-query'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources, useResearchNotes } from '@/lib/hooks/use-research'
import { countActiveJobs } from '@/lib/research/jobs'
import { useResearchJobsController } from './ResearchJobsProvider'
import { ResearchScopeSummary } from './ResearchScopeSummary'
import { ResearchGlobalModelBar } from './ResearchGlobalModelBar'
import { ExportSection } from './ExportSection'
import { ResearchActivityDialog } from './ResearchActivityDialog'

/**
 * RWV2-40（Fork #44）：/research 顶层 Header（五段目标 IA）。
 *
 * 段序（RFC §2）：Project | Current scope | Global model | Activity | Export。
 *
 * - Project：projectId 完整 DOM 文本 + 视觉截断（title/aria 可读全值）；
 * - Current scope：紧凑 Scope Summary（loading/error/retry 来自同 key
 *   source/note 查询——与 Workspace 共享 TanStack 缓存，不产生第二网络
 *   请求；Edit scope 经组合根 `onEditScopeAllStates`：退出 Source focus/
 *   最大化 → 回左栏编辑面 → 递增聚焦请求，本组件不持有第二选择权威）；
 * - Global model：ResearchGlobalModelBar（窄屏收进 popover）；
 * - Activity：打开 Dialog（RWV2-41 起为 Activity Center）；trigger 徽标
 *   只计非终态任务数（D9；cancelling 计入，cancelled/completed/failed
 *   不计——由 countActiveJobs 保证）；
 * - Export：ExportSection。
 *
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
  const isDesktop = useIsDesktop()
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
      {/* 段一：Project（完整 DOM 文本，视觉截断） */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('research.header.project')}
        </span>
        <span
          className="truncate text-sm font-semibold"
          data-testid="header-project"
          title={projectId}
        >
          {projectId}
        </span>
      </div>

      {/* 段二：Current scope（紧凑摘要 + Edit scope，无第二选择权威） */}
      <div className="flex min-w-0 items-center gap-2" data-testid="header-current-scope">
        <ResearchScopeSummary
          loading={scopeLoading}
          loadError={scopeError instanceof Error ? scopeError.message : scopeError === null ? null : String(scopeError)}
          onRetry={retryScope}
          onEditScope={onEditScopeAllStates}
        />
      </div>

      {/* 段三：Global model */}
      {isDesktop ? <ResearchGlobalModelBar /> : <ResearchGlobalModelBar layout="popover" />}

      {/* 段四：Activity（徽标只计非终态任务；RWV2-41） */}
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

      {/* 段五：Export */}
      <ExportSection />

      <ResearchActivityDialog
        open={activityOpen}
        onOpenChange={setActivityOpen}
        onCitationJump={onCitationJump}
      />
    </header>
  )
}
