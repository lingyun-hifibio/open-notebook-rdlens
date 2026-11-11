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
  type CompareDenyReason,
} from '@/lib/research/compare'
import { useResearchScope, type ResearchScopeMode } from '@/lib/research/scope'
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
 * RWV2-11（K2/K7）：Scope 真源唯一——面板直接消费共享 Provider。
 * **capability false（legacy）路径逐字节不变**：`all` 模式无显式 Source
 * 集合 → 前置阻断（`reason:'all'`），`selected` 从已加载 `sources` 数组
 * 映射 `document_ids`（列表外的 selected source 静默不参与）。
 *
 * #1017（D1-H，C05 声明范围）：`capabilities.c05.entries.compare.execution_ready
 * === true` 时父层传 `c05Ready`，面板：
 * - `all` 不再阻断（文档集合由服务端在受理时点解析，覆盖分页外资料）；
 * - `selected` 发送 scope provider 的 `source_ids`（**不再**经已加载
 *   sources 映射 `document_ids`）；仅对已加载且能取到 `document_id` 的行
 *   按文档去重（保留首个），分页外 selected 原样发送（服务端解析精确
 *   版本；同文档多版本由服务端 422 `compare_duplicate_document_versions`
 *   稳定拒绝并在 UI 显示，不静默合并/丢弃）；
 * - `single` 不在 Compare 提供（面板显式阻断，服务端同样拒绝）。
 * 实际 C05 请求由**父层**按 scope provider 快照装配；本组件仍只调用
 * `onCreate(documentIds, groupSize)`（形状不变），C05 分支传入的是
 * source ids 投影（父层自行按快照装配，忽略该实参的 legacy 语义）。
 */
export function ComparePanel({
  sources,
  isCreating,
  error,
  errorCode,
  onCreate,
  modelBlocked: modelBlockedProp,
  blockedHint,
  c05Ready = false,
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
  /** #1017：`capabilities.c05.entries.compare.execution_ready === true` */
  c05Ready?: boolean
}) {
  const { t } = useTranslation()
  const [submitted, setSubmitted] = useState(false)
  const { mode, getSnapshot } = useResearchScope()

  // K2 前置：all → 明确消息；selected → 快照 ID 映射 + 既有边界
  // PR5（D-16）：以"文档"为计量单位 → 按 document_id 去重后计数，
  // 同文档多版本共选不得被当两篇文献（C-05 允许 mixed_versions）
  const snapshot = getSnapshot()
  const declaredSelection = c05Ready
    ? projectCompareDeclaredSelection(mode, snapshot.sourceIds, sources)
    : null
  const selectedSourceRows =
    !c05Ready && mode === 'selected'
      ? sources.filter((source) => source.source_id !== null && snapshot.sourceIds.includes(source.source_id))
      : []
  // D-16（评审 HIGH-2 更正）：Compare 的 `document_ids` 属**文档语义**，
  // 必须按 `document_id` 去重后再作执行载荷。此前"保留精确版本"的写法基于
  // 一个**已被证伪的前提**——`POST /compare/jobs` 只接受 `document_ids`，
  // 且服务端逐条 `get_latest_version(doc_id)`（router.py:2562-2570）：
  //   · 传重复的同一 doc_id 不会保住旧版本，只会让服务端把 (doc, 最新版)
  //     解析两次 → 出现"A 与 A 比较"；
  //   · 精确版本在本端点**无法表达**（见交付文档的 wire 缺口登记）。
  // 因此 execution 载荷与计量面统一走唯一文档集合；同文档多版本合并为一次
  // 比较。C05 分支改由 `source_scope.source_ids` 表达（父层装配），本投影
  // 只用于面板计量/展示与 `onCreate` 实参。
  const uniqueDocuments = uniqueDocumentIds(selectedSourceRows)
  const documentCount = countUniqueDocuments(selectedSourceRows)
  const check: ComparePanelCheck = (() => {
    if (c05Ready) {
      // `single` 是临时单篇限定，Compare 是多来源动作 → 不提供（服务端
      // 同样以 `compare_scope_mode_unsupported` 拒绝；不在客户端静默改写
      // 成 all/selected）。
      if (mode === 'single') {
        return {
          ok: false,
          reason: 'single',
          count: declaredSelection?.sourceIds.length ?? 0,
        }
      }
      if (mode === 'all') {
        // 服务端解析；客户端没有文档集合可计数（不是"空选"）。
        return { ok: true, count: 0, overDefault: false }
      }
      const count = declaredSelection?.sourceIds.length ?? 0
      if (count === 0) return { ok: false, reason: 'empty', count: 0 }
      if (count > COMPARE_HARD_MAX) return { ok: false, reason: 'over_hard', count }
      // 已加载行已按文档去重；分页外 selected 无法在客户端判定文档身份，
      // 计入上界（服务端解析为精确文档/版本并以稳定码拒绝重复版本）。
      const floor = checkCompareDocumentFloor(count)
      if (!floor.ok) return { ok: false, reason: floor.reason, count }
      return { ok: true, count, overDefault: count > COMPARE_DEFAULT_MAX }
    }
    // ── legacy（capability false）：既有判定逐字节不变 ──
    if (mode === 'all') return { ok: false, reason: 'all', count: 0 }
    // D-16：上限/提示按唯一文档数计；同文档多版本合并后不足两份 → 阻断
    const floor = checkCompareDocumentFloor(documentCount.uniqueDocumentCount)
    if (!floor.ok) {
      return { ok: false, reason: floor.reason, count: documentCount.uniqueDocumentCount }
    }
    return {
      ...checkCompareSelection(uniqueDocuments),
      count: documentCount.uniqueDocumentCount,
    }
  })()

  const modelBlocked = modelBlockedProp === true
  const mergedDuplicates = c05Ready
    ? declaredSelection?.mergedDuplicates === true
    : documentCount.mergedDuplicates

  const handleCreate = async () => {
    if (!check.ok || isCreating || modelBlocked) return
    // #1017：C05 分支传 scope provider 的 source ids 投影（`all` 为 `[]`）；
    // legacy 分支保持既有 document_ids 映射。父层负责 C05 载荷装配。
    const payload = c05Ready ? (declaredSelection?.sourceIds ?? []) : uniqueDocuments
    // 只在守卫真正派发（本地模型直接执行 / 外部模型确认完成）后置位；
    // consent 取消时 onCreate 返回 false，「已创建」提示不出现
    const sent = await onCreate(payload)
    if (sent) setSubmitted(true)
  }

  const disabled = !check.ok || isCreating || modelBlocked

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t('research.compareTitle')}</h2>
          <p className="text-xs text-muted-foreground">
            {c05Ready && mode === 'all' ? (
              t('research.compareScopeAll')
            ) : (
              <>
                {t('research.compareSelected')}: {check.count} / {COMPARE_DEFAULT_MAX}
                {' · '}
                {t('research.compareHardMax')}: {COMPARE_HARD_MAX}
              </>
            )}
          </p>
        </div>
        <Button onClick={handleCreate} disabled={disabled} data-testid="compare-create">
          {isCreating ? t('research.compareCreating') : t('research.compareCreate')}
        </Button>
      </div>

      {/* #1017：能力就绪 + all → 声明范围（服务端解析）；不再显示既有全部
          项目阻断文案，也不假装客户端知道具体文档集合。 */}
      {c05Ready && mode === 'all' && (
        <Alert variant="default" data-testid="compare-declared-all">
          <AlertDescription>{t('research.compareScopeAllHint')}</AlertDescription>
        </Alert>
      )}
      {/* #1017：分页外 selected 原样发送（服务端解析版本），提示而不是静默丢弃 */}
      {c05Ready && mode === 'selected' && (declaredSelection?.unloadedSelectedCount ?? 0) > 0 && (
        <Alert variant="default" data-testid="compare-declared-unloaded">
          <AlertDescription>{t('research.compareScopeSelectedUnloaded')}</AlertDescription>
        </Alert>
      )}
      {c05Ready && !check.ok && check.reason === 'single' && (
        <Alert variant="default" data-testid="compare-declared-single-unsupported">
          <AlertDescription>{t('research.compareScopeSingleUnsupported')}</AlertDescription>
        </Alert>
      )}
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
      {check.ok && mergedDuplicates && (
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

/** 面板判定结果：legacy 原因集 + C05 新增 `single`（Compare 不提供单篇限定）。 */
type ComparePanelCheck =
  | { ok: true; count: number; overDefault: boolean }
  | { ok: false; reason: CompareDenyReason | 'single'; count: number }

/**
 * #1017：把 scope provider 快照投影为 **C05 `selected` 的 source ids**。
 *
 * - 已加载且能取到 `document_id` 的 selected 行：按 `document_id` 去重
 *   （保留首个）——语义同 legacy `uniqueDocumentIds`，已加载范围内同文档
 *   v1+v2 合并为一份；
 * - 已加载但无 `document_id` 的行 / 分页外 selected：原样保留（客户端
 *   无法判定文档身份，服务端在受理时点解析精确版本；重复版本由服务端
 *   `compare_duplicate_document_versions` 拒绝）；
 * - `all`/`single`：不产生 source ids（`all` 由服务端解析；`single` 阻断）。
 *
 * 导出供父层（`ResearchWorkspace` / target 壳）按同一份快照装配
 * `source_scope`，避免面板与派发路径出现两套去重口径。
 */
export function projectCompareDeclaredSelection(
  mode: ResearchScopeMode,
  snapshotSourceIds: readonly string[],
  sources: readonly ResearchSource[],
): {
  sourceIds: string[]
  loadedSelectedCount: number
  unloadedSelectedCount: number
  mergedDuplicates: boolean
} {
  if (mode !== 'selected') {
    return {
      sourceIds: [],
      loadedSelectedCount: 0,
      unloadedSelectedCount: 0,
      mergedDuplicates: false,
    }
  }
  const loadedBySourceId = new Map<string, ResearchSource>()
  for (const source of sources) {
    if (typeof source.source_id === 'string' && source.source_id.length > 0) {
      loadedBySourceId.set(source.source_id, source)
    }
  }
  const seenDocumentIds = new Set<string>()
  const sourceIds: string[] = []
  let loadedSelectedCount = 0
  let unloadedSelectedCount = 0
  let mergedDuplicates = false
  for (const sourceId of snapshotSourceIds) {
    if (typeof sourceId !== 'string' || sourceId.length === 0) continue
    const row = loadedBySourceId.get(sourceId)
    const documentId = row?.document_id
    if (row !== undefined && typeof documentId === 'string' && documentId.length > 0) {
      loadedSelectedCount += 1
      if (seenDocumentIds.has(documentId)) {
        mergedDuplicates = true
        continue
      }
      seenDocumentIds.add(documentId)
      sourceIds.push(sourceId)
      continue
    }
    // 分页外（或暂无 document 身份）：不做预去重，交给服务端解析/稳定拒绝。
    unloadedSelectedCount += 1
    sourceIds.push(sourceId)
  }
  return { sourceIds, loadedSelectedCount, unloadedSelectedCount, mergedDuplicates }
}
