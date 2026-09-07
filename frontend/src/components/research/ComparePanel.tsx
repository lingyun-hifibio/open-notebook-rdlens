'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  checkCompareSelection,
  COMPARE_DEFAULT_MAX,
  COMPARE_HARD_MAX,
} from '@/lib/research/compare'
import { useResearchScope } from '@/lib/research/scope'
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
 * `entire_project` 模式无显式 Source 集合（Compare 是 Source-only 动作，且
 * 当前来源列表受 20 条/页限制，全量映射必静默截断）→ **mode 前置判断**
 * 产生 `reason:'entire_project'` 明确英文消息并禁用创建，不落入通用
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

  // K2 前置：entire_project → 明确消息；selected → 快照 ID 映射 + 既有边界
  const snapshot = getSnapshot()
  const selectedDocuments =
    mode === 'selected'
      ? sources
          .filter((source) => snapshot.sourceIds.includes(source.source_id))
          .map((source) => source.document_id)
      : []
  const check =
    mode === 'entire_project'
      ? ({ ok: false, reason: 'entire_project', count: 0 } as const)
      : checkCompareSelection(selectedDocuments)

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
      {!check.ok && check.reason === 'empty' && (
        <Alert variant="default" data-testid="compare-empty">
          <AlertDescription>{t('research.compareEmpty')}</AlertDescription>
        </Alert>
      )}
      {!check.ok && check.reason === 'entire_project' && (
        <Alert variant="default" data-testid="compare-entire-project">
          <AlertDescription>{t('research.compareEntireProjectRequiresSelection')}</AlertDescription>
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
