'use client'

/**
 * 全局会话范围条（#602 第三批 PR-4，DESIGN §5.3 / §7.2 / §9.2）。
 *
 * 只呈现“当前会话 editor 的范围投影”，把用户动作交给 `onChangeScope`：
 * - all / selected / single / Note 四种编辑状态；single 是叠加态（不占模式位）；
 * - legacy（`base_scope=null`）显示重选横幅，不默认回退 all，也不从旧
 *   citations 反推范围（§7.2）；
 * - 失效/未确认项保留选择并逐项标注，不自动删除（§7.2）；
 * - **不读写工作区选择器**，也不发起发送/SSE（PR-5a 才接线执行）。
 */

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  EditorSnapshot,
  ResearchScopeBarNoteOption,
  ResearchScopeBarSourceOption,
  ScopeEdit,
} from '@/lib/research/types'

export interface ResearchSessionScopeBarProps {
  /** 当前会话的 editor 快照；`null` 表示未接线（不渲染、不写任何范围）。 */
  readonly editorSnapshot: EditorSnapshot | null
  /** 工作区资料查询投影（父层提供，不在此重复查询）。 */
  readonly sources: readonly ResearchScopeBarSourceOption[]
  readonly notes: readonly ResearchScopeBarNoteOption[]
  /** 稳定禁用原因（父层已 `t()` 映射）；非空时整条范围条不可交互。 */
  readonly disabledReason?: string | null
  readonly onChangeScope: (edit: ScopeEdit) => void
}

type ScopeMode = 'all' | 'selected' | 'single' | 'legacy'

export function ResearchSessionScopeBar({
  editorSnapshot,
  sources,
  notes,
  disabledReason,
  onChangeScope,
}: ResearchSessionScopeBarProps) {
  const { t } = useTranslation()

  // 无 editor（运行时未接线）：不渲染任何可写控件，避免改写范围。
  if (editorSnapshot === null) return null

  const snapshot = editorSnapshot
  const disabled =
    disabledReason !== null && disabledReason !== undefined && disabledReason.length > 0

  const baseMode = snapshot.baseScope?.mode ?? null
  const selectedSourceIds = snapshot.baseScope?.sourceIds ?? []
  const noteIds = snapshot.noteIds
  const singleSourceId = snapshot.singleSourceId
  const mode: ScopeMode =
    singleSourceId !== null ? 'single' : baseMode === null ? 'legacy' : baseMode

  const hasSelection = selectedSourceIds.length > 0 || noteIds.length > 0
  // all 模式也展示资料/Note 列表：勾选即显式切到 selected（§5.3 反推规则）。
  const showSelectedList = mode !== 'single'
  const unconfirmedSourceIds = sources
    .filter(source => source.unavailable === true)
    .map(source => source.sourceId)
  const hasUnconfirmedSelection = unconfirmedSourceIds.some(sourceId =>
    selectedSourceIds.includes(sourceId),
  )

  const toggleSource = (sourceId: string, nextChecked: boolean): void => {
    const next = nextChecked
      ? [...selectedSourceIds.filter(id => id !== sourceId), sourceId]
      : selectedSourceIds.filter(id => id !== sourceId)
    // 不传 noteIds：由 editor 归约层保留既有 Note 选择（DESIGN §5.3）。
    onChangeScope({ mode: 'selected', sourceIds: next })
  }

  const toggleNote = (noteId: string, nextChecked: boolean): void => {
    const next = nextChecked
      ? [...noteIds.filter(id => id !== noteId), noteId]
      : noteIds.filter(id => id !== noteId)
    // all/legacy 下勾 Note：显式切到 selected（Note-only 合法，§5.3）。
    if (mode === 'all' || mode === 'legacy') {
      onChangeScope({ mode: 'selected', sourceIds: selectedSourceIds, noteIds: next })
      return
    }
    onChangeScope({ mode: 'note', noteIds: next })
  }

  return (
    <div
      className="min-w-0 space-y-2 border-b px-4 py-2"
      data-testid="research-session-scope-bar"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('research.layout.scope.modeLabel')}
      </p>

      <div
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"
        role="radiogroup"
        aria-label={t('research.layout.scope.modeLabel')}
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'all'}
          disabled={disabled}
          className="shrink-0 text-sm disabled:opacity-50"
          onClick={() => onChangeScope({ mode: 'all' })}
          data-testid="scope-mode-all"
        >
          {t('research.layout.scope.entireProject')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'selected'}
          disabled={disabled}
          className="shrink-0 text-sm disabled:opacity-50"
          onClick={() =>
            onChangeScope({ mode: 'selected', sourceIds: selectedSourceIds })
          }
          data-testid="scope-mode-selected"
        >
          {t('research.layout.scope.selected')}
        </button>
      </div>

      {mode === 'all' && (
        <p className="text-xs text-muted-foreground" data-testid="scope-all-hint">
          {t('research.layout.scope.allHint')}
        </p>
      )}

      {mode === 'single' && singleSourceId !== null && (
        <div
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-2 py-1.5"
          data-testid="scope-single-banner"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">
            {t('research.layout.scope.singleActive', { source: singleSourceId })}
          </span>
          <span className="min-w-0 truncate text-xs" data-testid="scope-single-source">
            {singleSourceId}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            disabled={disabled}
            onClick={() => onChangeScope({ mode: 'single', sourceId: null })}
            data-testid="scope-single-clear"
          >
            {t('research.layout.scope.singleClear')}
          </Button>
        </div>
      )}

      {mode === 'legacy' && (
        <p className="text-xs text-amber-700" role="status" data-testid="scope-legacy-banner">
          {t('research.editor.legacyScopeReselection')}
        </p>
      )}

      {showSelectedList && (
        <div className="min-w-0 space-y-1" data-testid="scope-selected-list">
          {sources.map(source => (
            <label
              key={source.sourceId}
              className="flex min-w-0 items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                className="shrink-0"
                checked={selectedSourceIds.includes(source.sourceId)}
                disabled={disabled}
                onChange={event => toggleSource(source.sourceId, event.target.checked)}
                data-testid={`scope-source-${source.sourceId}`}
              />
              <span className="min-w-0 truncate">{source.title}</span>
              {source.unavailable === true && (
                <span className="shrink-0 text-xs text-amber-700">
                  {t('research.editor.unconfirmedItems')}
                </span>
              )}
            </label>
          ))}
          {notes.length > 0 && (
            <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('research.layout.scope.selectedSummary', { count: noteIds.length })}
            </p>
          )}
          {notes.map(note => (
            <label key={note.noteId} className="flex min-w-0 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="shrink-0"
                checked={noteIds.includes(note.noteId)}
                disabled={disabled}
                onChange={event => toggleNote(note.noteId, event.target.checked)}
                data-testid={`scope-note-${note.noteId}`}
              />
              <span className="min-w-0 truncate">{note.title}</span>
            </label>
          ))}
        </div>
      )}

      {mode === 'selected' && !hasSelection && (
        <p className="text-xs text-amber-700" role="status" data-testid="scope-empty-hint">
          {t('research.layout.scope.selectItemRequired')}
        </p>
      )}

      {hasUnconfirmedSelection && (
        <p className="text-xs text-amber-700" role="status" data-testid="scope-unconfirmed-hint">
          {t('research.editor.unconfirmedItems')}
        </p>
      )}

      {disabled && (
        <p className="text-xs text-muted-foreground" role="status" data-testid="scope-disabled-reason">
          {disabledReason}
        </p>
      )}
    </div>
  )
}
