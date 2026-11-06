'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useRequestIngest } from '@/lib/embedded/shell'
import { useResearchSources, useResearchNotes } from '@/lib/hooks/use-research'
import { useResearchScope, formatScopeLabel } from '@/lib/research/scope'
import type { ResearchNote, ResearchSource, ResearchSourceStatus } from '@/lib/types/research'

/**
 * UI-04 左资料栏（W1 #1104；UI 规格 v1 §5.3）。
 *
 * - 固定 282px、独立滚动（宽度与滚动由 shell 负责，本组件只渲染内容）；
 * - 标题「资料」+ 添加入口（复用 `useRequestIngest` 宿主入库对话框，不重复
 *   实现上传/访问校验）；
 * - 搜索框：本地过滤当前项目资料与笔记；无匹配显示空态 + 清除搜索（不留白）；
 * - 范围单选组：唯一范围权威仍是既有 `ResearchScopeProvider`（不建第二套
 *   状态）；`single` 是叠加态，不占单选位；
 * - 资料列表：复选框（仅 ready/stale 且 source_id 非空可选，24px 点击区）＋
 *   标题按钮（打开右栏 UI-17 预览）＋版本＋状态文字（状态不只靠颜色）；
 * - 笔记区（UI-04「选用笔记或草稿继续讨论」）：列表 + 复选（写入同一 Scope
 *   provider）、空态；不新建范围权威、不提供编辑器（W3）；
 * - 底部范围摘要：`formatScopeLabel` 统一覆盖 sources + notes（F9）；
 * - 空 selected 是用户可达的阻断态（BEH-03）：说明 + 选资料/改回全部。
 */

const STATUS_LABEL_KEYS: Record<ResearchSourceStatus, string> = {
  pending: 'research.sources.statusPending',
  ready: 'research.sources.statusReady',
  stale: 'research.sources.statusStale',
  failed: 'research.sources.statusFailed',
  retiring: 'research.sources.statusRetiring',
  deleted: 'research.sources.statusDeleted',
}

function isSelectableStatus(status: ResearchSourceStatus): boolean {
  return status === 'ready' || status === 'stale'
}

function rowKey(item: ResearchSource): string {
  return `${item.document_id}:${item.document_version}:${item.source_id ?? 'null'}`
}

/** F18：24×24 最小点击区（A11Y-04），checkbox 本体保持 16px 视觉。 */
function CheckboxHitArea({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center">{children}</span>
  )
}

export function TargetSourcesPane({
  onOpenSource,
  scopeFocusRequest = 0,
}: {
  /** 打开右栏资料预览（UI-17）；传入触发元素用于关闭后焦点返回（F7） */
  onOpenSource: (sourceId: string, trigger: HTMLElement) => void
  /** 递增序号：composer 紧凑范围标签点击后聚焦范围单选组（§3.3） */
  scopeFocusRequest?: number
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const { data, isLoading, isError, refetch } = useResearchSources(projectId)
  const notesQuery = useResearchNotes(projectId)
  const {
    mode,
    selectedSourceIds,
    selectedNoteIds,
    singlePin,
    toggleSource,
    removeSource,
    toggleNote,
    removeNote,
    getSnapshot,
    setMode,
  } = useResearchScope()
  const requestIngest = useRequestIngest()
  const [search, setSearch] = useState('')
  const scopeRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const selectedCount = selectedSourceIds.length + selectedNoteIds.length

  // §3.3：紧凑态点击 composer 范围标签 → 关闭右栏并聚焦左栏范围控件。
  useEffect(() => {
    if (scopeFocusRequest <= 0) return
    scopeRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus()
  }, [scopeFocusRequest])

  const items = useMemo(() => data?.items ?? [], [data])
  const notes = useMemo<ResearchNote[]>(() => notesQuery.data?.items ?? [], [notesQuery.data])
  const query = search.trim().toLowerCase()
  const filteredSources = useMemo(() => {
    if (query.length === 0) return items
    return items.filter((item) => item.document_id.toLowerCase().includes(query))
  }, [items, query])
  const filteredNotes = useMemo(() => {
    if (query.length === 0) return notes
    return notes.filter((note) => note.title.toLowerCase().includes(query))
  }, [notes, query])

  // F9：范围摘要统一走 formatScopeLabel（sources + notes + single 一致）。
  const summaryText = formatScopeLabel(getSnapshot(), t, singlePin?.sourceId ?? null)
  const scopeBlocked = mode === 'selected' && selectedCount === 0

  // F17：聚焦第一个**可操作**的复选框（跳过 disabled 行）。
  const focusFirstSelectable = (): void => {
    const selector =
      '[data-testid^="rdlens-target-source-select-"]:not(:disabled), ' +
      '[data-testid^="rdlens-target-note-select-"]:not(:disabled)'
    listRef.current?.querySelector<HTMLElement>(selector)?.focus()
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="rdlens-target-sources-pane">
      <div className="shrink-0 px-6 pb-2 pt-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold" data-testid="rdlens-target-sources-title">
            {t('research.target.sources.title')}
          </h2>
          {requestIngest !== null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1 px-2 text-xs"
              data-testid="rdlens-target-sources-add"
              onClick={requestIngest}
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              {t('research.target.sources.add')}
            </Button>
          )}
        </div>

        {/* 搜索：过滤当前资料与笔记；空态含清除搜索 */}
        <div className="mt-3">
          <label className="sr-only" htmlFor="rdlens-target-source-search">
            {t('research.target.sources.searchLabel')}
          </label>
          <div className="flex items-center gap-1">
            <input
              id="rdlens-target-source-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('research.target.sources.searchPlaceholder')}
              className="h-9 w-full min-w-0 rounded-[5px] border px-2 text-sm"
              style={{
                borderColor: 'var(--rdlens-line-control)',
                backgroundColor: 'var(--rdlens-surface)',
                color: 'var(--rdlens-ink)',
              }}
              data-testid="rdlens-target-sources-search"
            />
            {search.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-9 shrink-0 px-2"
                aria-label={t('research.target.sources.searchClear')}
                data-testid="rdlens-target-sources-search-clear"
                onClick={() => setSearch('')}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* 范围单选组：既有 Scope Provider 是唯一权威 */}
        <fieldset className="mt-4 min-w-0" data-testid="rdlens-target-scope-fieldset">
          <legend className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--rdlens-ink-muted)' }}>
            {t('research.target.sources.scopeLegend')}
          </legend>
          <RadioGroup
            ref={scopeRef}
            value={mode === 'single' ? '' : mode}
            onValueChange={(value) => setMode(value as 'all' | 'selected')}
            className="mt-2 flex min-w-0 flex-col gap-2"
            aria-label={t('research.target.sources.scopeLegend')}
            data-testid="rdlens-target-scope-group"
          >
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <RadioGroupItem value="all" data-testid="rdlens-target-scope-all" />
              <span className="min-w-0">{t('research.target.sources.scopeAll')}</span>
            </label>
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <RadioGroupItem
                value="selected"
                // 空 selected 是可达的阻断态（BEH-03）：已选中时保持可读，
                // 仅禁止从 all 切到空的 selected。
                disabled={selectedCount === 0 && mode !== 'selected'}
                data-testid="rdlens-target-scope-selected"
              />
              <span className="min-w-0">{t('research.target.sources.scopeSelected')}</span>
            </label>
          </RadioGroup>
          {mode === 'all' && (
            <p className="mt-2 text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
              {t('research.layout.scope.allHint')}
            </p>
          )}
          {/* BEH-03：空 selected 是用户可达的阻断态——说明原因 + 下一步
              （选资料 / 改为全部可用资料）；不静默回退 all、不扩大范围。
              「改为探索/写作」随 #1106 本次用途提供，W1 不造假控件（F13）。 */}
          {scopeBlocked && (
            <div
              role="alert"
              className="mt-3 space-y-2 rounded-[4px] px-3 py-2"
              style={{ backgroundColor: 'var(--rdlens-warning-field)', color: 'var(--rdlens-ink)' }}
              data-testid="rdlens-target-scope-blocked"
            >
              <p className="text-sm font-medium">{t('research.target.sources.scopeEmptySelected')}</p>
              <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
                {t('research.target.sources.scopeBlockedHint')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={focusFirstSelectable}
                  data-testid="rdlens-target-scope-blocked-choose"
                >
                  {t('research.target.sources.scopeBlockedChoose')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setMode('all')}
                  data-testid="rdlens-target-scope-blocked-all"
                >
                  {t('research.target.sources.scopeBlockedAll')}
                </Button>
              </div>
            </div>
          )}
        </fieldset>
      </div>

      {/* 列表：独立滚动；行最小高度 44px（§3.4） */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-1" data-testid="rdlens-target-sources-list">
        {isLoading && (
          <p
            className="px-3 py-2 text-sm"
            role="status"
            aria-busy="true"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-sources-loading"
          >
            {t('research.target.sources.loading')}
          </p>
        )}
        {!isLoading && isError && (
          <div
            className="space-y-2 px-3 py-2"
            role="alert"
            data-testid="rdlens-target-sources-error"
          >
            <p className="text-sm" style={{ color: 'var(--rdlens-warning)' }}>
              {t('research.target.sources.loadFailed')}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
              data-testid="rdlens-target-sources-retry"
            >
              {t('research.target.sources.retry')}
            </Button>
          </div>
        )}
        {!isLoading && !isError && items.length === 0 && (
          <p className="px-3 py-2 text-sm" style={{ color: 'var(--rdlens-ink-muted)' }} data-testid="rdlens-target-sources-empty">
            {t('research.target.sources.empty')}
          </p>
        )}
        {!isLoading && !isError && (items.length > 0 || notes.length > 0) && filteredSources.length === 0 && filteredNotes.length === 0 && (
          <div
            className="space-y-2 px-3 py-2"
            role="status"
            data-testid="rdlens-target-sources-search-empty"
          >
            <p className="text-sm" style={{ color: 'var(--rdlens-ink-muted)' }}>
              {t('research.target.sources.searchEmpty', { query: search.trim() })}
            </p>
            <p className="text-xs" style={{ color: 'var(--rdlens-ink-muted)' }}>
              {t('research.target.sources.searchEmptyHint')}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSearch('')}
              data-testid="rdlens-target-sources-search-empty-clear"
            >
              {t('research.target.sources.searchClear')}
            </Button>
          </div>
        )}

        {!isLoading && !isError && filteredSources.length > 0 && (
          <ul className="min-w-0" data-testid="rdlens-target-sources-rows">
            {filteredSources.map((item) => {
              const selectable = item.source_id !== null && isSelectableStatus(item.status)
              const selected =
                item.source_id !== null && selectedSourceIds.includes(item.source_id)
              const statusLabel = t(STATUS_LABEL_KEYS[item.status])
              return (
                <li
                  key={rowKey(item)}
                  className="flex min-h-11 min-w-0 items-center gap-2 rounded px-2 py-1.5"
                  style={{ borderBottom: '1px solid var(--rdlens-line)' }}
                  data-testid="rdlens-target-source-row"
                  data-source-status={item.status}
                >
                  <CheckboxHitArea>
                    <Checkbox
                      checked={selected}
                      // BEH-01/BEH-03：只按“是否可选”禁用；取消最后一份必须
                      // 可用（否则“selected 为空”的阻断路径不可达）。
                      disabled={!selectable}
                      onCheckedChange={() => {
                        if (item.source_id === null) return
                        if (selected) removeSource(item.source_id)
                        else toggleSource(item.source_id)
                      }}
                      aria-label={t('research.target.sources.selectAria', {
                        name: item.document_id,
                      })}
                      title={selectable ? undefined : t('research.target.sources.notSelectable')}
                      className="shrink-0"
                      data-testid={`rdlens-target-source-select-${item.source_id ?? `doc-${item.document_id}-${item.document_version}`}`}
                    />
                  </CheckboxHitArea>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    aria-label={t('research.target.sources.openAria', { name: item.document_id })}
                    disabled={item.source_id === null}
                    onClick={(event) => {
                      if (item.source_id !== null) onOpenSource(item.source_id, event.currentTarget)
                    }}
                    data-testid="rdlens-target-source-open"
                  >
                    {item.document_id}
                  </button>
                  <span
                    className="shrink-0 text-xs"
                    style={{ color: 'var(--rdlens-ink-muted)' }}
                    data-testid="rdlens-target-source-version"
                  >
                    {item.document_version}
                  </span>
                  <span
                    className="shrink-0 text-xs font-medium"
                    style={{
                      color:
                        item.status === 'failed' || item.status === 'deleted'
                          ? 'var(--rdlens-warning)'
                          : 'var(--rdlens-ink-muted)',
                    }}
                    aria-label={t('research.target.sources.statusAria', {
                      status: statusLabel,
                    })}
                    data-testid="rdlens-target-source-status"
                  >
                    {statusLabel}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        {/* 笔记区：UI-04「选用笔记或草稿继续讨论」——列表 + 复选 + 空态；
            写入同一 Scope provider，不新建范围权威（F10）。 */}
        {!notesQuery.isLoading && !notesQuery.isError && filteredNotes.length > 0 && (
          <section className="mt-3 min-w-0" aria-label={t('research.target.sources.notesTitle')}>
            <h3
              className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--rdlens-ink-muted)' }}
              data-testid="rdlens-target-notes-title"
            >
              {t('research.target.sources.notesTitle')}
            </h3>
            <ul className="min-w-0" data-testid="rdlens-target-notes-rows">
              {filteredNotes.map((note) => {
                const selected = selectedNoteIds.includes(note.note_id)
                return (
                  <li
                    key={note.note_id}
                    className="flex min-h-11 min-w-0 items-center gap-2 rounded px-2 py-1.5"
                    style={{ borderBottom: '1px solid var(--rdlens-line)' }}
                    data-testid="rdlens-target-note-row"
                  >
                    <CheckboxHitArea>
                      <Checkbox
                        checked={selected}
                        onCheckedChange={() => {
                          if (selected) removeNote(note.note_id)
                          else toggleNote(note.note_id)
                        }}
                        aria-label={t('research.target.sources.noteSelectAria', {
                          name: note.title,
                        })}
                        className="shrink-0"
                        data-testid={`rdlens-target-note-select-${note.note_id}`}
                      />
                    </CheckboxHitArea>
                    <span className="min-w-0 truncate text-sm" title={note.title}>
                      {note.title}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {notesQuery.isLoading && (
          <p className="px-3 py-2 text-sm" role="status" aria-busy="true" style={{ color: 'var(--rdlens-ink-muted)' }} data-testid="rdlens-target-notes-loading">
            {t('research.target.sources.loading')}
          </p>
        )}
        {!notesQuery.isLoading && notesQuery.isError && (
          <div className="space-y-2 px-3 py-2" role="alert" data-testid="rdlens-target-notes-error">
            <p className="text-sm" style={{ color: 'var(--rdlens-warning)' }}>
              {t('research.target.sources.loadFailed')}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => void notesQuery.refetch()}>
              {t('research.target.sources.retry')}
            </Button>
          </div>
        )}
        {!notesQuery.isLoading && !notesQuery.isError && notes.length === 0 && items.length > 0 && (
          <p className="px-3 py-2 text-xs" style={{ color: 'var(--rdlens-ink-muted)' }} data-testid="rdlens-target-notes-empty">
            {t('research.target.sources.notesEmpty')}
          </p>
        )}
      </div>

      {/* 底部范围摘要（F9：formatScopeLabel 覆盖 sources + notes） */}
      <div
        className="shrink-0 border-t px-6 py-3"
        style={{ borderColor: 'var(--rdlens-line)' }}
        data-testid="rdlens-target-scope-summary"
      >
        <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--rdlens-ink-muted)' }}>
          {t('research.target.sources.summaryLabel')}
        </p>
        <p className="mt-1 text-sm" role="status" aria-live="polite">
          {summaryText}
        </p>
        {notes.length > 0 && (
          <p className="mt-1 text-xs" style={{ color: 'var(--rdlens-ink-muted)' }} data-testid="rdlens-target-notes-hint">
            {t('research.target.sources.notesHint')}
          </p>
        )}
      </div>
    </div>
  )
}
