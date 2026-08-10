'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { useToast } from '@/lib/hooks/use-toast'
import { useTranslation } from '@/lib/hooks/use-translation'
import {
  createExport,
  createInsight,
  createNote,
  createTransformation,
  deleteNote,
  getSource,
  listInsights,
  listNotes,
  listSources,
  listTransformations,
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

export function useResearchSources(projectId: string) {
  return useQuery({
    queryKey: QUERY_KEYS.researchSources(projectId),
    queryFn: () => listSources(projectId),
    enabled: !!projectId,
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
    queryFn: () => listNotes(projectId, search ? { q: search } : {}),
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchNotes(projectId) })
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
  const onError = useMutationErrorToast()
  return useMutation({
    mutationFn: ({
      transformationId,
      sourceIds,
      noteIds,
    }: {
      transformationId: string
      sourceIds: string[]
      noteIds: string[]
    }) => runTransformation(projectId, transformationId, { source_ids: sourceIds, note_ids: noteIds }),
    onError,
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
