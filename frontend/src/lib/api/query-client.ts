import { QueryClient } from '@tanstack/react-query'
import { isNotFoundError } from '@/lib/utils/error-handler'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes
      // Retry transient failures, but never retry 404s: the item was
      // deleted (or never existed) and retrying cannot change that.
      retry: (failureCount, error) => !isNotFoundError(error) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
})

export const QUERY_KEYS = {
  notebooks: ['notebooks'] as const,
  notebook: (id: string) => ['notebooks', id] as const,
  notes: (notebookId?: string) => ['notes', notebookId] as const,
  note: (id: string) => ['notes', id] as const,
  sources: (notebookId?: string) => ['sources', notebookId] as const,
  sourcesInfinite: (notebookId: string) => ['sources', 'infinite', notebookId] as const,
  source: (id: string) => ['sources', id] as const,
  settings: ['settings'] as const,
  sourceChatSessions: (sourceId: string) => ['source-chat', sourceId, 'sessions'] as const,
  sourceChatSession: (sourceId: string, sessionId: string) => ['source-chat', sourceId, 'sessions', sessionId] as const,
  notebookChatSessions: (notebookId: string) => ['notebook-chat', notebookId, 'sessions'] as const,
  notebookChatSession: (sessionId: string) => ['notebook-chat', 'sessions', sessionId] as const,
  podcastEpisodes: ['podcasts', 'episodes'] as const,
  podcastEpisode: (episodeId: string) => ['podcasts', 'episodes', episodeId] as const,
  episodeProfiles: ['podcasts', 'episode-profiles'] as const,
  speakerProfiles: ['podcasts', 'speaker-profiles'] as const,
  languages: ['languages'] as const,
  // UI-02：Research Gateway 项目级查询键（与上游 notebook 域完全隔离）
  research: (projectId: string) => ['research', projectId] as const,
  researchSources: (projectId: string) => ['research', projectId, 'sources'] as const,
  researchSource: (projectId: string, sourceId: string) => ['research', projectId, 'sources', sourceId] as const,
  researchNotes: (projectId: string) => ['research', projectId, 'notes'] as const,
  researchInsights: (projectId: string) => ['research', projectId, 'insights'] as const,
  researchTransformations: (projectId: string) => ['research', projectId, 'transformations'] as const,
  // #243 GMOD：全局模型/偏好/外发确认（Research 根级 shared settings）
  researchModelCatalog: (projectId: string) => ['research', projectId, 'model-catalog'] as const,
  researchExecutionPreferences: (projectId: string) => ['research', projectId, 'execution-preferences'] as const,
  researchEgressConsent: (projectId: string) => ['research', projectId, 'egress-consent'] as const,
}
