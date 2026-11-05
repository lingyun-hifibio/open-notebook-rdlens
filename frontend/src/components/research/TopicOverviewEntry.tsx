'use client'

/**
 * Issue #1016（D1-G）§2.9：中央对话区「项目开始位置」的主题概览入口卡。
 *
 * 纪律（计划 §2.9 / NORMATIVE 19-20 / F-01/F-02）：
 * - **能力位 fail-closed**：只有 `capabilities.topic_overview === true`
 *   （`useResearchTopicOverviewCapability` 内部严格 `=== true`）才渲染；
 *   false/缺失/非法 → 返回 null，既有 research-chat UI 零变化。
 * - 入口卡是 `ResearchChatPanel` 上方的**兄弟卡片**（`shrink-0 border-b`），
 *   不覆盖、不拦截 Chat 输入/发送与打开原文，也不新增主区动作/pane/路由。
 * - 状态：无概览 → 生成；已有 → 查看 + 范围摘要与时间；生成中 → 禁用并
 *   显示进行中；读失败 → 内联错误 + **手动**重试（不自动重试）；受限 →
 *   仍可打开（Dialog 显示受限占位）。
 * - 资料变化提示只**提示**（新增/版本变化/已退役计数 + 范围日期），不自动
 *   更新概览、不修改 GET 内容。
 */

import { useMemo } from 'react'
import { useIsMutating } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchSources } from '@/lib/hooks/use-research'
import {
  topicOverviewGenerateMutationKey,
  useResearchTopicOverview,
  useResearchTopicOverviewCapability,
} from '@/lib/hooks/use-research-topic-overview'
import { topicOverviewSourceChanges } from '@/lib/research/topic-overview'
import { extractResearchErrorCode, userErrorMessageKey } from '@/lib/research/errors'
import { formatResearchTimestamp } from '@/lib/research/format'
import type { TopicOverviewWire } from '@/lib/research/topic-overview'

export interface TopicOverviewEntryProps {
  projectId: string
  onOpen: () => void
}

/** 重新导出生成 mutation key（与 hook 单一来源；供入口测试断言一致性）。 */
export { topicOverviewGenerateMutationKey }

/** wire scope.mode → 既有 i18n 模式标签（未知值回落通用 Scope）。 */
const SCOPE_MODE_KEYS: Record<string, string> = {
  all: 'research.topicOverview.scopeMode.all',
  selected: 'research.topicOverview.scopeMode.selected',
  single: 'research.topicOverview.scopeMode.single',
}

function scopeModeLabelKey(mode: string | null | undefined): string {
  if (mode === null || mode === undefined) return 'research.topicOverview.scopeMode.unknown'
  return SCOPE_MODE_KEYS[mode] ?? 'research.topicOverview.scopeMode.unknown'
}

export function TopicOverviewEntry({ projectId, onOpen }: TopicOverviewEntryProps) {
  const { t } = useTranslation()
  // fail-closed：能力位缺失/false/非法一律 false（NORMATIVE 19）。
  const capability = useResearchTopicOverviewCapability(projectId)
  const overviewQuery = useResearchTopicOverview(projectId, { enabled: capability })
  const sourcesQuery = useResearchSources(projectId)
  const generatingCount = useIsMutating({
    mutationKey: topicOverviewGenerateMutationKey(projectId),
  })
  const isGenerating = generatingCount > 0

  const overview: TopicOverviewWire | null = overviewQuery.data ?? null
  const currentSources = useMemo(
    () => sourcesQuery.data?.items ?? [],
    [sourcesQuery.data],
  )

  // 资料变化提示：wire 范围快照 vs 当前资料列表；只提示，不触发更新。
  const changes = useMemo(() => {
    if (overview === null) return null
    return topicOverviewSourceChanges(
      (overview.scope?.sources ?? []).map((source) => ({
        document_id: source.document_id,
        document_version: source.document_version,
      })),
      currentSources.map((source) => ({
        document_id: source.document_id,
        document_version: source.document_version,
      })),
    )
  }, [currentSources, overview])
  const hasChanges =
    changes !== null && changes.added + changes.versionChanged + changes.retired > 0

  // 能力位未 true：入口完全不渲染（既有 UI 逐字节不变）。
  if (!capability) return null

  const errorCode = extractResearchErrorCode(overviewQuery.error)
  const errorText = t(userErrorMessageKey(errorCode))
  const capturedAt =
    overview === null || overview.generation_created_at === null
      ? null
      : formatResearchTimestamp(overview.generation_created_at) ??
        overview.generation_created_at
  const generatedAt =
    overview === null || overview.generated_at === null
      ? null
      : formatResearchTimestamp(overview.generated_at) ?? overview.generated_at
  const scopeSummary =
    overview === null || overview.scope === null
      ? null
      : t('research.topicOverview.scopeSummary', {
          mode: t(scopeModeLabelKey(overview.scope.mode)),
          count: overview.scope.source_count,
        })

  return (
    <section
      className="shrink-0 border-b px-3 py-2"
      data-testid="topic-overview-entry"
      aria-label={t('research.topicOverview.entry.title')}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {t('research.topicOverview.entry.title')}
        </h3>

        {overviewQuery.isLoading && (
          <span className="text-xs text-muted-foreground" data-testid="topic-overview-entry-loading">
            {t('common.loading')}
          </span>
        )}

        {overview === null && !overviewQuery.isLoading && !overviewQuery.isError && (
          <span className="text-xs text-muted-foreground" data-testid="topic-overview-entry-empty">
            {t('research.topicOverview.entry.empty')}
          </span>
        )}

        {overview !== null && (
          <>
            {scopeSummary !== null && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="topic-overview-entry-scope"
              >
                {scopeSummary}
              </span>
            )}
            {capturedAt !== null && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="topic-overview-entry-captured"
              >
                {t('research.topicOverview.capturedAt', { date: capturedAt })}
              </span>
            )}
            {generatedAt !== null && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="topic-overview-entry-generated"
              >
                {t('research.topicOverview.generatedAt', { date: generatedAt })}
              </span>
            )}
            {overview.visibility === 'restricted' && (
              <Badge
                variant="outline"
                data-testid="topic-overview-entry-restricted"
              >
                {t('research.topicOverview.entry.restricted')}
              </Badge>
            )}
          </>
        )}

        {overviewQuery.isError ? (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2"
            role="alert"
            data-testid="topic-overview-entry-error"
          >
            <span className="text-xs text-destructive">{errorText}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                // 手动重试（不自动重试）：只重新读取概览，不触发生成。
                void overviewQuery.refetch()
              }}
              data-testid="topic-overview-entry-retry"
            >
              {t('research.retry')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={isGenerating}
            onClick={onOpen}
            data-testid="topic-overview-entry-open"
          >
            {isGenerating
              ? t('research.topicOverview.entry.generating')
              : overview === null
                ? t('research.topicOverview.entry.generate')
                : t('research.topicOverview.entry.view')}
          </Button>
        )}
      </div>

      {hasChanges && changes !== null && (
        <p
          className="mt-1 text-xs text-muted-foreground"
          role="status"
          data-testid="topic-overview-entry-changes"
        >
          {t('research.topicOverview.entry.changesNotice', {
            date: capturedAt ?? '—',
            added: changes.added,
            versionChanged: changes.versionChanged,
            retired: changes.retired,
          })}
        </p>
      )}
    </section>
  )
}
