'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { ResearchScopeMode } from '@/lib/research/scope'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'

/**
 * Source/Note 选择器（UI-03，契约 §8.1/§8.2）。Search/Chat/Compare 共用
 * 同一选择；Source 按 status 展示徽标（ready/stale/failed/pending）。
 */
export function SourceNoteSelector({
  sources,
  notes,
  mode,
  selectedSourceIds,
  selectedNoteIds,
  onModeChange,
  onToggleSource,
  onToggleNote,
  loading,
  loadError,
  onRetry,
}: {
  sources: ResearchSource[]
  notes: ResearchNote[]
  mode: ResearchScopeMode
  selectedSourceIds: string[]
  selectedNoteIds: string[]
  onModeChange: (mode: ResearchScopeMode) => void
  onToggleSource: (sourceId: string) => void
  onToggleNote: (noteId: string) => void
  loading: boolean
  loadError: string | null
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const selectedCount = selectedSourceIds.length + selectedNoteIds.length
  const scope = mode === 'entire_project'
    ? t('research.layout.scope.entireProject')
    : t('research.layout.scope.selectedSummary', { sources: selectedSourceIds.length, notes: selectedNoteIds.length })

  return (
    <div className="border-b" data-testid="source-note-selector">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="bg-background shadow-sm"
          aria-expanded={expanded}
          aria-controls="research-context-selection"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('research.layout.collapseContext') : t('research.layout.expandContext')}
        </Button>
        <p className="text-sm text-muted-foreground" data-testid="research-context-scope">{scope}</p>
        {loading && <span className="text-xs text-muted-foreground">{t('research.loading')}</span>}
        {loadError && (
          <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
            <span>{t('research.loadFailed')}</span>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('research.retry')}
            </Button>
          </div>
        )}
      </div>

      <div id="research-context-selection" hidden={!expanded} className="grid gap-4 px-4 pb-4 sm:grid-cols-2">
      <RadioGroup
        value={mode}
        onValueChange={(value) => onModeChange(value as ResearchScopeMode)}
        className="col-span-full flex flex-wrap gap-4"
        aria-label={t('research.layout.scope.modeLabel')}
      >
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="entire_project" data-testid="scope-entire-project" />
          {t('research.layout.scope.entireProject')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem
            value="selected"
            disabled={selectedCount === 0}
            data-testid="scope-selected"
          />
          {t('research.layout.scope.selected')}
        </label>
      </RadioGroup>
      {selectedCount === 0 && (
        <p className="col-span-full text-xs text-muted-foreground" data-testid="scope-selection-required">
          {t('research.layout.scope.selectItemRequired')}
        </p>
      )}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('research.selectSources')}
        </p>
        <div className="max-h-[200px] overflow-y-auto" data-testid="source-selection-list">
          {sources.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('research.sourcesEmpty')}</p>
          )}
          {sources.map((source) => (
            <label
              key={source.source_id}
              className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={selectedSourceIds.includes(source.source_id)}
                onCheckedChange={() => onToggleSource(source.source_id)}
                disabled={
                  mode === 'selected' &&
                  selectedCount === 1 &&
                  selectedSourceIds.includes(source.source_id)
                }
                data-testid={`source-${source.source_id}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{source.document_id}</span>
                <span className="block text-xs text-muted-foreground">
                  {source.document_version} · {source.source_id}
                </span>
              </span>
              <Badge
                variant={source.status === 'failed' ? 'destructive' : source.status === 'ready' ? 'default' : 'secondary'}
              >
                {source.status}
              </Badge>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('research.selectNotes')}
        </p>
        <div className="max-h-[200px] overflow-y-auto" data-testid="note-selection-list">
          {notes.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('research.notesEmpty')}</p>
          )}
          {notes.map((note) => (
            <label
              key={note.note_id}
              className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={selectedNoteIds.includes(note.note_id)}
                onCheckedChange={() => onToggleNote(note.note_id)}
                disabled={
                  mode === 'selected' &&
                  selectedCount === 1 &&
                  selectedNoteIds.includes(note.note_id)
                }
                data-testid={`note-${note.note_id}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{note.title}</span>
                <span className="block text-xs text-muted-foreground">{note.note_id}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      </div>
    </div>
  )
}
