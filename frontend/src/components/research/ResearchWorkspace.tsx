'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getResearchProjectId } from '@/lib/research/project'
import { listNotes, listSources } from '@/lib/research/api'
import { useResearchChat } from '@/lib/hooks/use-research-chat'
import { useResearchJobs } from '@/lib/hooks/use-research-jobs'
import { SourceNoteSelector } from './SourceNoteSelector'
import { ResearchSearchPanel } from './ResearchSearchPanel'
import { ResearchChatPanel } from './ResearchChatPanel'
import { ComparePanel } from './ComparePanel'
import { ResearchJobList } from './ResearchJobList'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'

/**
 * Research 工作区组合（UI-03，REQ-SCOPE-04，设计 §9.3）。
 *
 * 项目上下文从内存 Research Token 的 payload 读取（project.ts，
 * REQ-AUTH-03）；无上下文 fail-closed 错误态。Source/Note 选择在
 * Search/Chat/Compare 间共享；Chat 与 Job hooks 挂在工作区层，
 * 切换 Tab 不丢失流/轮询状态。Source/Note 列表复用 UI-02 的
 * `listSources/listNotes`（分页载荷 .items）。
 */
export function ResearchWorkspace() {
  const { t } = useTranslation()
  const projectId = getResearchProjectId()

  const [sources, setSources] = useState<ResearchSource[]>([])
  const [notes, setNotes] = useState<ResearchNote[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([])
  const [tab, setTab] = useState('search')

  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setLoadError(null)
    try {
      const [sourcePage, notePage] = await Promise.all([
        listSources(projectId),
        listNotes(projectId),
      ])
      setSources(sourcePage.items)
      setNotes(notePage.items)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const toggleSource = useCallback((sourceId: string) => {
    setSelectedSourceIds((prev) =>
      prev.includes(sourceId) ? prev.filter((id) => id !== sourceId) : [...prev, sourceId],
    )
  }, [])

  const toggleNote = useCallback((noteId: string) => {
    setSelectedNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId],
    )
  }, [])

  const chat = useResearchChat({ projectId: projectId ?? '' })
  const jobs = useResearchJobs({ projectId: projectId ?? '' })

  if (!projectId) {
    return (
      <div role="alert" className="p-8 text-center text-sm text-destructive">
        {t('research.noProjectContext')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <SourceNoteSelector
        sources={sources}
        notes={notes}
        selectedSourceIds={selectedSourceIds}
        selectedNoteIds={selectedNoteIds}
        onToggleSource={toggleSource}
        onToggleNote={toggleNote}
        loading={loading}
        loadError={loadError}
        onRetry={() => void load()}
      />

      <div className="min-h-0 flex-1 border-t">
        <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col">
          <TabsList className="mx-4 mt-2 w-fit">
            <TabsTrigger value="search">{t('research.tabSearch')}</TabsTrigger>
            <TabsTrigger value="chat">{t('research.tabChat')}</TabsTrigger>
            <TabsTrigger value="compare">{t('research.tabCompare')}</TabsTrigger>
            <TabsTrigger value="jobs">
              {t('research.tabJobs')}
              {jobs.jobs.length > 0 ? ` (${jobs.jobs.length})` : ''}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="search" className="min-h-0 flex-1">
            {loading ? (
              <p className="p-4 text-sm text-muted-foreground">{t('research.loading')}</p>
            ) : (
              <ResearchSearchPanel
                projectId={projectId}
                selectedSourceIds={selectedSourceIds}
                selectedNoteIds={selectedNoteIds}
              />
            )}
          </TabsContent>
          <TabsContent value="chat" className="min-h-0 flex-1">
            <ResearchChatPanel
              turns={chat.turns}
              isStreaming={chat.isStreaming}
              onSend={chat.send}
              selectedSourceIds={selectedSourceIds}
              selectedNoteIds={selectedNoteIds}
            />
          </TabsContent>
          <TabsContent value="compare" className="min-h-0 flex-1">
            <ComparePanel
              sources={sources}
              selectedSourceIds={selectedSourceIds}
              isCreating={jobs.isCreating}
              error={jobs.error}
              onCreate={(documentIds, groupSize) => jobs.createCompare(documentIds, groupSize)}
            />
          </TabsContent>
          <TabsContent value="jobs" className="min-h-0 flex-1">
            <ResearchJobList jobs={jobs.jobs} isCreating={jobs.isCreating} onCancel={jobs.cancel} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
