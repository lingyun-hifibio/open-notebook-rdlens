'use client'

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { useToast } from '@/lib/hooks/use-toast'
import { useTranslation } from '@/lib/hooks/use-translation'
import { collectResearchPages, RESEARCH_PAGE_LIMIT } from '@/lib/research/pagination'
import {
  createExport,
  createInsight,
  createNote,
  createTransformation,
  deleteNote,
  getSource,
  getTransformationResult,
  listInsights,
  listNotes,
  listSources,
  listTransformations,
  listTransformationResults,
  runTransformation,
  updateNote,
  type CreateInsightInput,
  type CreateNoteInput,
  type CreateTransformationInput,
  type UpdateNoteInput,
} from '@/lib/research/api'

/**
 * Research Gateway 项目级 hooks（UI-02，REQ-API-01；契约 §7）。
 *
 * 全部数据经 Gateway apiClient；查询键与上游 notebook 域隔离。写入
 * mutation 失败（含 403 Admin 写拒绝）一律 toast 呈现——前端禁用入口
 * 不替代后端授权（验收：不得把后端 403 仅靠隐藏按钮替代）。
 */

function useMutationErrorToast() {
  const { toast } = useToast()
  const { t } = useTranslation()
  return (error: unknown) => {
    // 403：Admin 只读被服务端拒绝（REQ-AUTH-04/§4.4 矩阵，双保险）
    const status = (error as { response?: { status?: number } })?.response?.status
    const message =
      status === 403
        ? t('research.workbench.adminWriteDenied')
        : t('research.workbench.actionFailed')
    toast({ title: t('common.error'), description: message, variant: 'destructive' })
  }
}

// ── Sources（只读；REQ-SRC-04：失败只表现为 Workspace stale/failed） ──

export const RESEARCH_SOURCE_REFRESH_MS = 30_000

export function useResearchSources(projectId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.researchSources(projectId),
    queryFn: ({ signal }) => collectResearchPages(
      (cursor) => listSources(projectId, {
        limit: RESEARCH_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }, signal),
      (source) => source.source_id,
    ),
    enabled: !!projectId,
    // Source sync can be initiated outside this component. Active workspaces
    // periodically observe status transitions so invalid selected IDs are
    // reconciled without relying on a manual cache invalidation.
    refetchInterval: RESEARCH_SOURCE_REFRESH_MS,
  })
}

export function useResearchSource(projectId: string, sourceId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.researchSource(projectId, sourceId ?? ''),
    queryFn: () => getSource(projectId, sourceId as string),
    enabled: !!projectId && !!sourceId,
  })
}

// ── Notes（Owner 写；保存永不触发 Embedding，REQ-DIS-01） ──

export function useResearchNotes(projectId: string, search?: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.researchNotes(projectId), search ?? ''] as const,
    queryFn: ({ signal }) => collectResearchPages(
      (cursor) => listNotes(projectId, {
        ...(search ? { q: search } : {}),
        limit: RESEARCH_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }, signal),
      (note) => note.note_id,
    ),
    enabled: !!projectId,
  })
}

export function useCreateResearchNote(projectId: string) {
  const queryClient = useQueryClient()
  const onError = useMutationErrorToast()
  const { toast } = useToast()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: (input: CreateNoteInput) => createNote(projectId, input),
    onMutate: () => queryClient.cancelQueries({
      queryKey: QUERY_KEYS.researchNotes(projectId),
    }),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
      toast({ title: t('common.success'), description: t('research.workbench.noteCreated') })
    },
    onError,
  })
}

export function useUpdateResearchNote(projectId: string) {
  const queryClient = useQueryClient()
  const onError = useMutationErrorToast()
  const { toast } = useToast()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: ({ noteId, input }: { noteId: string; input: UpdateNoteInput }) =>
      updateNote(projectId, noteId, input),
    onMutate: () => queryClient.cancelQueries({
      queryKey: QUERY_KEYS.researchNotes(projectId),
    }),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
      toast({ title: t('common.success'), description: t('research.workbench.noteUpdated') })
    },
    onError,
  })
}

export function useDeleteResearchNote(projectId: string) {
  const queryClient = useQueryClient()
  const onError = useMutationErrorToast()
  const { toast } = useToast()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: (noteId: string) => deleteNote(projectId, noteId),
    onMutate: () => queryClient.cancelQueries({
      queryKey: QUERY_KEYS.researchNotes(projectId),
    }),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
      toast({ title: t('common.success'), description: t('research.workbench.noteDeleted') })
    },
    onError,
  })
}

// ── Insights（manual / ai，ai 需已批准 model_id） ──

export function useResearchInsights(projectId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.researchInsights(projectId),
    queryFn: () => listInsights(projectId),
    enabled: !!projectId,
  })
}

export function useCreateResearchInsight(projectId: string) {
  const queryClient = useQueryClient()
  const onError = useMutationErrorToast()
  const { toast } = useToast()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: (input: CreateInsightInput) => createInsight(projectId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchInsights(projectId) })
      toast({ title: t('common.success'), description: t('research.workbench.insightCreated') })
    },
    onError,
  })
}

// ── Transformations（prompt-only 模板 + 运行；REQ-DIS-02/03） ──

export function useResearchTransformations(projectId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.researchTransformations(projectId),
    queryFn: () => listTransformations(projectId),
    enabled: !!projectId,
  })
}

export function useCreateResearchTransformation(projectId: string) {
  const queryClient = useQueryClient()
  const onError = useMutationErrorToast()
  const { toast } = useToast()
  const { t } = useTranslation()
  return useMutation({
    mutationFn: (input: CreateTransformationInput) => createTransformation(projectId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.researchTransformations(projectId),
      })
      toast({
        title: t('common.success'),
        description: t('research.workbench.transformationCreated'),
      })
    },
    onError,
  })
}

export function useRunResearchTransformation(projectId: string) {
  const queryClient = useQueryClient()
  const onError = useMutationErrorToast()
  return useMutation({
    mutationFn: ({
      transformationId,
      sourceIds,
      noteIds,
      modelId,
      idempotencyKey,
    }: {
      transformationId: string
      sourceIds: string[]
      noteIds: string[]
      /** Issue #243 §6.6/§6.7：运行开始时的 confirmed 全局模型（required） */
      modelId: string
      /** RWV2-21：Rerun=新建派发，必须每次传新幂等键（复用旧 key → 幂等重放/409） */
      idempotencyKey?: string
    }) =>
      runTransformation(projectId, transformationId, {
        source_ids: sourceIds,
        note_ids: noteIds,
        model_id: modelId,
      }, { idempotencyKey }),
    // RWV2-21/Medium-7：run（含 Rerun）成功后新结果必须出现在历史列表——
    // 只失效 results key（精确 key，不连带模板/templates 或其他 research 键）。
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: QUERY_KEYS.researchTransformationResults(projectId),
        exact: true,
      })
    },
    onError,
  })
}

// ── Transformation Result 历史（RWV2-20/Issue #42；只读，服务端游标分页） ──

export const TRANSFORMATION_RESULTS_PAGE_SIZE = 20

export function useResearchTransformationResults(projectId: string) {
  return useInfiniteQuery({
    queryKey: QUERY_KEYS.researchTransformationResults(projectId),
    queryFn: ({ pageParam }) =>
      listTransformationResults(projectId, {
        limit: TRANSFORMATION_RESULTS_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    enabled: !!projectId,
  })
}

/** by-id 详情（防御/深链用；默认详情路径读列表行对象，不接本 hook，Medium-4）。 */
export function useTransformationResult(projectId: string, resultId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.researchTransformationResult(projectId, resultId ?? ''),
    queryFn: () => getTransformationResult(projectId, resultId as string),
    enabled: !!projectId && !!resultId,
  })
}

// ── 导出（Owner/Admin 均可，均审计；下载由调用方经 Gateway blob 完成） ──

export function useCreateResearchExport(projectId: string) {
  const onError = useMutationErrorToast()
  return useMutation({
    mutationFn: () => createExport(projectId),
    onError,
  })
}
