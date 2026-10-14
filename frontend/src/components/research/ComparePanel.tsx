'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  checkCompareDocumentFloor,
  checkCompareSelection,
  COMPARE_DEFAULT_MAX,
  COMPARE_HARD_MAX,
} from '@/lib/research/compare'
import { useResearchScope } from '@/lib/research/scope'
import { countUniqueDocuments, uniqueDocumentIds } from '@/lib/research/document-set'
import { userErrorMessageKey } from '@/lib/research/errors'
import type { ResearchSource } from '@/lib/types/research'

/**
 * Compare 面板（UI-03，REQ-QUOTA-01，设计 §7.4/§13）。
 *
 * 将选中的 Source 映射为 document_ids；前置校验边界：≤30 直接允许、
 * 31–50 提示超默认、>50（51+）禁用创建（服务端 422 的前置客户端校验）、
 * 空选禁用。创建即提交持久 Job（服务端执行，浏览器关闭继续）；
 * 提交反馈为本地 UI 状态，Job 真实状态以 Jobs 面板轮询为准。
 *
 * RWV2-11（K2/K7）：Scope 真源唯一——面板直接消费共享 Provider；
 * `all` 模式无显式 Source 集合（Compare 是 Source-only 动作，且
 * 当前来源列表受 20 条/页限制，全量映射必静默截断）→ **mode 前置判断**
 * 产生 `reason:'all'` 明确英文消息并禁用创建，不落入通用
 * `empty`；`selected` 模式从快照 ID 映射 document_ids（`sources` prop 来自
 * 查询缓存单源；映射基于已加载列表，列表外的 selected source 静默不参与
 * ——删除/失效清理属 RWV2-14，此处如实登记为已知限制）。
 */
export function ComparePanel({
  sources,
  isCreating,
  error,
  errorCode,
  onCreate,
  modelBlocked: modelBlockedProp,
  blockedHint,
}: {
  sources: ResearchSource[]
  isCreating: boolean
  error: string | null
  /** RWV2-42：错误稳定码（HTTP detail.code 或本地前置码），驱动主文案映射 */
  errorCode?: string | null
  /** 返回是否真正派发（守卫未确认/取消时为 false），避免取消后误报已创建 */
  onCreate: (documentIds: string[], groupSize?: number) => Promise<boolean>
  /** #243：无可用全局模型时禁用创建（不变量 2/7 的 Compare 侧表达） */
  modelBlocked?: boolean
  blockedHint?: string | null
}) {
  const { t } = useTranslation()
  const [submitted, setSubmitted] = useState(false)
  const { mode, getSnapshot } = useResearchScope()

  // K2 前置：all → 明确消息；selected → 快照 ID 映射 + 既有边界
  // PR5（D-16）：以"文档"为计量单位 → 按 document_id 去重后计数，
  // 同文档多版本共选不得被当两篇文献（C-05 允许 mixed_versions）
  const snapshot = getSnapshot()
  const selectedSourceRows =
    mode === 'selected'
      ? sources.filter((source) => source.source_id !== null && snapshot.sourceIds.includes(source.source_id))
      : []
  // R1-H6 修复：**执行载荷保留精确 Source 集合**（服务端 document_ids 解析
  // 会取最新版——去重会静默丢精确版本）。uniqueDocumentIds 仅用于**计数**
  // 与"合并多版本"提示（D-16 的计量面），不再替换执行输入。
  // R2-H6 修复：阈值/显示按**唯一文档数**判定（D-16 计量面）；
  // 执行载荷仍是不去重的 document_id 映射（精确版本语义——服务端按
  // source_ids 解析版本，不去重不丢版本）。
  const selectedDocuments = selectedSourceRows.map((source) => source.document_id)
  const documentCount = countUniqueDocuments(selectedSourceRows)
  const check = (() => {
    if (mode === 'all') return { ok: false, reason: 'all', count: 0 } as const
    // D-16：上限/提示按唯一文档数计；同文档多版本合并后不足两份 → 阻断
    const floor = checkCompareDocumentFloor(documentCount.uniqueDocumentCount)
    if (!floor.ok) return { ok: false, reason: floor.reason, count: documentCount.uniqueDocumentCount } as const
    return {
      ...checkCompareSelection(uniqueDocumentIds(selectedSourceRows)),
      count: documentCount.uniqueDocumentCount,
    }
  })()

  const modelBlocked = modelBlockedProp === true

  const handleCreate = async () => {
    if (!check.ok || isCreating || modelBlocked) return
    // 只在守卫真正派发（本地模型直接执行 / 外部模型确认完成）后置位；
    // consent 取消时 onCreate 返回 false，「已创建」提示不出现
    const sent = await onCreate(selectedDocuments)
    if (sent) setSubmitted(true)
  }

  const disabled = !check.ok || isCreating || modelBlocked

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t('research.compareTitle')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('research.compareSelected')}: {check.count} / {COMPARE_DEFAULT_MAX}
            {' · '}
            {t('research.compareHardMax')}: {COMPARE_HARD_MAX}
          </p>
        </div>
        <Button onClick={handleCreate} disabled={disabled} data-testid="compare-create">
          {isCreating ? t('research.compareCreating') : t('research.compareCreate')}
        </Button>
      </div>

      {check.ok && check.overDefault && (
        <Alert variant="default" data-testid="compare-over-default">
          <AlertDescription>{t('research.compareOverDefault')}</AlertDescription>
        </Alert>
      )}
      {!check.ok && check.reason === 'over_hard' && (
        <Alert variant="destructive" data-testid="compare-over-hard">
          <AlertDescription>
            {t('research.compareOverHard', { count: check.count })}
          </AlertDescription>
        </Alert>
      )}
      {check.ok && documentCount.mergedDuplicates && (
        <Alert variant="default" data-testid="compare-merged-versions">
          <AlertDescription>{t('research.compareMergedVersions')}</AlertDescription>
        </Alert>
      )}
      {!check.ok && check.reason === 'empty' && (
        <Alert variant="default" data-testid="compare-empty">
          <AlertDescription>{t('research.compareEmpty')}</AlertDescription>
        </Alert>
      )}
      {!check.ok && check.reason === 'all' && (
        <Alert variant="default" data-testid="compare-entire-project">
          <AlertDescription>{t('research.compareEntireProjectRequiresSelection')}</AlertDescription>
        </Alert>
      )}
      {/* PR5（D-16）：同文档多版本共选被合并后不足两份文献 → 按不足阻断，
          文案必须说"需要两份不同文档"，不得写成"没有可用资料"（D-11）。 */}
      {!check.ok && check.reason === 'single_document' && (
        <Alert variant="default" data-testid="compare-single-document">
          <AlertDescription>{t('research.compareNeedsTwoDocuments')}</AlertDescription>
        </Alert>
      )}
      {modelBlocked && blockedHint && (
        <Alert variant="default" data-testid="compare-model-blocked-hint">
          <AlertDescription>{blockedHint}</AlertDescription>
        </Alert>
      )}
      {/* RWV2-42（R4-H2）：仅当 UI 前置校验通过且模型可用时才渲染 hook 错误行
          ——避免与专用 Alert（empty/over-hard/entire-project/modelBlocked）
          同场景双文案；raw 消息仅作次级诊断行 */}
      {error && error.trim() !== '' && check.ok && !modelBlocked && (
        <Alert variant="destructive" data-testid="compare-error">
          <AlertDescription className="space-y-1">
            <span className="font-medium">{t(userErrorMessageKey(errorCode))}</span>
            <span className="block text-xs opacity-80">{error}</span>
          </AlertDescription>
        </Alert>
      )}
      {submitted && !error && (
        <Alert variant="default" data-testid="compare-submitted">
          <AlertDescription>{t('research.compareCreated')}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
