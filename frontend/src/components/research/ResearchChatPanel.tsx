'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { ResultActions } from './ResultActions'
import { COVERAGE_SOURCE_HARD_MAX, CoverageScopeSelector } from './CoverageScopeSelector'
import { CoverageJobDetails } from './CoverageJobDetails'
import { RETRYABLE_SSE_ERROR_CODES } from '@/lib/research/sse'
import { userErrorMessageKey } from '@/lib/research/errors'
import type {
  ResearchBackgroundNotice,
  ResearchChatSaveOrigin,
  ResearchChatTurn,
  ResearchChatSelection,
} from '@/lib/hooks/use-research-chat'
import type { ResearchCitationDisplayItem, ResearchJob, ResearchSynthesisScope } from '@/lib/research/types'
import { formatScopeLabel, useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import { ResearchSessionScopeBar } from './ResearchSessionScopeBar'
import {
  ResearchDraftComposer,
  deriveResearchDraftGate,
  researchDraftGateReasonKey,
} from './ResearchDraftComposer'
import {
  measureChatAnchorCandidates,
  restoreScrollTop,
} from '@/lib/research/reading-anchor'
import type {
  EditorSnapshot,
  ResearchConversationSnapshot,
  ResearchDraftGate,
  ResearchScopeBarNoteOption,
  ResearchScopeBarSourceOption,
  ScopeEdit,
} from '@/lib/research/types'
import type { WireChatAnchor } from '@/lib/research/session-contract'

/**
 * Research Chat 面板（UI-03，REQ-ENG-04/REQ-API-02；COV-09 §12.3）。
 *
 * - 「相关证据回答」走同步 SSE（既有流式 turn）；「覆盖全部所选来源
 *   （Sources）」显式选择（REQ-COV-01），提交后 202 受理并绑定持久 Job，
 *   以 CoverageJobDetails 展示 stage/progress/逐文档状态/最终报告。
 * - 选择 Notes 时 all_selected 选项禁用并展示文字说明（Notes Coverage
 *   首期不支持，§6.1）；1～50 Source 前端预检（服务端仍是权威）。
 * - 普通 QA raw Thinking 防御性丢弃：thinking 事件只展示固定进度摘要
 *   （客户端 i18n 文案），即使后端误发 reasoning 也不进入用户内容
 *   （§12.3 验收：raw Thinking、Prompt、内部 JSON 不可见）。
 * - 断线自动重连时显示重连徽标；错误终态展示 code/可重试标记。
 * - #292 P0：error 且空正文不渲染「暂无答案」占位（交由错误卡片呈现）；
 *   RWV2-42（AC8）：稳定错误码统一走集中表映射（lib/research/errors），
 *   raw code/errorMessage 仅作诊断行，不作主消息（未知码回落通用文案）。
 */
/** Issue #439：后台任务 CTA 的提交结果（区分"未派发"与"失败"，避免误报）。 */
export type BackgroundJobSubmitResult =
  /** 已受理（jobId 缺失时只提示刷新，不得当失败——否则用户会重复提交） */
  | { status: 'queued'; jobId: string | null }
  /** 守卫未执行（如外部模型确认被取消）：不算失败，保持可再次点击 */
  | { status: 'not_dispatched' }
  /**
   * PR5（D-26）：`all` 在本入口的契约下**无法表达** → 显式阻断（D-11）。
   * 与 `failed` 分开，UI 才能给"请先选择资料"而不是通用提交失败。
   */
  | { status: 'blocked_scope' }
  | { status: 'failed' }

/** PR-4：由会话 editor 快照派生 legacy `ResearchChatSelection`（§5.3 执行范围编码）。 */
function selectionFromEditorSnapshot(snapshot: EditorSnapshot): ResearchChatSelection {
  if (snapshot.singleSourceId !== null) {
    // mode 必须是 'single'：legacy deriveScopeSnapshot 仅在 mode==='single' 时
    // 保留 singleSourceId，否则限定在派发链路被丢弃（§5.3 执行范围编码）。
    return {
      mode: 'single',
      sourceIds: [],
      noteIds: [...snapshot.noteIds],
      singleSourceId: snapshot.singleSourceId,
    }
  }
  return {
    mode: snapshot.baseScope?.mode ?? 'all',
    sourceIds: snapshot.baseScope !== null ? [...snapshot.baseScope.sourceIds] : [],
    noteIds: [...snapshot.noteIds],
    singleSourceId: null,
  }
}

export function ResearchChatPanel({
  turns,
  isStreaming,
  onSend,
  onSendCoverage,
  sendDisabled,
  blockedHint,
  coverageEnabled = false,
  coverageJobs,
  onCoverageRetry,
  onCitationJump,
  backgroundNotice,
  onRunAsBackgroundJob,
  backgroundJobRequiresSelection = false,
  resolveChatOrigin,
  onViewInsight,
  onViewNote,
  prefill,
  editorSnapshot,
  conversationSnapshot,
  submissionReady,
  scopeSources,
  scopeNotes,
  onChangeScope,
  onDraftChange,
  onRetrySave,
  onRestoreDraft,
  onChatAnchorChange,
}: {
  turns: ResearchChatTurn[]
  isStreaming: boolean
  /**
   * 返回是否已真正派发。Issue #243 §6.4：外部模型需确认时执行被推迟，
   * 调用方据此决定「派发后」的清理（如清空输入），使取消零副作用。
   */
  onSend: (query: string, selection?: ResearchChatSelection) => Promise<boolean>
  /** COV-09：all_selected 提交；RWV2-11（K9）携带派发时冻结的快照 */
  onSendCoverage: (query: string, snapshot: ResearchScopeSnapshot) => Promise<boolean>
  /** #243：无可用全局模型时禁用发送（不变量 2/7 的 Chat 侧表达） */
  sendDisabled?: boolean
  blockedHint?: string | null
  /**
   * #358：后端 Coverage 能力（GET models 顶层 capabilities
   * coverage_all_selected）。false/缺失/加载中一律 false（fail-closed）——
   * 禁用 all_selected 且不发送 Coverage 创建请求；普通 relevant 不受影响。
   * 既有 Coverage Job 的展示与轮询不依赖本值（§17.2 准入开关而非终止开关）。
   */
  coverageEnabled?: boolean
  /** COV-09：Coverage Job 快照列表（Chat 任务卡按 job_id 查找） */
  coverageJobs?: ResearchJob[]
  /** COV-09：outcome_unknown 人工重试（§12.2） */
  onCoverageRetry?: (jobId: string) => Promise<boolean>
  /** COV-09：报告 Citation 跳转到现有授权预览/来源链路 */
  onCitationJump?: (citation: ResearchCitationDisplayItem) => void
  /**
   * Issue #302：刷新恢复后仍在后台/未完成的后台 Generation 提示——静态
   * 如实呈现（绝不渲染为假「进行中」流式态）。
   */
  backgroundNotice?: ResearchBackgroundNotice | null
  /**
   * Issue #439：`persistent_job_required` 的出口——以该 turn 冻结的
   * Scope 经 v1 search 端点重跑为持久化 Job（重试同一请求恒徒劳）。
   * 返回 job id 表示已受理；null/异常表示提交失败。
   */
  onRunAsBackgroundJob?: (
    query: string,
    snapshot: ResearchScopeSnapshot,
    /** 该 turn 的稳定键：调用方据此复用幂等键（重复点击不产生第二个 Job） */
    turnKey: string,
  ) => Promise<BackgroundJobSubmitResult>
  /**
   * PR5（D-26/D-11）：后台 CTA 所在入口的契约**需要显式资料集合**（C-05 未
   * 就绪 / 旧 v1 端点）。为 true 时 `all` 的快照无法表达 → CTA 就近说明并
   * 禁用（不派发空 ID 集）；为 false（C-05 已就绪）时 `all` 走 source_scope。
   */
  backgroundJobRequiresSelection?: boolean
  /** RWV2-23（D2）：live 轮 Save 的惰性 chat origin 解析（generation_id） */
  resolveChatOrigin?: (turnId: string) => Promise<ResearchChatSaveOrigin | null>
  /** RWV2-23（AC3）：保存成功后跳转 Results/Insights 或 Materials/Notes */
  onViewInsight?: (insightId: string) => void
  onViewNote?: (noteId: string) => void
  /** RWV2-23（AC4）：Continue research 预填草稿（seq 递增触发；挂载时生效） */
  prefill?: { text: string; seq: number } | null
  /**
   * PR-4 会话 editor 接线（DESIGN §9.6）：`undefined` = 宿主未装配 session
   * runtime（保持 PR-2 前的本地输入回退路径，PR-5a 移除）；`null` = runtime
   * 已装配但当前无可用全局会话（composer 禁用并显示原因）。
   */
  editorSnapshot?: EditorSnapshot | null
  /** PR-4：对话快照（isStreaming/busy/activeTurnId）；缺省由 props 推导。 */
  conversationSnapshot?: ResearchConversationSnapshot
  /** 会话 `submission_ready` capability（§6.1 条件 2）；缺省表示未接入该门禁。 */
  submissionReady?: boolean
  /** PR-4：范围条投射的工作区资料（不写工作区选择，只读呈现）。 */
  scopeSources?: readonly ResearchScopeBarSourceOption[]
  scopeNotes?: readonly ResearchScopeBarNoteOption[]
  onChangeScope?: (edit: ScopeEdit) => void
  onDraftChange?: (text: string) => void
  onRetrySave?: () => void
  onRestoreDraft?: (writerId: string) => void
  /** PR-4：滚动空闲 1000ms 后上报消息锚点（§5.7.1）。 */
  onChatAnchorChange?: (anchor: WireChatAnchor | null) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ResearchSynthesisScope>('relevant')
  // PR-4：editor 接线标记——undefined 表示宿主未装配 runtime（过渡回退）。
  const wired = editorSnapshot !== undefined
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const anchorTimerRef = useRef<number | null>(null)
  const restoringRef = useRef(false)
  // §5.7.1：恢复失败（缺目标/越界/非法偏移）→ 稳定原因可见，停在有权版本顶部。
  const [anchorUnavailable, setAnchorUnavailable] = useState(false)
  const wiredConversation: ResearchConversationSnapshot = conversationSnapshot ?? {
    isBusy: isStreaming,
    isStreaming,
    activeTurnId: null,
    phase: isStreaming ? 'streaming' : 'idle',
  }

  // RWV2-23（AC4）：Continue research 预填（跨 keep-alive：首访挂载与后续
  // 递增 seq 都生效）；不自动派发——发送仍需用户点 Send（既有守卫）。
  useEffect(() => {
    if (prefill && prefill.text.trim() !== '') {
      if (wired) onDraftChange?.(prefill.text)
      else setQuery(prefill.text)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅响应 seq 递增
  }, [prefill?.seq])
  const generationBlocked = sendDisabled === true
  // RWV2-11（K7）：Scope 真源唯一——面板直接消费共享 Provider
  const { mode, getSnapshot } = useResearchScope()
  // RWV2-11（K3）：all_selected 只适用于显式 selected 范围（1～50 Source、无
  // Notes）。`all` 无显式 Source 集合（后端空数组必 422
  // coverage_sources_empty）——提交闸门单点（K3/W4），CoverageScopeSelector
  // 只出 notice。
  const dispatchSnapshot = getSnapshot()
  // #358：能力门禁并入提交闸门——后端未开启 Coverage 时（capability
  // false/缺失/加载中）不允许 all_selected，且不发送创建请求；既有
  // Coverage Job 的展示与轮询与 coverageEnabled 无关（§17.2）。
  const coverageAllowed =
    coverageEnabled &&
    mode === 'selected' &&
    dispatchSnapshot.sourceIds.length > 0 &&
    dispatchSnapshot.sourceIds.length <= COVERAGE_SOURCE_HARD_MAX &&
    dispatchSnapshot.noteIds.length === 0

  // PR-4 发送门禁（§6.1）：composer 按钮 disabled 之外必须给出稳定原因。
  const composerGate: ResearchDraftGate = (() => {
    if (!wired) return { allowed: true, reason: null }
    const derived = deriveResearchDraftGate({
      editorSnapshot: editorSnapshot ?? null,
      conversationSnapshot: wiredConversation,
      submissionReady,
    })
    if (derived.allowed && generationBlocked) {
      return { allowed: false, reason: 'turn_active' }
    }
    if (derived.allowed && scope === 'all_selected' && !coverageAllowed) {
      return { allowed: false, reason: 'scope_invalid' }
    }
    return derived
  })()
  const composerGateReasonText: string | null = composerGate.allowed
    ? null
    : (generationBlocked ? blockedHint ?? t('research.errors.generationInProgress') : null) ??
      (scope === 'all_selected' && !coverageAllowed
        ? t('research.coverage.capabilityDisabled')
        : t(researchDraftGateReasonKey(composerGate.reason ?? 'runtime_unavailable')))

  // Issue #439：persistent_job_required 的提交态与结果（一律按 turn 记录，
  // 避免跨 turn 泄漏；成功后按钮常驻禁用 → 重复点击不产生第二个 Job）
  const [jobSubmittingTurn, setJobSubmittingTurn] = useState<string | null>(null)
  const [jobQueuedByTurn, setJobQueuedByTurn] = useState<
    Record<string, string | null>
  >({})
  const [jobErrorByTurn, setJobErrorByTurn] = useState<Record<string, string>>({})

  /** 该 error turn 对应的提问：向前找最近一条 user turn（不假设紧邻）。 */
  const queryForTurn = (target: ResearchChatTurn): string => {
    const index = turns.indexOf(target)
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = turns[cursor]
      if (candidate.role === 'user' && candidate.content.trim() !== '') {
        return candidate.content
      }
    }
    return ''
  }

  /**
   * PR5（D-26/D-11）：该 turn 的后台 CTA 是否被范围语义阻断。
   * `backgroundJobRequiresSelection` 由组合根给出（C-05 是否已就绪）；
   * `all` 在需要显式 ID 集合的契约下无法表达 → 阻断，绝不发空 ID 集。
   */
  const scopeUnavailableFor = (target: ResearchChatTurn): boolean =>
    backgroundJobRequiresSelection && target.scopeSnapshot?.mode !== 'selected'

  const runBackgroundJob = async (target: ResearchChatTurn) => {
    if (!onRunAsBackgroundJob || target.scopeSnapshot === null) return
    if (jobQueuedByTurn[target.id] !== undefined) return // 已受理，禁止重复提交
    // D-26：就近阻断也已生效，这里再兜一层——绝不把 `all` 发成空 ID 集
    if (scopeUnavailableFor(target)) {
      setJobErrorByTurn((prev) => ({
        ...prev,
        [target.id]: t('research.errors.backgroundJobBlockedScope'),
      }))
      return
    }
    const query = queryForTurn(target)
    if (!query.trim()) return
    setJobSubmittingTurn(target.id)
    setJobErrorByTurn((prev) => {
      const next = { ...prev }
      delete next[target.id]
      return next
    })
    try {
      const result = await onRunAsBackgroundJob(
        query,
        target.scopeSnapshot,
        target.id,
      )
      if (result.status === 'queued') {
        setJobQueuedByTurn((prev) => ({ ...prev, [target.id]: result.jobId }))
      } else if (result.status === 'blocked_scope') {
        // D-26：阻断文案必须与 D-11 一致（"请先选择资料"），不得写成通用失败
        setJobErrorByTurn((prev) => ({
          ...prev,
          [target.id]: t('research.errors.backgroundJobBlockedScope'),
        }))
      } else if (result.status === 'failed') {
        setJobErrorByTurn((prev) => ({
          ...prev,
          [target.id]: t('research.errors.persistentJobSubmitFailed'),
        }))
      }
      // not_dispatched（确认弹窗被取消等）：保持无错误、可再次点击
    } catch {
      setJobErrorByTurn((prev) => ({
        ...prev,
        [target.id]: t('research.errors.persistentJobSubmitFailed'),
      }))
    } finally {
      setJobSubmittingTurn(null)
    }
  }

  const submit = () => {
    // PR-4：接线后草稿真源在会话 editor；发送不 trim 覆盖正文（§5.4）。
    const rawText = wired ? editorSnapshot?.draftText ?? '' : query
    const trimmed = rawText.trim()
    if (!trimmed || generationBlocked) return
    if (wired && !composerGate.allowed) return
    // RWV2-11（K8/K9）：派发时刻冻结快照——submit 单次读取，提交闸门与载荷
    // 共用同一快照（P2-①，避免渲染期/提交期两次取值）；selection 携带 mode，
    // turn 记录由 hook 推导，consent/幂等/最终请求全部同源（K11）。
    const snapshot = getSnapshot()
    // R2-H4：显式提交路径的 selection 携带完整快照（含 singleSourceId），
    // 否则派发链路 deriveScopeSnapshot 会丢限定字段。
    const selectionWithScope: ResearchChatSelection =
      wired && editorSnapshot !== null && editorSnapshot !== undefined
        ? selectionFromEditorSnapshot(editorSnapshot)
        : {
            mode: snapshot.mode,
            sourceIds: [...snapshot.sourceIds],
            noteIds: [...snapshot.noteIds],
            singleSourceId: snapshot.singleSourceId,
          }
    if (scope === 'all_selected') {
      // #358：能力门禁在提交点再次校验（与 coverageAllowed 同源，且用
      // 派发时刻冻结快照）——能力 false/缺失时不发 Coverage 创建请求。
      const allowed =
        coverageEnabled &&
        mode === 'selected' &&
        snapshot.sourceIds.length > 0 &&
        snapshot.sourceIds.length <= COVERAGE_SOURCE_HARD_MAX &&
        snapshot.noteIds.length === 0
      if (!allowed) return
      void onSendCoverage(wired ? rawText : trimmed, snapshot).then((sent) => {
        // PR-4：接线后清稿由 PR-5a 的原子提交协议承担（§5.8）；未接线保留旧行为。
        if (sent && !wired) setQuery('')
      })
      return
    }
    // PR-4：接线后正文原样提交（不 trim 覆盖草稿），空值校验仍用 trimmed。
    void onSend(wired ? rawText : trimmed, selectionWithScope).then((sent) => {
      if (sent && !wired) setQuery('')
    })
  }

  // PR-4：锚点上报——滚动空闲 1000ms 计算一次（§5.7.1），恢复期间不写。
  const scheduleChatAnchor = (): void => {
    if (!wired || restoringRef.current || onChatAnchorChange === undefined) return
    if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = window.setTimeout(() => {
      anchorTimerRef.current = null
      const container = chatScrollRef.current
      if (container === null) return
      const rect = container.getBoundingClientRect()
      // §5.7.1：live/恢复 user 轮没有稳定 message_id——几何仍参与测量，
      // 但只把最近的稳定消息写入 chat_anchor（临时 turn id 不持久化）。
      const messages = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-message-id], [data-local-message-id]',
        ),
      ).map((node) => {
        const nodeRect = node.getBoundingClientRect()
        return {
          messageId: node.dataset.messageId ?? '',
          stableMessageId: node.dataset.messageId ?? null,
          top: nodeRect.top,
          height: nodeRect.height,
        }
      })
      const anchor = measureChatAnchorCandidates({
        messages,
        container: {
          containerTop: rect.top,
          scrollTop: container.scrollTop,
          clientHeight: container.clientHeight,
          scrollHeight: container.scrollHeight,
        },
      })
      if (anchor !== null) {
        onChatAnchorChange(anchor)
        setAnchorUnavailable(false)
      }
    }, 1000)
  }

  useEffect(() => {
    return () => {
      if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current)
    }
  }, [])

  // PR-4：恢复消息锚点（§5.7.1）——只设 scrollTop，不动焦点、不写回锚点。
  const savedChatAnchor = wired ? editorSnapshot?.chatAnchor ?? null : null
  // live 轮解析出稳定 message_id 后要重新尝试恢复（turns.length 不变但 ID 集变了）。
  const stableMessageIdSignature = turns
    .map(turn => turn.serverMessageId ?? '')
    .join('|')
  useEffect(() => {
    if (!wired || savedChatAnchor === null) {
      restoringRef.current = false
      return
    }
    const container = chatScrollRef.current
    if (container === null) {
      restoringRef.current = false
      return
    }
    const target = Array.from(
      container.querySelectorAll<HTMLElement>('[data-message-id]'),
    ).find(node => node.dataset.messageId === savedChatAnchor.messageId) ?? null
    const rect = container.getBoundingClientRect()
    const targetRect = target?.getBoundingClientRect() ?? null
    restoringRef.current = true
    const result = restoreScrollTop({
      container: {
        containerTop: rect.top,
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
      },
      savedOffsetPx: savedChatAnchor.offsetPx,
      followTail: savedChatAnchor.followTail,
      currentTargetTop: targetRect !== null ? targetRect.top : null,
      targetHeightPx: targetRect !== null ? targetRect.height : undefined,
    })
    if (result.ok) container.scrollTop = result.scrollTop
    setAnchorUnavailable(!result.ok)
    // 程序化恢复期间忽略滚动上报；用 rAF 释放，确保浏览器补发的 scroll
    // 事件仍被抑制（不把刚恢复的位置当作新锚点写回）。
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        restoringRef.current = false
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== 0) window.cancelAnimationFrame(secondFrame)
      // 取消恢复帧时必须释放抑制标记，否则后续用户滚动不再保存锚点。
      restoringRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在锚点/消息集变化时恢复
  }, [
    wired,
    savedChatAnchor?.messageId,
    savedChatAnchor?.offsetPx,
    savedChatAnchor?.followTail,
    stableMessageIdSignature,
  ])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {wired && (
        <div className="shrink-0 border-b px-3 py-2">
          <ResearchSessionScopeBar
            editorSnapshot={editorSnapshot ?? null}
            sources={scopeSources ?? []}
            notes={scopeNotes ?? []}
            disabledReason={null}
            onChangeScope={onChangeScope ?? (() => {})}
          />
        </div>
      )}
      <div
        ref={chatScrollRef}
        className="flex-1 space-y-4 overflow-y-auto p-4"
        onScroll={scheduleChatAnchor}
        data-testid="chat-messages"
      >
        {wired && (anchorUnavailable || editorSnapshot?.positionUnavailable === true) && (
          <p
            className="text-xs font-medium text-amber-600"
            role="status"
            data-testid="chat-position-unavailable"
          >
            {t('research.editor.positionUnavailable')}
          </p>
        )}
        {turns.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('research.chatEmpty')}</p>
        )}
        {backgroundNotice && (
          <p
            className="text-xs font-medium text-amber-600"
            data-testid="chat-restore-notice"
          >
            {backgroundNotice.kind === 'running'
              ? t('research.chatRestoreRunning')
              : t('research.chatRestoreFailed')}
            {backgroundNotice.kind === 'failed' && backgroundNotice.failureCode
              ? ` · ${backgroundNotice.failureCode}`
              : ''}
          </p>
        )}
        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div
              key={turn.id}
              className="flex flex-col items-end gap-1"
              data-message-id={turn.serverMessageId ?? undefined}
              data-local-message-id={
                turn.serverMessageId === null ? turn.id : undefined
              }
            >
              <div className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-2 text-sm">
                {turn.content}
              </div>
              {/* RWV2-11：会话内 turn 显示派发 Scope 徽标。PR5（T9/D-01）：
                  刷新恢复的历史 turn 无法证明当时的范围 → 显式标注"范围
                  不可用"，**绝不**回填当前选择冒充历史范围。 */}
              {turn.scopeSnapshot !== null ? (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="chat-turn-scope-badge"
                >
                  {t('research.chatScopeBadge', {
                    scope: formatScopeLabel(turn.scopeSnapshot, t),
                  })}
                </span>
              ) : (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="chat-turn-scope-unavailable"
                >
                  {t('research.scopeDetails.turnScopeUnavailable')}
                </span>
              )}
            </div>
          ) : (
            <div key={turn.id} className="space-y-2" data-message-id={turn.serverMessageId ?? undefined}>
              {turn.coverageJobId !== null ? (
                <CoverageJobDetails
                  job={coverageJobs?.find((j) => j.job_id === turn.coverageJobId)}
                  onRetry={onCoverageRetry}
                  onCitationJump={onCitationJump}
                />
              ) : (
                <>
                  {turn.thinking && (
                    <details className="rounded-lg border px-3 py-2">
                      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                        {t('research.chatThinking')}
                      </summary>
                      {/* COV-09：raw Thinking 防御性丢弃——只展示固定进度摘要，
                          不渲染后端 thinking 内容（§12.3） */}
                      <div className="mt-2 text-sm text-muted-foreground">
                        {t('research.chatThinkingNotice')}
                      </div>
                    </details>
                  )}
                  {/* #292 P0：error 且空正文不渲染「暂无答案」——错误内容由
                      下方错误卡片呈现，避免占位与错误框同屏误导 */}
                  {(turn.content || turn.status !== 'error') && (
                    <div className="rounded-lg border px-3 py-2 text-sm">
                      {turn.content ? (
                        <MarkdownRenderer>{turn.content}</MarkdownRenderer>
                      ) : (
                        <span className="text-muted-foreground">{t('research.chatNoAnswer')}</span>
                      )}
                    </div>
                  )}

                  {(turn.usage || turn.resolvedMode) && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {turn.resolvedMode && <Badge variant="outline">{turn.resolvedMode}</Badge>}
                      {turn.usage && (
                        <span>
                          {t('research.chatUsage')}: {turn.usage.input_tokens} in
                          {turn.usage.thinking_tokens ? ` / ${turn.usage.thinking_tokens} think` : ''}
                          {' / '}
                          {turn.usage.output_tokens} out
                        </span>
                      )}
                    </div>
                  )}

                  <ResearchCitationList citations={turn.citations} />

                  {/* RWV2-23：已完成 Chat 答案的结果动作（Save/Copy）。
                      - generationId 已解析（恢复行或 live 完成即绑定）→ 直存；
                      - live 轮未解析 → 点击 Save 时经 resolveChatOrigin 惰性
                        解析（成功前 pending，失败给不可用文案）；
                      - 恢复行但 message_id 非 gen 形态 → 禁存 + 原因文案，
                        不猜测、不向后端发必然 404 的请求。 */}
                  {turn.status === 'done' &&
                    turn.content !== '' &&
                    turn.coverageJobId === null && (
                      <ResultActions
                        originKind="chat"
                        originId={turn.generationId}
                        resolveOriginId={
                          turn.generationId === null && turn.serverMessageId === null
                            ? () => (resolveChatOrigin
                                ? resolveChatOrigin(turn.id).then(
                                    (origin) => origin?.generationId ?? null,
                                  )
                                : Promise.resolve(null))
                            : undefined
                        }
                        showSave={
                          turn.generationId !== null ||
                          turn.serverMessageId !== null
                        }
                        saveDisabledReasonKey={
                          turn.generationId === null && turn.serverMessageId !== null
                            ? 'research.resultActions.chatSaveUnavailable'
                            : null
                        }
                        content={turn.content}
                        citations={turn.citations}
                        onViewInsight={onViewInsight}
                        onViewNote={onViewNote}
                      />
                    )}
                </>
              )}

              {turn.status === 'reconnecting' && (
                <p className="text-xs font-medium text-amber-600" data-testid="chat-reconnecting">
                  {t('research.chatReconnecting', { count: turn.reconnectCount })}
                </p>
              )}

              {turn.status === 'error' && turn.coverageJobId === null && (
                <div
                  className="space-y-1 rounded-lg border border-destructive/50 px-3 py-2 text-xs"
                  data-testid="chat-error"
                >
                  {/* #292 P0：稳定码展示本地化用户文案（集中映射，RWV2-42）；
                      未知码回落通用文案；errorMessage 仅作诊断行，不作主要提示 */}
                  <p className="font-medium text-destructive">
                    {t(userErrorMessageKey(turn.errorCode))}
                  </p>
                  {turn.errorMessage && (
                    <p className="text-muted-foreground">{turn.errorMessage}</p>
                  )}
                  <div className="flex items-center gap-2">
                    {/* RWV2-11（K12）：重试必须复用原 turn 的冻结快照——派发后
                        修改 Scope 不得影响重试；null（恢复轮）不渲染重试按钮，
                        永不静默以空数组=全项目派发（P1-①）。 */}
                    {turn.errorCode &&
                      RETRYABLE_SSE_ERROR_CODES.includes(turn.errorCode) &&
                      turn.scopeSnapshot !== null && (
                        <>
                          <Badge variant="secondary">{t('research.chatRetryable')}</Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const userTurn = turns[turns.indexOf(turn) - 1]
                              void onSend(userTurn?.content ?? '', {
                                mode: turn.scopeSnapshot!.mode,
                                sourceIds: [...turn.scopeSnapshot!.sourceIds],
                                noteIds: [...turn.scopeSnapshot!.noteIds],
                              })
                            }}
                          >
                            {t('research.chatRetry')}
                          </Button>
                        </>
                      )}
                  </div>
                  {/* Issue #439：必须转持久化 Job → 不可重试，改走后端任务 */}
                  {turn.errorCode === 'persistent_job_required' &&
                    turn.scopeSnapshot !== null &&
                    onRunAsBackgroundJob !== undefined && (
                      <div className="space-y-1" data-testid="chat-persistent-job">
                        <p className="text-muted-foreground">
                          {t('research.errors.persistentJobHint')}
                        </p>
                        {/* PR5（D-26/D-11）：该入口契约需要显式资料集合，而
                            该 turn 冻结的是 `all`（无法表达）→ 就近说明并禁用，
                            不发空 ID 集、也不误导成"提交失败"。 */}
                        {scopeUnavailableFor(turn) && (
                          <p
                            className="text-destructive"
                            data-testid="chat-persistent-job-blocked-scope"
                            role="alert"
                          >
                            {t('research.errors.backgroundJobBlockedScope')}
                          </p>
                        )}
                        <Button
                          size="sm"
                          disabled={
                            scopeUnavailableFor(turn) ||
                            jobSubmittingTurn === turn.id ||
                            jobQueuedByTurn[turn.id] !== undefined ||
                            queryForTurn(turn).trim() === ''
                          }
                          onClick={() => {
                            void runBackgroundJob(turn)
                          }}
                          data-testid="chat-persistent-job-submit"
                        >
                          {t('research.errors.persistentJobSubmit')}
                        </Button>
                        {jobQueuedByTurn[turn.id] !== undefined && (
                          <p
                            className="text-muted-foreground"
                            data-testid="chat-persistent-job-queued"
                          >
                            {t('research.backgroundQueued')}
                            {jobQueuedByTurn[turn.id] && (
                              <>
                                {' '}
                                <code>{jobQueuedByTurn[turn.id]}</code>
                              </>
                            )}
                          </p>
                        )}
                        {jobErrorByTurn[turn.id] && (
                          <p className="text-destructive" data-testid="chat-persistent-job-error">
                            {jobErrorByTurn[turn.id]}
                          </p>
                        )}
                      </div>
                    )}
                </div>
              )}
            </div>
          ),
        )}
        {isStreaming && (
          <p className="text-xs text-muted-foreground" data-testid="chat-streaming">
            {t('research.chatStreaming')}
          </p>
        )}
      </div>

      {generationBlocked && blockedHint && (
        <p
          className="border-t px-3 pt-2 text-xs text-muted-foreground"
          data-testid="chat-model-blocked-hint"
        >
          {blockedHint}
        </p>
      )}

      <div className="space-y-2 border-t p-3">
        <CoverageScopeSelector
          value={scope}
          onChange={setScope}
          scopeMode={mode}
          capabilityEnabled={coverageEnabled}
          selectedSourceCount={dispatchSnapshot.sourceIds.length}
          selectedNoteCount={dispatchSnapshot.noteIds.length}
        />
        {wired ? (
          <ResearchDraftComposer
            editorSnapshot={editorSnapshot ?? null}
            conversationSnapshot={wiredConversation}
            gate={composerGate}
            gateReasonText={composerGateReasonText}
            onDraftChange={onDraftChange ?? (() => {})}
            onSend={submit}
            onRetrySave={onRetrySave ?? (() => {})}
            onRestoreDraft={onRestoreDraft}
          />
        ) : (
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
              disabled={generationBlocked}
              placeholder={t('research.chatPlaceholder')}
              data-testid="chat-input"
            />
            <Button
              onClick={submit}
              disabled={!query.trim() || isStreaming || generationBlocked || (scope === 'all_selected' && !coverageAllowed)}
              data-testid="chat-send"
            >
              {t('research.chatSend')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
