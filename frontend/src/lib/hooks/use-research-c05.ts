'use client'

/**
 * Issue #601 PR5（B1/C6/C7）：C-05 能力消费 hook。
 *
 * 复用 `QUERY_KEYS.researchModelCatalog(projectId)`（与 use-research-global-model
 * 同一 query key → 共享缓存、零额外请求）；`refetchOnWindowFocus` 使开关翻转
 * 后下次聚焦生效（请求时刻真值）。缺失/畸形一律不可用（不自动降级）。
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listModels } from '@/lib/research/api'
import { QUERY_KEYS } from '@/lib/api/query-client'
import {
  readC05Capabilities,
  entryDispatchReady,
  entryUnavailableReason,
  entrySupportsMode,
  type C05Capabilities,
  type C05Entry,
  type C05ScopeMode,
} from '@/lib/research/c05-contract'

export interface UseResearchC05Result {
  caps: C05Capabilities | null
  loading: boolean
  dispatchReady: (entry: C05Entry) => boolean
  unavailableReason: (entry: C05Entry) => string
  supportsMode: (entry: C05Entry, mode: C05ScopeMode) => boolean
  /** R2-M10：只读 C-05 Preview 是否可用（顶层 preview_supported 位） */
  previewSupported: boolean
}

export function useResearchC05(projectId: string): UseResearchC05Result {
  const modelsQuery = useQuery({
    queryKey: QUERY_KEYS.researchModelCatalog(projectId),
    queryFn: () => listModels(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })

  const caps = useMemo(
    () => readC05Capabilities(modelsQuery.data?.capabilities?.c05),
    [modelsQuery.data],
  )

  return {
    caps,
    loading: modelsQuery.isLoading,
    dispatchReady: (entry) => entryDispatchReady(caps, entry),
    unavailableReason: (entry) => entryUnavailableReason(caps, entry),
    supportsMode: (entry, mode) => entrySupportsMode(caps, entry, mode),
    previewSupported: caps?.preview_supported ?? false,
  }
}
