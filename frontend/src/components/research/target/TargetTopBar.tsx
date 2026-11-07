'use client'

import { FolderOpen, ListChecks } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { ResearchGlobalModelBar } from '../ResearchGlobalModelBar'
import type { TargetRightPaneKind } from './target-types'

/**
 * UI-02 顶栏（W1 #1104；UI 规格 v1 §5.2）。
 *
 * - 高度 72px（§3.2），固定不随内容滚动；
 * - 项目名是**唯一**项目身份（D-UI-01）：宿主未下发时回退通用「Research」
 *   且不伪造；单行省略 + 完整 `aria-label`（I18N-04）；
 * - 已确认模型复用 `ResearchGlobalModelBar`（BEH-08 模型诚实，唯一模型入口）；
 * - 任务入口显示未完成计数（`aria-label` 含计数，徽标本身 aria-hidden）；
 * - 成果入口打开右栏成果目录；
 * - 1024–1279 隐藏非关键标签文字（`hidden xl:inline`）但保留可访问名。
 */
export function TargetTopBar({
  projectName,
  activeJobCount,
  rightPane,
  onOpenPane,
}: {
  /** 宿主项目可读名；null = 宿主未提供 → 通用「Research」 */
  projectName: string | null
  /** 未完成研究任务数（来自唯一 Jobs 控制器） */
  activeJobCount: number
  /** 当前打开的右栏面板（驱动 aria-expanded，不伪造展开态） */
  rightPane: TargetRightPaneKind | null
  /** 打开右栏面板；第二参数为焦点返回用触发元素 */
  onOpenPane: (kind: TargetRightPaneKind, trigger: HTMLElement) => void
}) {
  const { t } = useTranslation()
  const fallback = t('research.target.topbar.projectFallback')
  const displayName = projectName !== null && projectName.trim().length > 0
    ? projectName
    : fallback
  const projectAria =
    projectName !== null && projectName.trim().length > 0
      ? t('research.target.topbar.projectLabel', { name: projectName })
      : fallback

  return (
    <header
      className="flex h-[72px] shrink-0 items-center gap-4 border-b px-7 max-xl:px-[18px]"
      style={{
        borderColor: 'var(--rdlens-line)',
        backgroundColor: 'var(--rdlens-paper)',
      }}
      data-testid="rdlens-target-topbar"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: 'var(--rdlens-evidence)' }}
        />
        <h1
          className="rdlens-serif min-w-0 truncate text-sm font-semibold"
          title={displayName}
          aria-label={projectAria}
          data-testid="rdlens-target-project-name"
          data-project-source={projectName === null || projectName.trim().length === 0 ? 'fallback' : 'host'}
        >
          {displayName}
        </h1>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        {/* 已确认模型（唯一模型入口；外部/本地/不可用状态由该控件自身呈现） */}
        <ResearchGlobalModelBar />

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[38px] gap-1.5"
          data-testid="rdlens-target-tasks-trigger"
          aria-label={
            activeJobCount > 0
              ? t('research.target.topbar.tasksActive', { count: activeJobCount })
              : t('research.target.topbar.tasks')
          }
          aria-expanded={rightPane === 'tasks'}
          // A11Y-03：仅在面板真实渲染时输出 aria-controls（关闭时不悬空）
          aria-controls={rightPane !== null ? 'rdlens-target-right-pane' : undefined}
          onClick={(event) => onOpenPane('tasks', event.currentTarget)}
        >
          <ListChecks aria-hidden="true" className="h-4 w-4" />
          <span className="max-xl:hidden">{t('research.target.topbar.tasks')}</span>
          {activeJobCount > 0 && (
            <span
              aria-hidden="true"
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[11px] font-semibold"
              style={{
                backgroundColor: 'var(--rdlens-evidence)',
                color: 'var(--rdlens-on-evidence)',
              }}
              data-testid="rdlens-target-tasks-badge"
            >
              {activeJobCount}
            </span>
          )}
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[38px] gap-1.5"
          data-testid="rdlens-target-outcomes-trigger"
          aria-label={t('research.target.topbar.outcomes')}
          aria-expanded={rightPane === 'outcomes'}
          aria-controls={rightPane !== null ? 'rdlens-target-right-pane' : undefined}
          onClick={(event) => onOpenPane('outcomes', event.currentTarget)}
        >
          <FolderOpen aria-hidden="true" className="h-4 w-4" />
          <span className="max-xl:hidden">{t('research.target.topbar.outcomes')}</span>
        </Button>
      </div>
    </header>
  )
}
