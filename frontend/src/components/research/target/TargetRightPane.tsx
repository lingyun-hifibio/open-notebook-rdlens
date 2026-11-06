'use client'

import { useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources, useResearchNotes } from '@/lib/hooks/use-research'
import type { UseResearchSessionsResult } from '@/lib/hooks/use-research-sessions'
import { formatResearchTimestamp } from '@/lib/research/format'
import type { ResearchJob } from '@/lib/research/types'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import { sessionRefEquals } from '@/lib/research/session-contract'
import type { ResearchSource } from '@/lib/types/research'
import {
  RESEARCH_SESSION_SWITCHER_PLACEHOLDERS,
} from '../ResearchSessionSwitcher'
import { translateOrFallback } from '@/lib/locales/translate-or-fallback'
import {
  TARGET_RIGHT_PANE_TITLE_KEYS,
  type TargetCitationPreview,
  type TargetRightPaneKind,
} from './target-types'

const STATUS_LABEL_KEYS: Record<ResearchSource['status'], string> = {
  pending: 'research.sources.statusPending',
  ready: 'research.sources.statusReady',
  stale: 'research.sources.statusStale',
  failed: 'research.sources.statusFailed',
  retiring: 'research.sources.statusRetiring',
  deleted: 'research.sources.statusDeleted',
}

const JOB_STATUS_KEYS: Record<ResearchJob['status'], string> = {
  queued: 'research.activity.state.queued',
  running: 'research.activity.state.running',
  cancelling: 'research.activity.state.cancelling',
  cancelled: 'research.activity.state.cancelled',
  completed: 'research.activity.state.completed',
  failed: 'research.activity.state.failed',
}

function isSelectableStatus(status: ResearchSource['status']): boolean {
  return status === 'ready' || status === 'stale'
}

/**
 * UI-12 按需右栏（W1 #1104；UI 规格 v1 §5.6）。
 *
 * - 355px 固定、独立滚动；一次一项；标题区 eyebrow + 标题 + 关闭；
 * - 打开由 shell 负责焦点进入（标题/关闭按钮），关闭由 shell 负责 `Esc` 与
 *   焦点返回触发控件（A11Y-02）；
 * - 五个面板：引用预览 / 资料预览 / 对话历史 / 成果目录 / 任务历史；
 * - 空/加载/错误/受限/不可用状态按 §8.2 如实呈现；W2/W3/P6 未开放能力
 *   明确说明，不绘制假阅读器/假编辑入口。
 */
export function TargetRightPane({
  kind,
  onClose,
  citationPreview,
  sourceId,
  sessions,
  activeRef,
  onOpenSession,
  onNewSession,
  onAskThisSource,
  jobs,
}: {
  kind: TargetRightPaneKind
  onClose: () => void
  citationPreview: TargetCitationPreview | null
  sourceId: string | null
  sessions: UseResearchSessionsResult | null
  activeRef: ResearchSessionRef | null
  onOpenSession: (ref: ResearchSessionRef) => void
  onNewSession: () => void
  onAskThisSource: (sourceId: string) => void
  jobs: readonly ResearchJob[]
}) {
  const { t, language } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const sourcesQuery = useResearchSources(projectId)
  const notesQuery = useResearchNotes(projectId)
  const title = t(TARGET_RIGHT_PANE_TITLE_KEYS[kind])

  // 打开面板 → 焦点进入（标题区关闭按钮；不抢焦点到正文）。
  useEffect(() => {
    closeRef.current?.focus()
  }, [kind])

  const sources = useMemo(() => sourcesQuery.data?.items ?? [], [sourcesQuery.data])

  const citationSource = useMemo(() => {
    if (citationPreview === null) return null
    const citation = citationPreview.citation
    const direct = citationPreview.sourceId !== null
      ? sources.find((item) => item.source_id === citationPreview.sourceId)
      : undefined
    if (direct !== undefined) return direct
    return sources.find(
      (item) =>
        item.document_id === citation.doc_id &&
        (citation.doc_version === undefined ||
          citation.doc_version === null ||
          item.document_version === citation.doc_version),
    ) ?? null
  }, [citationPreview, sources])

  const previewSource = useMemo(
    () => sources.find((item) => item.source_id === sourceId) ?? null,
    [sourceId, sources],
  )

  return (
    <aside
      id="rdlens-target-right-pane"
      aria-labelledby="rdlens-target-right-pane-title"
      className="flex h-full min-h-0 w-[355px] shrink-0 flex-col border-l"
      style={{
        borderColor: 'var(--rdlens-line)',
        backgroundColor: 'var(--rdlens-surface)',
      }}
      data-testid="rdlens-target-right-pane"
      data-pane-kind={kind}
    >
      <div
        className="shrink-0 border-b px-6 pb-3 pt-5"
        style={{ borderColor: 'var(--rdlens-line)' }}
      >
        <p
          className="text-[11px] font-medium uppercase tracking-wide"
          style={{ color: 'var(--rdlens-ink-muted)' }}
        >
          {t('research.target.rightPane.eyebrow')}
        </p>
        <div className="mt-1 flex min-w-0 items-start justify-between gap-2">
          <h2
            id="rdlens-target-right-pane-title"
            className="rdlens-serif min-w-0 truncate text-base font-medium"
            title={title}
          >
            {title}
          </h2>
          <Button
            ref={closeRef}
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 px-2"
            aria-label={t('research.target.rightPane.close')}
            onClick={onClose}
            data-testid="rdlens-target-right-pane-close"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1" data-testid="rdlens-target-right-pane-body">
        {kind === 'citation' && (
          <CitationPreview
            preview={citationPreview}
            source={citationSource}
            onAskThisSource={onAskThisSource}
          />
        )}
        {kind === 'source' && (
          <SourcePreview
            source={previewSource}
            loading={sourcesQuery.isLoading}
            error={sourcesQuery.isError}
            onRetry={() => void sourcesQuery.refetch()}
            onAskThisSource={onAskThisSource}
          />
        )}
        {kind === 'conversations' && (
          <ConversationHistory
            sessions={sessions}
            activeRef={activeRef}
            onOpenSession={onOpenSession}
            onNewSession={onNewSession}
          />
        )}
        {kind === 'outcomes' && (
          <OutcomesCatalog
            notes={notesQuery.data?.items ?? []}
            loading={notesQuery.isLoading}
            error={notesQuery.isError}
            onRetry={() => void notesQuery.refetch()}
            locale={language}
          />
        )}
        {kind === 'tasks' && <TaskHistory jobs={jobs} locale={language} />}
      </div>
    </aside>
  )
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="space-y-1 px-5 py-4" data-testid="rdlens-target-pane-empty">
      <p className="text-sm" style={{ color: 'var(--rdlens-ink-muted)' }}>
        {title}
      </p>
      {hint !== undefined && (
        <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  )
}

function CitationPreview({
  preview,
  source,
  onAskThisSource,
}: {
  preview: TargetCitationPreview | null
  source: ResearchSource | null
  onAskThisSource: (sourceId: string) => void
}) {
  const { t } = useTranslation()
  if (preview === null) {
    return <EmptyState title={t('research.target.rightPane.locatorUnavailable')} />
  }
  const citation = preview.citation
  const canPin = source !== null && source.source_id !== null && isSelectableStatus(source.status)
  return (
    <div className="space-y-3 px-5 py-4" data-testid="rdlens-target-citation-preview">
      <div className="space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--rdlens-ink-muted)' }}>
          {t('research.target.rightPane.citationSource')}
        </p>
        <p className="text-sm" data-testid="rdlens-target-citation-source">
          {citation.doc_display_name ?? citation.doc_id}
        </p>
      </div>
      <div className="space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--rdlens-ink-muted)' }}>
          {t('research.target.rightPane.citationLocator')}
        </p>
        <p className="rdlens-mono text-sm" data-testid="rdlens-target-citation-locator">
          {typeof citation.page_idx === 'number'
            ? t('research.target.rightPane.locatorPage', { page: citation.page_idx + 1 })
            : t('research.target.rightPane.locatorUnavailable')}
        </p>
      </div>
      <div className="space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--rdlens-ink-muted)' }}>
          {t('research.target.rightPane.citationExcerpt')}
        </p>
        <p className="text-sm leading-relaxed" data-testid="rdlens-target-citation-excerpt">
          {citation.claim}
        </p>
      </div>
      <div className="space-y-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled
          aria-describedby="rdlens-target-open-original-reason"
          data-testid="rdlens-target-open-original"
        >
          {t('research.target.rightPane.openOriginal')}
        </Button>
        <p
          id="rdlens-target-open-original-reason"
          className="text-xs"
          style={{ color: 'var(--rdlens-ink-muted)' }}
        >
          {t('research.target.rightPane.openOriginalUnavailable')}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canPin}
          title={canPin ? undefined : t('research.target.rightPane.askThisSourceUnavailable')}
          onClick={() => {
            if (source?.source_id) onAskThisSource(source.source_id)
          }}
          data-testid="rdlens-target-ask-this-source"
        >
          {t('research.target.rightPane.askThisSource')}
        </Button>
      </div>
    </div>
  )
}

function SourcePreview({
  source,
  loading,
  error,
  onRetry,
  onAskThisSource,
}: {
  source: ResearchSource | null
  loading: boolean
  error: boolean
  onRetry: () => void
  onAskThisSource: (sourceId: string) => void
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <p className="px-5 py-4 text-sm" role="status" aria-busy="true" style={{ color: 'var(--rdlens-ink-muted)' }}>
        {t('research.target.sources.loading')}
      </p>
    )
  }
  if (error) {
    return (
      <div className="space-y-2 px-5 py-4" role="alert">
        <p className="text-sm" style={{ color: 'var(--rdlens-warning)' }}>
          {t('research.target.sources.loadFailed')}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          {t('research.target.sources.retry')}
        </Button>
      </div>
    )
  }
  if (source === null) {
    return <EmptyState title={t('research.target.rightPane.emptySource')} />
  }
  const statusLabel = t(STATUS_LABEL_KEYS[source.status])
  const canPin = source.source_id !== null && isSelectableStatus(source.status)
  return (
    <div className="space-y-3 px-5 py-4" data-testid="rdlens-target-source-preview">
      <div className="space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--rdlens-ink-muted)' }}>
          {t('research.target.rightPane.citationSource')}
        </p>
        <p className="text-sm" data-testid="rdlens-target-source-preview-name">
          {source.document_id}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt style={{ color: 'var(--rdlens-ink-muted)' }}>{t('research.target.rightPane.sourceVersion')}</dt>
        <dd className="rdlens-mono">{source.document_version}</dd>
        <dt style={{ color: 'var(--rdlens-ink-muted)' }}>{t('research.target.rightPane.sourceStatus')}</dt>
        <dd>{statusLabel}</dd>
        <dt style={{ color: 'var(--rdlens-ink-muted)' }}>{t('research.target.rightPane.sourceLocator')}</dt>
        <dd style={{ color: 'var(--rdlens-ink-muted)' }}>
          {t('research.target.rightPane.locatorUnavailable')}
        </dd>
      </dl>
      <div className="space-y-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled
          aria-describedby="rdlens-target-open-original-reason-source"
          data-testid="rdlens-target-source-open-original"
        >
          {t('research.target.rightPane.openOriginal')}
        </Button>
        <p
          id="rdlens-target-open-original-reason-source"
          className="text-xs"
          style={{ color: 'var(--rdlens-ink-muted)' }}
        >
          {t('research.target.rightPane.openOriginalUnavailable')}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canPin}
          onClick={() => {
            if (source.source_id) onAskThisSource(source.source_id)
          }}
          data-testid="rdlens-target-source-ask-this-source"
        >
          {t('research.target.rightPane.askThisSource')}
        </Button>
      </div>
    </div>
  )
}

function ConversationHistory({
  sessions,
  activeRef,
  onOpenSession,
  onNewSession,
}: {
  sessions: UseResearchSessionsResult | null
  activeRef: ResearchSessionRef | null
  onOpenSession: (ref: ResearchSessionRef) => void
  onNewSession: () => void
}) {
  const { t } = useTranslation()
  if (sessions === null) {
    return <EmptyState title={t('research.target.rightPane.conversationsUnavailable')} />
  }
  if (sessions.loading) {
    return (
      <p className="px-5 py-4 text-sm" role="status" aria-busy="true" style={{ color: 'var(--rdlens-ink-muted)' }}>
        {t('research.target.conversation.loading')}
      </p>
    )
  }
  if (sessions.error !== null) {
    return (
      <div className="space-y-2 px-5 py-4" role="alert">
        <p className="text-sm" style={{ color: 'var(--rdlens-warning)' }}>
          {t('research.loadFailed')}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => sessions.refresh()}>
          {t('research.target.sources.retry')}
        </Button>
      </div>
    )
  }
  if (sessions.sessions.length === 0) {
    return (
      <EmptyState
        title={t('research.target.rightPane.conversationsEmpty')}
        hint={t('research.target.rightPane.conversationsHint')}
      />
    )
  }
  return (
    <div className="space-y-2 px-3 py-3" data-testid="rdlens-target-conversation-history">
      <ul className="space-y-1">
        {sessions.sessions.map((item) => {
          const unnamed = translateOrFallback(
            t,
            'research.session.unnamed',
            RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unnamedSession,
          )
          const title =
            item.visibility === 'visible'
              ? item.title ?? unnamed
              : item.visibility === 'legacy_context_unverifiable'
                ? item.title ?? unnamed
                : item.visibility === 'restricted'
                  ? translateOrFallback(
                      t,
                      'research.session.restrictedConversation',
                      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.restrictedSession,
                    )
                  : translateOrFallback(
                      t,
                      'research.session.unknownVisibility',
                      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unknownVisibilitySession,
                    )
          const current = activeRef !== null && sessionRefEquals(item.ref, activeRef)
          const updated =
            item.updatedAt === null || item.updatedAt === undefined
              ? null
              : formatResearchTimestamp(item.updatedAt)
          return (
            <li key={item.ref.sessionId}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                className="flex min-h-11 w-full min-w-0 flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left"
                style={{
                  backgroundColor: current ? 'var(--rdlens-cite-field)' : 'transparent',
                }}
                onClick={() => onOpenSession(item.ref)}
                data-testid="rdlens-target-conversation-item"
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
                  {current && (
                    <span className="shrink-0 text-xs" style={{ color: 'var(--rdlens-evidence)' }}>
                      {t('research.target.rightPane.currentConversation')}
                    </span>
                  )}
                </span>
                {updated !== null && (
                  <span className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
                    {updated}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        disabled={!sessions.canCreate}
        onClick={onNewSession}
        data-testid="rdlens-target-conversation-new"
      >
        {t('research.target.conversation.newConversation')}
      </Button>
    </div>
  )
}

function OutcomesCatalog({
  notes,
  loading,
  error,
  onRetry,
  locale,
}: {
  notes: readonly { note_id: string; title: string; updated_at: string | null }[]
  loading: boolean
  error: boolean
  onRetry: () => void
  locale: string
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 px-5 py-4" data-testid="rdlens-target-outcomes-panel">
      {loading && (
        <p className="text-sm" role="status" aria-busy="true" style={{ color: 'var(--rdlens-ink-muted)' }}>
          {t('research.target.sources.loading')}
        </p>
      )}
      {!loading && error && (
        <div className="space-y-2" role="alert">
          <p className="text-sm" style={{ color: 'var(--rdlens-warning)' }}>
            {t('research.target.rightPane.outcomesUnavailable')}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            {t('research.target.sources.retry')}
          </Button>
        </div>
      )}
      {!loading && !error && notes.length === 0 && (
        <EmptyState
          title={t('research.target.rightPane.outcomesEmpty')}
          hint={t('research.target.rightPane.outcomesHint')}
        />
      )}
      {!loading && !error && notes.length > 0 && (
        <ul className="space-y-1">
          {notes.map((note) => {
            const updated = formatResearchTimestamp(note.updated_at, { lang: locale })
            return (
              <li key={note.note_id} className="min-w-0" data-testid="rdlens-target-outcome-item">
                <p className="truncate text-sm" title={note.title}>
                  {note.title}
                </p>
                {updated !== null && (
                  <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
                    {updated}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
        {t('research.target.rightPane.outcomesReadOnly')}
      </p>
    </div>
  )
}

function TaskHistory({
  jobs,
  locale,
}: {
  jobs: readonly ResearchJob[]
  locale: string
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 px-5 py-4" data-testid="rdlens-target-tasks-panel">
      {jobs.length === 0 ? (
        <EmptyState
          title={t('research.target.rightPane.tasksEmpty')}
          hint={t('research.target.rightPane.tasksHint')}
        />
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => {
            const created = formatResearchTimestamp(job.created_at, { lang: locale })
            const status = translateOrFallback(
              t,
              JOB_STATUS_KEYS[job.status],
              job.status,
            )
            return (
              <li
                key={job.job_id}
                className="min-w-0 space-y-0.5 rounded px-1 py-1"
                data-testid="rdlens-target-task-item"
                data-task-status={job.status}
              >
                <p className="truncate text-sm" title={job.job_id}>
                  {job.job_id}
                </p>
                <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
                  {status}
                  {created !== null && ` · ${t('research.target.rightPane.taskCreated')}: ${created}`}
                  {job.model_id !== null && ` · ${t('research.target.rightPane.taskModel')}: ${job.model_id}`}
                </p>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
        {t('research.target.rightPane.tasksUnavailable')}
      </p>
    </div>
  )
}
