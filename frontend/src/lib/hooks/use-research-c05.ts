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
  D1E_CAPABILITY_KEY,
  readC05Capabilities,
  readD1eCapability,
  d1eRoundtripReady,
  entryDispatchReady,
  entryUnavailableReason,
  entrySupportsMode,
  type C05Capabilities,
  type C05Entry,
  type C05ScopeMode,
  type D1eRoundtripCapability,
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

// ---------------------------------------------------------------------------
// Issue #1013（D1-E-2）§2.2/§2.11：D1-E 往返/选段能力消费
// ---------------------------------------------------------------------------

export interface UseResearchD1eResult {
  /** 严格解析后的能力块；缺失/畸形 → null（调用方按不可用处理）。 */
  capability: D1eRoundtripCapability | null
  /** 只有契约值匹配且 enabled === true 才为 true（fail-closed）。 */
  ready: boolean
  loading: boolean
}

/**
 * 复用同一个 `researchModelCatalog` query key（与 useResearchC05/global model
 * 共享缓存、零额外请求）；`refetchOnWindowFocus` 使 flag 翻转后下次聚焦生效。
 */
export function useResearchD1e(projectId: string): UseResearchD1eResult {
  const modelsQuery = useQuery({
    queryKey: QUERY_KEYS.researchModelCatalog(projectId),
    queryFn: () => listModels(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })
  const raw = modelsQuery.data?.capabilities?.[D1E_CAPABILITY_KEY]
  const capability = useMemo(() => readD1eCapability(raw), [raw])
  return {
    capability,
    ready: d1eRoundtripReady(raw),
    loading: modelsQuery.isLoading,
  }
}
