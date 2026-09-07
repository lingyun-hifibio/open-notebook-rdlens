'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useSaveResearchResult, useSavedResultEntry } from '@/lib/hooks/use-research'
import { buildResultCopyText, type ResultCopyCitation } from './result-copy'
import type {
  ResearchSaveDestinationKind,
  ResearchSaveOriginKind,
} from '@/lib/types/research'

/**
 * RWV2-23（Issue #43）：跨 Search/Chat/Transformation 结果面共享的动作条。
 *
 * - Save as Insight / Save as Note：走 RWV2-22（POST save-result）；幂等键
 *   由 api 层确定性生成（D3）——pending/网络未知期间的重复点击被并发抑制，
 *   确定性终态后错误可重试，成功后同源同目标不再发请求；
 * - 成功 UI 仅在 mutation resolve（后端 201/200）后出现，并依据当前信息架构
 *   回调 View（跳转 Results/Insights 或 Materials/Notes，AC3）；
 * - per-result 状态存于组件实例（saved 初值来自展示态缓存，跨实例/重开
 *   结果可见）；未保存绝不误报为已保存；
 * - Copy：只含正文 + Citation（D7），clipboard 存在性守卫；
 * - 权限：Owner 可写/继续；Admin（isAdminReadonly）只保留 Copy（AC7），后端
 *   403 仍是权威（此处错误按状态码呈现，不透传后端 detail）；
 * - 文案全部走 i18n（AC8）。
 */
export interface ResultActionsProps {
  originKind: ResearchSaveOriginKind
  /** 不可用（null）时写动作默认隐藏；配合 showSave/resolveOriginId 可呈现 */
  originId: string | null
  /**
   * originId 暂缺时的惰性解析器（chat live 轮：点击 Save 先 resolve
   * generation_id 再保存；成功前 pending 状态如实呈现）。返回 null → 保存
   * 不可用错误文案。
   */
  resolveOriginId?: () => Promise<string | null>
  title?: string | null
  content: string
  /** 展示归一化后的 Citation 行（chat/search display；Transformation 经归一化） */
  citations?: readonly ResultCopyCitation[] | null
  /** 显式强制渲染 Save 按钮（即使 originId 暂缺，用于不可用态说明） */
  showSave?: boolean
  saveDisabledReasonKey?: string | null
  onViewInsight?: (insightId: string) => void
  onViewNote?: (noteId: string) => void
  onContinueResearch?: () => void
}

type SavePhase =
  | { dest: ResearchSaveDestinationKind; state: 'pending' }
  | { dest: ResearchSaveDestinationKind; state: 'error'; messageKey: string }

/** 后端错误 → 英文通用 key（专用文案，绝不把后端 detail 当 key 直译）。 */
export function classifySaveErrorKey(error: unknown): string {
  const status = (error as { response?: { status?: number } } | null)?.response
    ?.status
  if (status === undefined || status >= 500 || status === 404 || status === 503) {
    // 网络未知 / 瞬时服务端 / 结果缺失或路由缺失（旧后端）→ “暂时不可存”
    return 'research.resultActions.saveUnavailable'
  }
  // 403/409/422 及其它确定失败 → 通用失败
  return 'research.resultActions.saveFailed'
}

export function ResultActions({
  originKind,
  originId,
  resolveOriginId,
  title,
  content,
  citations,
  showSave,
  saveDisabledReasonKey,
  onViewInsight,
  onViewNote,
  onContinueResearch,
}: ResultActionsProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const saveMutation = useSaveResearchResult(projectId)

  const owner = !isAdminReadonly
  const canResolve = resolveOriginId !== undefined
  const saveAvailable = originId !== null || canResolve
  // originId 与 resolver 均缺 → 写动作禁用 + 原因文案（如 chat 恢复行不可解析）
  const saveBlocked = !saveAvailable
  // AC7：Admin 只读——即使调用方强制 showSave（如 chat 不可解析禁用态说明）
  // 也不渲染写按钮（review #7）。
  const renderSave = owner && (showSave === true || saveAvailable)
  const renderContinue = owner && onContinueResearch !== undefined

  // saved 展示态：反应式订阅缓存条目（useSaveResearchResult.onSuccess 写入；
  // 删除 Note 后 removeQueries 会实时回到“未保存”，允许再次保存——round-2）。
  // 惰性解析（chat live）成功后把真实 origin_id 提升为本实例 saved-entry 的
  // 查询键（round-2：使删除 reconcile 对已解析实例同样生效）。
  const [resolvedOriginId, setResolvedOriginId] = useState<string | null>(null)
  const effectiveOriginId = originId ?? resolvedOriginId
  const noteEntry = useSavedResultEntry(projectId, originKind, effectiveOriginId ?? '', 'note')
  const insightEntry = useSavedResultEntry(projectId, originKind, effectiveOriginId ?? '', 'insight')

  const [phase, setPhase] = useState<SavePhase | null>(null)
  const busy = saveMutation.isPending || phase?.state === 'pending'

  // D10（R3-1）：Dialog/瞬态宿主卸载后 resolve 只静默失效本地副作用；
  // artifact 创建/缓存写入由 mutation/queryClient 继续（确定性键防重复）。
  // StrictMode 双挂载友好：setup 时重臂（否则 dev 模拟卸载会永久杀死回调）。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // 同步 busy 令牌：resolve/mutation 全程互斥（pending 状态本身异步更新，
  // 快速双击在重渲染前可能都通过 phase 检查——review #2）。
  const saveBusyRef = useRef(false)

  const handleSave = useCallback(
    async (destinationKind: ResearchSaveDestinationKind) => {
      const destSaved =
        destinationKind === 'note'
          ? noteEntry !== null && 'note_id' in noteEntry
          : insightEntry !== null && 'insight_id' in insightEntry
      if (saveBusyRef.current || destSaved) return
      saveBusyRef.current = true
      try {
        if (!aliveRef.current) return
        setPhase({ dest: destinationKind, state: 'pending' })
        let originToUse = originId
        if (originToUse === null && canResolve) {
          originToUse = await resolveOriginId()
        }
        if (!aliveRef.current) return
        if (originToUse === null) {
          setPhase({
            dest: destinationKind,
            state: 'error',
            messageKey: 'research.resultActions.saveUnavailable',
          })
          return
        }
        if (aliveRef.current && originToUse !== originId) {
          // chat live 轮：解析成功后提升 saved-entry 查询键
          setResolvedOriginId(originToUse)
        }
        await saveMutation.mutateAsync({
          originKind,
          originId: originToUse,
          destinationKind,
          ...(title ? { title } : {}),
        })
        if (aliveRef.current) {
          setPhase(null)
        }
      } catch (error) {
        if (aliveRef.current) {
          setPhase({
            dest: destinationKind,
            state: 'error',
            messageKey: classifySaveErrorKey(error),
          })
        }
      } finally {
        saveBusyRef.current = false
      }
    },
    [originId, originKind, saveMutation, noteEntry, insightEntry, title, canResolve, resolveOriginId],
  )

  const [copying, setCopying] = useState(false)
  const handleCopy = useCallback(async () => {
    if (copying) return
    const text = buildResultCopyText({ content, citations })
    if (text === '') {
      if (aliveRef.current) {
        toast({ title: t('research.resultActions.copyFailed'), variant: 'destructive' })
      }
      return
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      if (aliveRef.current) {
        toast({ title: t('research.resultActions.copyFailed'), variant: 'destructive' })
      }
      return
    }
    if (aliveRef.current) setCopying(true)
    try {
      await navigator.clipboard.writeText(text)
      if (aliveRef.current) {
        toast({ title: t('research.resultActions.copySuccess') })
      }
    } catch {
      if (aliveRef.current) {
        toast({ title: t('research.resultActions.copyFailed'), variant: 'destructive' })
      }
    } finally {
      if (aliveRef.current) setCopying(false)
    }
  }, [content, citations, copying, toast, t])

  // 判别联合收窄：note/insight detail 视图以互斥 id 键区分；originId 缺省时
  // 禁用查询返回 null，等同“未保存”。
  const savedInsightId =
    insightEntry !== null && 'insight_id' in insightEntry
      ? insightEntry.insight_id
      : null
  const savedNoteId =
    noteEntry !== null && 'note_id' in noteEntry ? noteEntry.note_id : null
  const hasSavedInsight = savedInsightId !== null
  const hasSavedNote = savedNoteId !== null

  return (
    <div className="space-y-2" data-testid="result-actions">
      <div className="flex flex-wrap items-center gap-2">
        {renderSave && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="save-as-insight"
              disabled={hasSavedInsight || busy || saveBlocked}
              title={
                saveDisabledReasonKey && saveBlocked
                  ? t(saveDisabledReasonKey)
                  : undefined
              }
              onClick={() => void handleSave('insight')}
            >
              {busy && phase?.dest === 'insight'
                ? t('research.resultActions.saving')
                : t('research.resultActions.saveAsInsight')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="save-as-note"
              disabled={hasSavedNote || busy || saveBlocked}
              title={
                saveDisabledReasonKey && saveBlocked
                  ? t(saveDisabledReasonKey)
                  : undefined
              }
              onClick={() => void handleSave('note')}
            >
              {busy && phase?.dest === 'note'
                ? t('research.resultActions.saving')
                : t('research.resultActions.saveAsNote')}
            </Button>
          </>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="copy-result"
          disabled={copying}
          onClick={() => void handleCopy()}
        >
          {t('research.resultActions.copy')}
        </Button>
        {renderContinue && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="continue-research"
            onClick={onContinueResearch}
          >
            {t('research.resultActions.continueResearch')}
          </Button>
        )}
      </div>

      <div aria-live="polite" data-testid="result-action-status" className="text-xs">
        {saveDisabledReasonKey && saveBlocked && phase === null && !hasSavedInsight && !hasSavedNote && (
          <p className="text-muted-foreground" role="status">
            {t(saveDisabledReasonKey)}
          </p>
        )}
        {phase?.state === 'error' && (
          <p className="text-destructive" role="alert" data-testid="save-error">
            {t(phase.messageKey)}
          </p>
        )}
        {hasSavedInsight && savedInsightId !== null && (
          <p className="text-muted-foreground" role="status" data-testid="saved-insight">
            {t('research.resultActions.savedAsInsight')}
            {onViewInsight !== undefined && (
              <Button
                type="button"
                size="sm"
                variant="link"
                className="px-1"
                data-testid="view-insight"
                onClick={() => onViewInsight(savedInsightId)}
              >
                {t('research.resultActions.viewInsight')}
              </Button>
            )}
          </p>
        )}
        {hasSavedNote && savedNoteId !== null && (
          <p className="text-muted-foreground" role="status" data-testid="saved-note">
            {t('research.resultActions.savedAsNote')}
            {onViewNote !== undefined && (
              <Button
                type="button"
                size="sm"
                variant="link"
                className="px-1"
                data-testid="view-note"
                onClick={() => onViewNote(savedNoteId)}
              >
                {t('research.resultActions.viewNote')}
              </Button>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
