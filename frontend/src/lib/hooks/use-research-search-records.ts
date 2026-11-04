'use client'

/**
 * #1014（D1-F 主单）搜索历史回访 hook 组。
 *
 * 三条读面（计划 §2.7/§2.8）：
 *
 * 1. `useResearchSearchHistoryCapability`：消费 `GET .../models` 的加性
 *    `capabilities.search_history`，**严格 `=== true`** 才显示入口（缺失/
 *    非法/false 一律 fail-closed）；缺失该键的旧后端 = 无入口。
 * 2. `useResearchSearchRecords`：keyset 游标分页列表（页大小 20，
 *    `useInfiniteQuery`，`load more` 追加；不做 authority，列表不含来源身份）。
 * 3. `useResearchSearchRecord`：单条详情（Owner 专属；403/404/503 由
 *    `classifySearchRecordError` 分类展示）。
 *
 * 查询键纪律（query-client DESIGN §3.2）：工作台内使用尾随身份段的判别键
 * （owner 带 viewer、Admin 只读不带 viewer），认证代际/viewer 变化后旧缓存
 * 不可见；孤立渲染（无 Provider / owner 无 viewer）沿用既有非判别键。
 *
 * 重试：两个读请求显式 `retry: false`——`search_record_not_enabled`（flag
 * off 竞态）重试不会改变结果，避免重试风暴；「存储不可用」由用户显式点
 * 「重试」按钮。能力位查询与模型目录同 key/同 queryFn，与
 * `useResearchGlobalModel`/`useResearchC05` 共享缓存，不产生额外请求。
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  QUERY_KEYS,
  adminReadonlyResearchIdentity,
  ownerResearchIdentity,
  researchModelCatalogIdentityKey,
  researchSearchRecordIdentityKey,
  researchSearchRecordsIdentityKey,
  type ResearchQueryIdentity,
} from '@/lib/api/query-client'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
import { getSearchRecord, listModels, listSearchRecords } from '@/lib/research/api'
import { readSearchHistoryCapability } from '@/lib/research/search-records'

/** 列表页大小（与 #1015 服务端默认 20 一致；上限 50 由服务端约束）。 */
export const SEARCH_RECORDS_PAGE_SIZE = 20

interface SearchRecordQueryIdentity {
  identity: ResearchQueryIdentity | null
  hasWorkspace: boolean
}

/** 复用既有身份判别约定：owner 带 viewer；Admin 只读不带 viewer。 */
function useSearchRecordQueryIdentity(): SearchRecordQueryIdentity {
  const workspace = useResearchWorkspaceOptional()
  if (!workspace) return { identity: null, hasWorkspace: false }
  const generation = workspace.authGeneration ?? 0
  if (workspace.role === 'admin_readonly') {
    return {
      identity: adminReadonlyResearchIdentity(workspace.projectId, generation),
      hasWorkspace: true,
    }
  }
  if (!workspace.userId) return { identity: null, hasWorkspace: true }
  return {
    identity: ownerResearchIdentity(
      workspace.projectId,
      workspace.userId,
      generation,
    ),
    hasWorkspace: true,
  }
}

/**
 * 搜索历史能力位（fail-closed）：仅 `capabilities.search_history === true`
 * 视为启用。与模型目录共享同一 query key/缓存（不新增请求）。
 */
export function useResearchSearchHistoryCapability(projectId: string): boolean {
  const { identity } = useSearchRecordQueryIdentity()
  const modelsQuery = useQuery({
    queryKey: identity
      ? researchModelCatalogIdentityKey(identity)
      : QUERY_KEYS.researchModelCatalog(projectId),
    queryFn: () => listModels(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })
  return readSearchHistoryCapability(modelsQuery.data?.capabilities)
}

/**
 * 搜索记录列表（Owner 专属，只读）。`enabled` 允许 Dialog 关闭时不发起
 * 首次请求（打开后加载）。
 */
export function useResearchSearchRecords(
  projectId: string,
  options: { enabled?: boolean } = {},
) {
  const { identity, hasWorkspace } = useSearchRecordQueryIdentity()
  return useInfiniteQuery({
    queryKey: identity
      ? researchSearchRecordsIdentityKey(identity)
      : QUERY_KEYS.researchSearchRecords(projectId),
    queryFn: ({ pageParam }) =>
      listSearchRecords(projectId, {
        limit: SEARCH_RECORDS_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam as string } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    // 工作台内身份未确认（owner 无 viewer）时 fail-closed；孤立渲染沿用旧行为。
    enabled: !!projectId && (options.enabled ?? true) && (!hasWorkspace || identity !== null),
    // 回访按现行权限/最新记录读取：每次打开都重新验证（不消费 5 分钟旧缓存）。
    staleTime: 0,
    retry: false,
  })
}

/** 搜索记录详情（Owner 专属，只读）；`recordId=null` 不请求。 */
export function useResearchSearchRecord(
  projectId: string,
  recordId: string | null,
) {
  const { identity, hasWorkspace } = useSearchRecordQueryIdentity()
  return useQuery({
    queryKey: identity
      ? researchSearchRecordIdentityKey(identity, recordId ?? '')
      : QUERY_KEYS.researchSearchRecord(projectId, recordId ?? ''),
    queryFn: () => getSearchRecord(projectId, recordId as string),
    enabled: !!projectId && !!recordId && (!hasWorkspace || identity !== null),
    // 详情含现行权限过滤：每次读都取当前权限结论，不消费旧缓存。
    staleTime: 0,
    retry: false,
  })
}
