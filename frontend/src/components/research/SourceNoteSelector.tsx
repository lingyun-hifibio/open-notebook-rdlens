'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ResearchNoteSummary, ResearchSourceSummary } from '@/lib/research/types'

/**
 * Source/Note 选择器（UI-03，契约 §8.1/§8.2）。Search/Chat/Compare 共用
 * 同一选择；Source 按 status 展示徽标（ready/stale/failed/pending）。
 */
export function SourceNoteSelector({
  sources,
  notes,
  selectedSourceIds,
  selectedNoteIds,
  onToggleSource,
  onToggleNote,
}: {
  sources: ResearchSourceSummary[]
  notes: ResearchNoteSummary[]
  selectedSourceIds: string[]
  selectedNoteIds: string[]
  onToggleSource: (sourceId: string) => void
  onToggleNote: (noteId: string) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="grid gap-4 p-4 sm:grid-cols-2">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('research.sources')} ({selectedSourceIds.length}/{sources.length})
        </p>
        <ScrollArea className="max-h-56">
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
        </ScrollArea>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('research.notes')} ({selectedNoteIds.length}/{notes.length})
        </p>
        <ScrollArea className="max-h-56">
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
                data-testid={`note-${note.note_id}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{note.title}</span>
                <span className="block text-xs text-muted-foreground">{note.note_id}</span>
              </span>
            </label>
          ))}
        </ScrollArea>
      </div>
    </div>
  )
}
