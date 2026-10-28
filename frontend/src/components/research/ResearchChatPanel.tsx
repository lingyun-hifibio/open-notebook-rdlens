'use client'

import { useEffect, useRef, useState, type FocusEvent } from 'react'
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
import { allowsRetryAction } from '@/lib/research/c05-error-actions'
import { userErrorMessageKey } from '@/lib/research/errors'
import type {
  CoverageSubmitOutcome,
  ResearchBackgroundNotice,
  ResearchChatSaveOrigin,
  ResearchChatSessionMeta,
  ResearchChatTurn,
  ResearchChatSelection,
  ResearchSubmissionLookupSnapshot,
} from '@/lib/hooks/use-research-chat'
import type { UseResearchEditorResult } from '@/lib/hooks/use-research-editor'
import type {
  ConversationController,
  ConversationSnapshot,
} from '@/lib/research/session-runtime'
import type { ConversationTurn } from '@/lib/research/conversation-machine'
import type { ResearchCitation } from '@/lib/research/types'
import {
  projectSessionVisibility,
  sessionKey,
  type ResearchContextReportProjection,
  type ResearchSessionRef,
} from '@/lib/research/session-contract'
import type { ResearchGlobalChatCard } from '@/lib/research/api'
import { ResearchContextReport } from './ResearchContextReport'
import {
  ResearchSubmissionStatus,
  type ResearchSubmissionStatusView,
} from './ResearchSubmissionStatus'
import type { ResearchCitationDisplayItem, ResearchJob, ResearchSynthesisScope } from '@/lib/research/types'
import { formatScopeLabel, useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import { ResearchSessionScopeBar } from './ResearchSessionScopeBar'
import { hasUnpairedSurrogate } from '@/lib/research/editor-machine'
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
  ResearchConversationPhase,
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
/** P2-6：Coverage 本地草稿的合成快照基座（不含任何会话 editor 状态）。 */
const EMPTY_COVERAGE_EDITOR_SNAPSHOT: EditorSnapshot = {
  ref: { domain: 'research', kind: 'global', projectId: '', sessionId: '', sourceId: null },
  phase: 'ready',
  loading: false,
  revision: 0,
  intentHash: null,
  draftText: '',
  draftToken: '',
  consumedToken: null,
  baseScope: null,
  singleSourceId: null,
  noteIds: [],
  chatAnchor: null,
  readerAnchor: null,
  dirty: false,
  saving: false,
  readOnly: false,
  blocked: false,
  unreadable: false,
  warnings: [],
  conflict: null,
  saveFailure: null,
  unsynced: false,
  localVersion: 0,
  confirmedLocalVersion: 0,
  writerId: '',
  lastSavedAt: null,
  pendingMutations: 0,
  restoreCandidates: [],
  holds: [],
  transportAvailable: false,
  positionUnavailable: false,
  invalidated: false,
  oversize: false,
}

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

/**
 * PR-5b（Codex P1-#6）：controller 的 turn → 面板可渲染的 user/assistant 两行。
 * 同一个投影同时用于 `history`（已被新轮归档的旧轮）与 live turn，保证新一轮
 * 开始后上一轮问答不会从界面消失。
 */
function conversationTurnToTurns(turn: ConversationTurn): ResearchChatTurn[] {
  // Lead 定向复核 P1：external（冷启动查回）turn 不在消息流投影——历史问答
  // 由 durable detail 行原样呈现（保留 message_id 与旧问答配对）；外部 turn
  // 只用于提交状态卡/查回，不得生成空 assistant 占位。
  if (turn.external) return []
  const terminalStatus: ResearchChatTurn['status'] =
    turn.sse.terminal === 'error' ? 'error' : 'done'
  // PR-13（F-1）：not_accepted 在 machine 里落成 `state='idle'` + `errorCode`
  // （见 conversation-machine 的 http_failure 分支，明确未受理、零副作用）。
  // 若此处仍按“idle → streaming”投影，错误卡永远不渲染（它会吞掉空答案的
  // assistant 行），用户看到的是“发送了但什么都没有”，可无限重复提交。
  const notAcceptedCode =
    turn.state === 'idle' && turn.errorCode !== null && turn.errorCode !== ''
      ? turn.errorCode
      : null
  const status: ResearchChatTurn['status'] =
    notAcceptedCode !== null
      ? 'error'
      : turn.state === 'terminal'
        ? terminalStatus
        : turn.state === 'unknown' || turn.state === 'lookup_pending'
          ? terminalStatus === 'error'
            ? 'error'
            : 'streaming'
          : 'streaming'
  const generationId = turn.identity.generationId
  const userTurn: ResearchChatTurn = {
    id: `user_${turn.identity.turnId}`,
    role: 'user',
    content: turn.query,
    thinking: '',
    citations: [],
    usage: null,
    resolvedMode: null,
    status: 'done',
    reconnectCount: 0,
    errorCode: null,
    errorMessage: null,
    coverageJobId: null,
    scopeSnapshot: null,
    serverMessageId: null,
    generationId,
  }
  // 空 answer 的非 error turn 不投影 assistant 行（避免“暂无答案”空占位；
  // 流式进度由面板 streaming 指示器承担）。error 保留行以渲染错误卡——
  // 包括 PR-13 的 not_accepted（`sse.terminal` 仍是 null，只能看投影后的
  // status 判断）。
  if (turn.sse.answer === '' && status !== 'error') {
    return [userTurn]
  }
  const assistantTurn: ResearchChatTurn = {
    id: turn.identity.turnId,
    role: 'assistant',
    content: turn.sse.answer,
    thinking: turn.sse.thinking,
    citations: (turn.sse.citations as readonly ResearchCitation[]).map((citation) => ({
      citation_id: citation.citation_id,
      claim: citation.claim,
      doc_id: citation.doc_id,
      page_idx: citation.page_idx,
      confidence: citation.confidence,
    })),
    usage: turn.sse.usage,
    resolvedMode: turn.sse.resolvedMode,
    status,
    reconnectCount: 0,
    errorCode: notAcceptedCode ?? turn.sse.errorCode ?? turn.errorCode,
    errorMessage: turn.sse.errorMessage ?? turn.errorMessage,
    coverageJobId: null,
    // PR-13：controller 投影轮不带派发快照（controller 不保留 scope），因此
    // 沿用既有规则「无原快照不显示 Retry」——不得用当前选择冒充派发范围。
    // 错误卡仍照常渲染稳定码与恢复动作说明。
    scopeSnapshot: null,
    serverMessageId: null,
    generationId,
    contextReport: turn.sse.contextReport,
    contextCoverage: turn.sse.contextCoverage,
    recordVisibility: null,
    submittedQuery: turn.query,
  }
  return [userTurn, assistantTurn]
}

/**
 * PR-6（§8.1）：判断焦点目标是否属于“会话导航入口”（会话切换触发按钮/抽屉）。
 * 用户从输入框切到导航入口时，“此前焦点在输入框”的意图保留（激活后回焦输入框）；
 * 焦点移到面板内其它控件或面板外普通元素则清除该意图（不抢焦点）。
 */
function isSessionNavigationTarget(node: HTMLElement | null): boolean {
  if (node === null) return false
  // 只认会话切换器触发按钮与项目级历史抽屉（id 前缀固定），
  // 不把任意 portal 对话框当作会话导航。
  return (
    node.closest('[data-testid="session-switcher-trigger"]') !== null ||
    node.closest('[id^="research-session-drawer-"]') !== null
  )
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
  onFlushPosition,
  surfaceActive = true,
  editorHandle,
  conversation,
  sessionRef,
  sessionMeta,
  sessionCards,
  submissionLookup,
  markerWriteFailed = false,
  refreshMarkerLookups,
  onSendSession,
  onNewSession,
}: {
  turns: ResearchChatTurn[]
  isStreaming: boolean
  /**
   * 返回是否已真正派发。Issue #243 §6.4：外部模型需确认时执行被推迟，
   * 调用方据此决定「派发后」的清理（如清空输入），使取消零副作用。
   */
  onSend: (query: string, selection?: ResearchChatSelection) => Promise<boolean>
  /**
   * COV-09：all_selected 提交；RWV2-11（K9）携带派发时冻结的快照。
   * PR-5b（DESIGN §9.6）：返回真实受理结果（202 + Generation/Job 标识 +
   * Jobs 登记状态）；`not_dispatched` 表示 consent 取消/身份失效。
   */
  onSendCoverage: (
    query: string,
    snapshot: ResearchScopeSnapshot,
  ) => Promise<CoverageSubmitOutcome>
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
  /** 切 tab/隐藏前尽力写回位置（§5.7.1 flush('position')）；不阻塞 UI。 */
  onFlushPosition?: () => void
  /** 当前 Chat 面板是否可见（keep-alive 隐藏时不保存/不恢复锚点，§8.3/N9）。 */
  surfaceActive?: boolean
  /** PR-5b（D1）：会话 editor 句柄（恢复已提交稿/当前草稿）。 */
  editorHandle?: UseResearchEditorResult
  /** PR-5b（D1）：当前会话 conversation controller（新协议发送/查回权威）。 */
  conversation?: ConversationController | null
  /** PR-5b：当前会话 ref（受限占位展示短 id；不用于请求）。 */
  sessionRef?: ResearchSessionRef | null
  /** PR-5b（D2）：同一次详情响应捕获的会话元数据（标题/可见性）。 */
  sessionMeta?: ResearchChatSessionMeta | null
  /** PR-5b（D2）：同一次详情响应捕获的 Generation 卡。 */
  sessionCards?: readonly ResearchGlobalChatCard[]
  /** PR-5b（D3）：最近一次提交查回观测（含失败卡共用容量报告）。 */
  submissionLookup?: ResearchSubmissionLookupSnapshot | null
  /** PR-5b（D3）：开流前 marker 写失败（如实提示，不阻断发送）。 */
  markerWriteFailed?: boolean
  /** PR-5b（D3）：显式刷新未结算标记查回。 */
  refreshMarkerLookups?: (currentDraftToken?: string | null) => Promise<number>
  /**
   * PR-5b（D1）：session 模式发送入口——workspace 负责 consent/模型快照/
   * editor hold+flush/controller.send 与清稿派发；面板只负责 UI 状态。
   */
  onSendSession?: (query: string, selection: ResearchChatSelection) => Promise<boolean>
  /** §7.3：用户在新会话保护本机稿（调整范围/缩短问题/新建会话动作）。 */
  onNewSession?: () => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ResearchSynthesisScope>('relevant')
  // PR-4：editor 接线标记——undefined 表示宿主未装配 runtime（过渡回退）。
  const wired = editorSnapshot !== undefined
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  const sessionHeaderRef = useRef<HTMLDivElement | null>(null)
  // PR-6（§8.2）：切换后回焦输入框的意图与请求。
  const [composerFocusToken, setComposerFocusToken] = useState(0)
  // “此前焦点在输入框”的意图：焦点在会话导航入口之间移动时保留；移到
  // 面板内其它控件或面板外普通元素时清除（document focusin 监听，见下）。
  const composerFocusIntentRef = useRef(false)
  // 目标 editor 尚未就绪时挂起回焦，就绪后消费（§8.2“加载完成后回到输入框”）。
  const pendingComposerFocusRef = useRef(false)
  const sessionIdentityRef = useRef<string | null>(sessionRef ? sessionKey(sessionRef) : null)

  const currentSessionIdentity = sessionRef ? sessionKey(sessionRef) : null
  const editorSnapshotIdentity =
    editorSnapshot !== null && editorSnapshot !== undefined ? sessionKey(editorSnapshot.ref) : null
  // 只有“当前会话自己的 editor 已就绪”才允许回焦（避免用旧会话快照抢焦）。
  const editorFocusReady =
    editorSnapshot !== null &&
    editorSnapshot !== undefined &&
    editorSnapshotIdentity !== null &&
    editorSnapshotIdentity === currentSessionIdentity &&
    editorSnapshot.phase === 'ready' &&
    !editorSnapshot.loading

  // 面板外焦点变化：意图只对“面板内/会话导航入口”有效。用户若从入口移到
  // 其它控件再回来，意图已失效（P1：不因过期意图抢焦）。
  useEffect(() => {
    if (typeof document === 'undefined') return
    const handleDocumentFocusIn = (event: Event): void => {
      // intent 或 pending 任一存在都要跟踪：进入 loading 后 intent 已被消费，
      // 但挂起请求仍可能因用户离开而失效。
      if (!composerFocusIntentRef.current && !pendingComposerFocusRef.current) return
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (panelRootRef.current?.contains(target)) return
      if (isSessionNavigationTarget(target)) return
      composerFocusIntentRef.current = false
      pendingComposerFocusRef.current = false
    }
    document.addEventListener('focusin', handleDocumentFocusIn)
    return () => document.removeEventListener('focusin', handleDocumentFocusIn)
  }, [])

  // surface 隐藏时让挂起请求失效：重新显示后不得执行旧会话的回焦。
  useEffect(() => {
    if (surfaceActive) return
    composerFocusIntentRef.current = false
    pendingComposerFocusRef.current = false
  }, [surfaceActive])

  useEffect(() => {
    const nextIdentity = sessionRef ? sessionKey(sessionRef) : null
    if (sessionIdentityRef.current === nextIdentity) return
    sessionIdentityRef.current = nextIdentity
    if (!surfaceActive) {
      composerFocusIntentRef.current = false
      pendingComposerFocusRef.current = false
      return
    }
    // §8.1/§8.2：此前焦点在输入框 → 回输入框（目标 editor 就绪则立即请求，
    // 否则挂起等就绪；连续切换沿用同一挂起请求）；否则焦点落到面板标题。
    if (composerFocusIntentRef.current) {
      composerFocusIntentRef.current = false
      if (editorFocusReady) {
        pendingComposerFocusRef.current = false
        setComposerFocusToken((token) => token + 1)
      } else {
        pendingComposerFocusRef.current = true
      }
      return
    }
    if (pendingComposerFocusRef.current) return
    sessionHeaderRef.current?.focus()
  }, [sessionRef, surfaceActive, editorFocusReady])

  // 目标 editor 就绪且用户未把焦点移到别处时才消费挂起的回焦请求。
  useEffect(() => {
    if (!pendingComposerFocusRef.current || !surfaceActive || !editorFocusReady) return
    const active = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
    const focusSafe =
      active === null ||
      active === document.body ||
      isSessionNavigationTarget(active) ||
      active.getAttribute('data-testid') === 'chat-input'
    if (!focusSafe) {
      pendingComposerFocusRef.current = false
      return
    }
    pendingComposerFocusRef.current = false
    setComposerFocusToken((token) => token + 1)
  }, [editorFocusReady, surfaceActive, sessionRef])

  const handlePanelFocusCapture = (event: FocusEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (
      target.getAttribute('data-testid') === 'chat-input' &&
      target.closest('[data-local-draft="true"]') === null
    ) {
      composerFocusIntentRef.current = true
      return
    }
    if (!isSessionNavigationTarget(target)) composerFocusIntentRef.current = false
  }

  const handlePanelBlurCapture = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as HTMLElement | null
    if (next !== null && event.currentTarget.contains(next)) return
    if (isSessionNavigationTarget(next)) return
    // 焦点离开允许区域（含 relatedTarget=null，如 iframe/失焦）：
    // intent 与挂起请求都失效，避免后续抢焦。
    composerFocusIntentRef.current = false
    pendingComposerFocusRef.current = false
  }
  const anchorTimerRef = useRef<number | null>(null)
  // F3：滚动 16ms 节流缓存最近一次可测量的锚点；隐藏/卸载时容器已不可度量，
  // flush 用缓存把 <1000ms 内的滚动位置写回，避免丢位置。
  const measureFrameRef = useRef<number | null>(null)
  const latestAnchorRef = useRef<WireChatAnchor | null>(null)
  const restoringRef = useRef(false)
  // 恢复只对“当前保存锚点”尝试一次成功；失败后仅在稳定消息 ID 集变化且用户未接管时重试，
  // 避免 live assistant 回填 ID 时把用户手动滚动打回旧位置（review round 3）。
  const restoreAttemptRef = useRef<{
    key: string
    failed: boolean
    succeeded: boolean
  } | null>(null)
  const userScrolledRef = useRef(false)
  // 恢复抑制窗口内区分“程序化滚动”与“用户接管”：记录恢复写入/保持的 scrollTop。
  const restoreExpectedScrollTopRef = useRef<number | null>(null)
  // §5.7.1：恢复失败（缺目标/越界/非法偏移）→ 稳定原因可见，停在有权版本顶部。
  const [anchorUnavailable, setAnchorUnavailable] = useState(false)
  // 发送/成功恢复后清除服务端 position_unavailable 的可见性（§5.7.1/Lead F5）。
  const [positionUnavailableDismissed, setPositionUnavailableDismissed] = useState(false)
  // P1-2：发送成功后写 follow_tail；无稳定 message_id 时先置 pending。
  const followTailPendingRef = useRef(false)
  // P1-1：Coverage 使用独立本地草稿（不读/写会话 editor 草稿，不触发会话保存）。
  const [coverageDraft, setCoverageDraft] = useState<{ text: string; version: number }>({
    text: '',
    version: 0,
  })
  const coverageDraftVersionRef = useRef(0)
  const [coverageOutcome, setCoverageOutcome] = useState<CoverageSubmitOutcome | null>(null)
  // PR-5b（§9.6/D1）：新协议 turn 的唯一权威是 conversation controller——
  // 面板订阅其快照渲染 live turn（hook 的 turns 只承载 durable 历史）。
  const sessionConversation = conversation ?? null
  const sessionWired = sessionConversation !== null && onSendSession !== undefined
  /**
   * O-3（#602）：当前没有任何活动会话（宿主显式传 `sessionRef=null`）。
   *
   * `editorSnapshot === null` 有两种完全不同的语义，必须分开处理：
   * - runtime 已装配、但**尚未创建/选择会话**（`sessionRef === null`）——
   *   正常空态，DESIGN §4.3 要求“没有活动会话时不提供可持久化的 composer
   *   输入，只展示新对话入口”；把它当成会话加载失败会渲染出
   *   “Loading research workspace…” + “An unexpected error occurred…”，
   *   把正常空态误报成故障（生产实测 2026-10-28/29，O-3）。
   * - 会话存在但 editor 尚未就绪——真正的加载中/失败，保持既有门禁与文案。
   *
   * 只有**显式 `null`** 才表示“确认无会话”：`sessionRef` 缺省（`undefined`）
   * 表示宿主未提供该信息，此时不得改变既有门禁语义（回归安全）。
   */
  const noActiveSession = wired && sessionRef === null
  const [liveSnapshot, setLiveSnapshot] = useState<ConversationSnapshot | null>(null)
  useEffect(() => {
    if (sessionConversation === null) {
      setLiveSnapshot(null)
      return
    }
    const sync = (): void => setLiveSnapshot(sessionConversation.getSnapshot())
    sync()
    return sessionConversation.subscribe(sync)
  }, [sessionConversation])
  const liveTurn = liveSnapshot?.turn ?? null
  // PR-5b（Codex P2-#9）：冷启动恢复出的非空持久草稿也必须先查回一次当前
  // draft token（marker 写失败/被清除且 cards 为空时 F10 的兜底路径）。
  //
  // PR-10（#602 6b 真实接入 P0）：查回**只允许**针对“加载时已存在的持久非空
  // 草稿”。此前按“非空即查回”会让新建会话里用户新输入的草稿也触发查回：
  // 该 token 尚无任何提交，查回必然 not_observed，控制器由此产出一个
  // `external` turn，使随后首次真实发送被 `replay_snapshot_unavailable`
  // 阻断（用户点 Send 无 POST /chat）。
  //
  // 判定按会话维护：
  // - `userTexts`：本面板生命周期内由用户/宿主写入过的草稿文本（trim 后）。
  //   命中即视为“本机输入”，永不查回——包括切走再回来、editor 控制器被
  //   重建后重新加载出同一段文本的情形（否则 P0 会以更窄的路径复现：
  //   输入→等保存→切走→回来→直接点 Send 又被阻断）。
  // - `lookedUpToken`：本会话已发起过查回的 token，避免同一 token 重复查回；
  //   editor 重新进入加载（非 ready/loading）时清空，使重新加载出的**另一段**
  //   持久草稿仍能按 F10 查回一次。
  type ColdStartEntry = { lookedUpToken: string | null; userTexts: Set<string> }
  const coldStartLookupRef = useRef<Map<string, ColdStartEntry>>(new Map())
  /**
   * 手动恢复本机草稿后的抑制：恢复会生成「全新 token + 从未提交过的文本」，
   * 而恢复文本只有 editor 知道（候选记录不含文本），故发起恢复时记下当时的
   * token，等观察到 token 变化后把新文本登记为用户写入、不查回。
   */
  const restoreSuppressRef = useRef<{ fromToken: string } | null>(null)
  const coldStartEntry = (key: string): ColdStartEntry => {
    const existing = coldStartLookupRef.current.get(key)
    if (existing !== undefined) return existing
    const created: ColdStartEntry = { lookedUpToken: null, userTexts: new Set() }
    coldStartLookupRef.current.set(key, created)
    return created
  }
  /**
   * 把某会话标记为“当前草稿来自用户/宿主写入，无需冷启动查回”。
   * `text` 是写入后的草稿文本（trim 后非空才记录）；未知时可省略，此时仅
   * 放弃当前 token 的查回资格。
   */
  const markDraftUserAuthored = (text?: string | null): void => {
    if (currentSessionIdentity === null) return
    const entry = coldStartEntry(currentSessionIdentity)
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed !== '') entry.userTexts.add(trimmed)
    const token = editorSnapshot?.draftToken ?? ''
    if (token !== '') entry.lookedUpToken = token
  }
  useEffect(() => {
    if (!sessionWired || refreshMarkerLookups === undefined) return
    const key = currentSessionIdentity
    if (key === null) return
    // 只处理“当前会话自己的” editor 快照：切换瞬间可能仍拿到上一会话的快照，
    // 用它判定会污染新会话的冷启动结论。
    if (editorSnapshot === null || editorSnapshot === undefined) return
    if (editorSnapshotIdentity !== key) return
    const entry = coldStartEntry(key)
    // 手动恢复草稿后的首个新 token：登记其文本为用户写入，不做冷启动查回。
    const suppressed = restoreSuppressRef.current
    if (
      suppressed !== null &&
      editorSnapshot.phase === 'ready' &&
      !editorSnapshot.loading &&
      editorSnapshot.draftToken !== suppressed.fromToken
    ) {
      restoreSuppressRef.current = null
      const restoredText = editorSnapshot.draftText.trim()
      if (restoredText !== '') entry.userTexts.add(restoredText)
      if (editorSnapshot.draftToken !== '') entry.lookedUpToken = editorSnapshot.draftToken
      return
    }
    // 必须等 editor 真正加载完成，否则初始本地 token 会占用“本会话已判定”。
    if (editorSnapshot.phase !== 'ready' || editorSnapshot.loading) {
      // 重新进入加载：让本轮加载出的草稿重新获得一次查回资格（F10）。
      // 用户本机写过的文本仍由 userTexts 拦住，不会退回 P0。
      entry.lookedUpToken = null
      return
    }
    const text = editorSnapshot.draftText.trim()
    // 空草稿无需查回（新建空会话即停在此处；此后用户输入走 userTexts 拦截）。
    if (text === '') return
    if (entry.userTexts.has(text)) return
    const token = editorSnapshot.draftToken ?? ''
    if (token === '') return
    if (entry.lookedUpToken === token) return
    entry.lookedUpToken = token
    void refreshMarkerLookups(token)
  }, [
    sessionWired,
    refreshMarkerLookups,
    editorSnapshot?.draftToken,
    editorSnapshot?.draftText,
    editorSnapshot?.phase,
    editorSnapshot?.loading,
    editorSnapshotIdentity,
    currentSessionIdentity,
  ])
  const surfaceActiveRef = useRef(surfaceActive)
  surfaceActiveRef.current = surfaceActive
  const wiredConversation: ResearchConversationSnapshot = conversationSnapshot ?? {
    isBusy: isStreaming,
    isStreaming,
    activeTurnId: null,
    phase: isStreaming ? 'streaming' : 'idle',
  }
  // PR-5b（Codex P2-#7）：session 模式的 busy/streaming 必须以 controller 快照
  // 为权威；legacy `isStreaming` 在 controller 执行时通常仍是 idle，会让发送
  // 按钮误开放、点击后才被 controller 拒绝。
  const sessionConversationSnapshot: ResearchConversationSnapshot | null = (() => {
    if (!sessionWired || liveSnapshot === null) return null
    const turn = liveSnapshot.turn
    // PR-5b（Codex 第 2 轮 N1）：只有“仍未落定/仍占用”的状态才算 busy；
    // `idle`（明确未受理）与 `not_observed`（查回未观察到）必须允许重试，
    // 否则一次 202 失败或空稿查回会让 composer 永久禁用。
    const active =
      turn !== null &&
      (turn.clearPending ||
        turn.state === 'preparing' ||
        turn.state === 'submitting' ||
        turn.state === 'accepted' ||
        turn.state === 'streaming' ||
        turn.state === 'lookup_pending' ||
        turn.state === 'unknown')
    const streaming = turn !== null && turn.state === 'streaming'
    const phase: ResearchConversationPhase = !active
      ? 'idle'
      : turn.state === 'preparing' || turn.state === 'submitting'
        ? 'busy'
        : turn.state === 'unknown' || turn.state === 'not_observed'
          ? 'unknown'
          : streaming
            ? 'streaming'
            : 'awaiting'
    return {
      activeTurnId: active ? turn.identity.turnId : null,
      phase,
      isStreaming: streaming,
      isBusy: active,
    }
  })()
  const effectiveConversation: ResearchConversationSnapshot =
    sessionConversationSnapshot ?? wiredConversation
  // PR-5b：Coverage 是独立工作流——composer 不得共享 Chat 的 isStreaming。
  const coverageConversation: ResearchConversationSnapshot = {
    isBusy: false,
    isStreaming: false,
    activeTurnId: null,
    phase: 'idle',
  }
  /** PR-5b（Codex P1-#6）：controller 快照 = history（已归档旧轮）+ 当前轮。 */
  const controllerTurns: ResearchChatTurn[] = (() => {
    if (!sessionWired || liveSnapshot === null) return []
    // Lead 定向复核 / Codex 复核 P1：热恢复时 durable detail 行与 controller
    // history 可能指向**同一轮**（切走再返回，runtime 保留 controller）。用
    // generationId（durable assistant 由 msg_<gen>_assistant 解析）作为可证明
    // 身份：durable 已有该 generation 时跳过 controller 重复轮（durable 行
    // 原样保留；只跳过 controller 副本，不删 durable user）。
    const durableGenerations = new Set(
      turns
        .map((row) => row.generationId)
        .filter((id): id is string => id !== null && id !== ''),
    )
    const rows: ResearchChatTurn[] = []
    const seen = new Set<string>()
    const appendTurn = (turn: ConversationTurn): void => {
      const generationId = turn.identity.generationId
      if (generationId !== null && durableGenerations.has(generationId)) return
      for (const row of conversationTurnToTurns(turn)) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        rows.push(row)
      }
    }
    for (const turn of liveSnapshot.history) appendTurn(turn)
    if (liveSnapshot.turn !== null) appendTurn(liveSnapshot.turn)
    return rows
  })()
  const renderedTurns: ResearchChatTurn[] = (() => {
    if (!sessionWired) return turns
    // Lead 定向复核 P1：**durable user 行永不得按正文删除**。
    // 只有可证明身份匹配才去重：durable 与 controller 行 serverMessageId 相等
    // （controller 投影仅在 external 场景可带 message_id，而 external 已不投影）。
    // 不能确定时保留两行（宁可多一条历史，不猜配对）。
    const durableMessageIds = new Set(
      turns
        .map((turn) => turn.serverMessageId)
        .filter((id): id is string => id !== null && id !== ''),
    )
    const controllerRows = controllerTurns.filter(
      (turn) => turn.serverMessageId === null || !durableMessageIds.has(turn.serverMessageId),
    )
    return [...turns, ...controllerRows]
  })()

  // PR-5b（§4.2-4/§4.6）：详情侧可见性投影。当前批次 detail 恒可读 title+
  // record_visibility；不先占位等确认（有 detail 就立即按响应渲染）。
  const sessionVisibility = projectSessionVisibility(
    null,
    (sessionMeta ?? null)?.recordVisibility ?? null,
  )
  const restrictedSession = sessionVisibility.visibility === 'restricted'
  const legacySession = sessionVisibility.visibility === 'legacy_context_unverifiable'
  const sessionMetaValue = sessionMeta ?? null
  // PR-5b（Codex P1-#4 / §4.2-4）：detail 的 title 只在可见性已知时渲染；
  // visibility 缺失（旧 DTO/字段缺失）→ 只显示 degraded 占位，绝不先展示标题。
  const sessionHeaderTitle =
    sessionMetaValue === null || sessionVisibility.visibility === null
      ? null
      : sessionMetaValue.title ?? t('research.session.untitled')
  const sessionShortId = sessionRef !== null && sessionRef !== undefined
    ? sessionRef.sessionId.slice(0, 8)
    : null

  // PR-5b（§6.7）：提交状态投影——live turn 优先，其次最近一次查回。
  const submissionView: ResearchSubmissionStatusView | null = (() => {
    if (!sessionWired) return null
    if (liveTurn !== null && !liveTurn.external) {
      const generationId = liveTurn.identity.generationId
      if (liveTurn.state === 'terminal') {
        return {
          kind: 'terminal',
          outcome: liveTurn.sse.terminal === 'error' ? 'failed' : 'completed',
          failureCode: liveTurn.sse.errorCode,
          generationId,
          submittedDraftText: liveTurn.query.trim().length > 0 ? liveTurn.query : null,
        }
      }
      if (liveTurn.state === 'unknown') {
        return {
          kind: 'outcome_unknown',
          generationId,
          submittedDraftText: liveTurn.query.trim().length > 0 ? liveTurn.query : null,
        }
      }
      if (liveTurn.state === 'accepted' || liveTurn.accepted !== null) {
        return {
          kind: 'accepted',
          generationId,
          generationState: liveTurn.accepted !== null ? 'accepted' : null,
          submittedDraftText: liveTurn.query.trim().length > 0 ? liveTurn.query : null,
        }
      }
    }
    // PR-5b（Lead 核对 P1-1）：冷启动 terminal 查回生成的是 external turn
    // （不绑定编辑器快照），也必须渲染真实提交状态，而不是退回 not_observed。
    if (liveTurn !== null && liveTurn.external) {
      const generationId = liveTurn.identity.generationId
      const submittedDraftText = liveTurn.query.trim().length > 0 ? liveTurn.query : null
      if (liveTurn.state === 'terminal') {
        return {
          kind: 'terminal',
          outcome: liveTurn.sse.terminal === 'error' ? 'failed' : 'completed',
          failureCode: liveTurn.sse.errorCode,
          generationId,
          submittedDraftText,
        }
      }
      if (liveTurn.state === 'accepted' || liveTurn.accepted !== null) {
        return {
          kind: 'accepted',
          generationId,
          generationState: 'accepted',
          submittedDraftText,
        }
      }
      if (liveTurn.state === 'unknown' || liveTurn.state === 'lookup_pending') {
        return { kind: 'outcome_unknown', generationId, submittedDraftText }
      }
    }
    const lookup = submissionLookup ?? null
    if (lookup === null) {
      return markerWriteFailed ? { kind: 'not_observed' } : null
    }
    if (lookup.lookupFailed) {
      return {
        kind: 'lookup_failed',
        generationId: lookup.generationId,
        submittedDraftText: lookup.submittedDraftText,
      }
    }
    if (lookup.acceptance === 'accepted') {
      return {
        kind: 'accepted',
        generationId: lookup.generationId,
        generationState: lookup.generationState,
        submittedDraftText: lookup.submittedDraftText,
      }
    }
    if (lookup.acceptance === 'terminal') {
      return {
        kind: 'terminal',
        outcome: lookup.generationState === 'failed' ? 'failed' : 'completed',
        failureCode: null,
        generationId: lookup.generationId,
        submittedDraftText: lookup.submittedDraftText,
      }
    }
    if (lookup.acceptance === 'outcome_unknown') {
      return {
        kind: 'outcome_unknown',
        generationId: lookup.generationId,
        submittedDraftText: lookup.submittedDraftText,
      }
    }
    return { kind: 'not_observed' }
  })()

  // RWV2-23（AC4）：Continue research 预填（跨 keep-alive：首访挂载与后续
  // 递增 seq 都生效）；不自动派发——发送仍需用户点 Send（既有守卫）。
  useEffect(() => {
    if (prefill && prefill.text.trim() !== '') {
      // PR-10：宿主写入的预填文本不是“加载时已存在的持久草稿”，不得触发冷启动查回。
      markDraftUserAuthored(prefill.text)
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
      conversationSnapshot: effectiveConversation,
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
  // P1-1（§9.6）：Coverage 草稿与门禁完全独立于会话 editor——不复用会话草稿、
  // 不触发会话保存，也不被 legacy/saving/blocked/conflict/readonly 误禁用；
  // 只受工作区范围合法性（coverageAllowed）与自身文本上限（256KiB）约束。
  const coverageGate: ResearchDraftGate = (() => {
    if (!wired) return { allowed: true, reason: null }
    // P2-7：全局执行门禁（模型/会话 busy 等）同样约束 Coverage；本项不重新耦合
    // 会话 editor 的草稿/保存状态（§9.6 只隔离 editor 侧）。
    if (generationBlocked) return { allowed: false, reason: 'turn_active' }
    if (!coverageAllowed) return { allowed: false, reason: 'scope_invalid' }
    if (new TextEncoder().encode(coverageDraft.text).length > 256 * 1024) {
      return { allowed: false, reason: 'oversize' }
    }
    if (hasUnpairedSurrogate(coverageDraft.text)) {
      return { allowed: false, reason: 'invalid_text' }
    }
    if (coverageDraft.text.trim().length === 0) {
      return { allowed: false, reason: 'empty_draft' }
    }
    return { allowed: true, reason: null }
  })()
  const activeComposerGate: ResearchDraftGate =
    wired && scope === 'all_selected' ? coverageGate : composerGate
  const composerGateReasonText: string | null = (() => {
    if (activeComposerGate.allowed) return null
    // P2-7：全局门禁优先展示外部稳定原因（模型不可用等），Coverage 也适用。
    if (generationBlocked) return blockedHint ?? t('research.errors.generationInProgress')
    if (wired && scope === 'all_selected' && !coverageAllowed) {
      return t('research.coverage.capabilityDisabled')
    }
    return t(researchDraftGateReasonKey(activeComposerGate.reason ?? 'runtime_unavailable'))
  })()

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

  /** 最近一条具备稳定服务端 message_id 的 turn（live 轮可能尚无）。 */
  const latestStableMessageId = (): string | null => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const id = turns[index].serverMessageId
      if (id !== null) return id
    }
    return null
  }

  /** P1-2（§5.7.1）：把阅读位置固定到最新（follow_tail=true）并滚到底部。 */
  const settleFollowTail = (): void => {
    // P2-N9：隐藏（keep-alive tab）期间不写位置、不滚隐藏容器；保留意图，回到可见时结算。
    if (!surfaceActiveRef.current) {
      followTailPendingRef.current = true
      return
    }
    const container = chatScrollRef.current
    if (container !== null) container.scrollTop = container.scrollHeight
    restoringRef.current = false
    restoreExpectedScrollTopRef.current = null
    restoreAttemptRef.current = null
    userScrolledRef.current = false
    setAnchorUnavailable(false)
    // P1-3（02 §4 / types.ts:532）：服务端 position_unavailable 会关闭位置保存，
    // controller 拒绝新锚点——不伪装已恢复、不隐藏提示，只保留 UI 滚底。
    if (editorSnapshot?.positionUnavailable === true) return
    const messageId = latestStableMessageId()
    if (messageId === null) {
      // 新消息尚未落稳定 ID：先置内存 pending，等 ID 回填后再落盘（不写临时 id）。
      followTailPendingRef.current = true
      return
    }
    followTailPendingRef.current = false
    onChatAnchorChange?.({ messageId, offsetPx: 0, followTail: true })
  }
  // P1-4：发送 Promise 结算必须读“最新”渲染的 turns/editor（发送时旧闭包会把
  // 已回填的稳定 ID 判成 pending，此后 signature 不再变化而永不落盘）。
  const settleFollowTailRef = useRef<() => void>(() => {})
  settleFollowTailRef.current = settleFollowTail

  // P1-1：Coverage 提交独立于会话 editor——只校验工作区范围与本地草稿上限。
  const submitCoverage = (dispatchText: string): void => {
    // #358：能力门禁在提交点再次校验（与 coverageAllowed 同源，且用
    // 派发时刻冻结快照）——能力 false/缺失时不发 Coverage 创建请求。
    const snapshot = getSnapshot()
    const allowed =
      coverageEnabled &&
      mode === 'selected' &&
      snapshot.sourceIds.length > 0 &&
      snapshot.sourceIds.length <= COVERAGE_SOURCE_HARD_MAX &&
      snapshot.noteIds.length === 0
    if (!allowed) return
    const sentVersion = coverageDraftVersionRef.current
    setCoverageOutcome(null)
    void onSendCoverage(dispatchText, snapshot).then((outcome) => {
      setCoverageOutcome(outcome)
      // §9.6：只有“已受理”才可能清空；未派发（consent 取消）零副作用。
      if (outcome.status !== 'accepted') return
      if (!wired) {
        // 未接线保留旧行为（清本地单行输入）。
        setQuery('')
        return
      }
      // 发送成功后只清“同一版本且文本未变”的 Coverage 文本，绝不触碰会话草稿。
      if (
        coverageDraftVersionRef.current === sentVersion &&
        coverageDraft.text === dispatchText
      ) {
        coverageDraftVersionRef.current += 1
        setCoverageDraft({ text: '', version: coverageDraftVersionRef.current })
      }
    })
  }

  const submit = () => {
    if (generationBlocked) return
    // P1-1：Coverage 与 Chat 草稿完全隔离——coverage 路径只读/只写本地
    // coverage 文本与范围合法性，不读取会话 editor 草稿，也不被会话
    // editor 的 saving/blocked/conflict/readonly/legacy 门禁误禁用。
    if (scope === 'all_selected') {
      const dispatchText = wired ? coverageDraft.text.trim() : query.trim()
      if (!dispatchText) return
      if (wired && !coverageGate.allowed) return
      submitCoverage(dispatchText)
      return
    }
    // PR-4：接线后草稿真源在会话 editor；发送不 trim 覆盖正文（§5.4）。
    const rawText = wired ? editorSnapshot?.draftText ?? '' : query
    const trimmed = rawText.trim()
    if (!trimmed) return
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
    // PR-5b（§9.3/D1）：session 模式发送只走 controller.send——由 workspace
    // 负责 consent/模型快照/editor hold+flush/清稿派发（不再经 legacy send）。
    if (sessionWired && onSendSession !== undefined) {
      void onSendSession(rawText, selectionWithScope).then((sent) => {
        // P1-2（§5.7.1）：派发成功后阅读位置固定到最新（follow_tail=true）。
        if (sent) settleFollowTailRef.current()
      })
      return
    }
    // PR-4：接线后正文原样提交（不 trim 覆盖草稿），空值校验仍用 trimmed。
    void onSend(wired ? rawText : trimmed, selectionWithScope).then((sent) => {
      if (sent && !wired) setQuery('')
      // P1-2（§5.7.1）：派发成功后阅读位置固定到最新（follow_tail=true）。
      if (sent && wired) settleFollowTailRef.current()
    })
  }

  // PR-4：按当前几何测量一次消息锚点（§5.7.1；帧内单点读取，定时器/flush 复用）。
  const measureChatAnchorNow = (): WireChatAnchor | null => {
    const container = chatScrollRef.current
    if (container === null) return null
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
    return measureChatAnchorCandidates({
      messages,
      container: {
        containerTop: rect.top,
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
      },
    })
  }

  // PR-4：锚点上报——滚动空闲 1000ms 计算一次（§5.7.1），恢复期间不写。
  const scheduleChatAnchor = (): void => {
    // N9：隐藏（keep-alive tab）时不计划保存——避免切走后仍写位置。
    if (!wired || !surfaceActiveRef.current || onChatAnchorChange === undefined) return
    if (restoringRef.current) {
      const container = chatScrollRef.current
      const expected = restoreExpectedScrollTopRef.current
      // 恢复窗口内 scrollTop 仍等于预期值＝程序化滚动，抑制上报。
      if (
        container === null ||
        expected === null ||
        Math.abs(container.scrollTop - expected) <= 1
      ) {
        return
      }
      // 抑制窗口内用户已滚动到别处：立即结束抑制并记录接管（不再回填旧锚点）。
      restoringRef.current = false
      restoreExpectedScrollTopRef.current = null
    }
    // 非程序化滚动＝用户接管阅读位置；此后的 ID 回填不得再触发恢复。
    userScrolledRef.current = true
    if (measureFrameRef.current !== null) window.clearTimeout(measureFrameRef.current)
    measureFrameRef.current = window.setTimeout(() => {
      measureFrameRef.current = null
      // N9：隐藏时不写位置，只缓存可见时的最近锚点，供隐藏瞬间 flush 使用。
      if (!surfaceActiveRef.current) return
      const anchor = measureChatAnchorNow()
      if (anchor !== null) latestAnchorRef.current = anchor
    }, 16)
    if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = window.setTimeout(() => {
      anchorTimerRef.current = null
      // N9：定时器触发时若已切 tab/隐藏，则丢弃本次位置写入。
      if (!surfaceActiveRef.current) return
      const anchor = measureChatAnchorNow()
      if (anchor !== null) {
        latestAnchorRef.current = anchor
        onChatAnchorChange?.(anchor)
      }
    }, 1000)
  }

  const flushPositionRef = useRef<() => void>(() => {})
  flushPositionRef.current = (): void => {
    // P1-1：<1000ms 内切走时定时器被取消——离开前先测量；隐藏/卸载时容器
    // 已不可度量（display:none / ref 置 null），退回 16ms 节流缓存的最近锚点，
    // 避免把 <1s 的滚动位置静默丢掉（F3）。
    const pendingTimer = anchorTimerRef.current
    const pendingFrame = measureFrameRef.current
    const hadPending = pendingTimer !== null || pendingFrame !== null
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer)
      anchorTimerRef.current = null
    }
    if (pendingFrame !== null) {
      window.clearTimeout(pendingFrame)
      measureFrameRef.current = null
    }
    if (wired && hadPending && !restoringRef.current) {
      let anchor = measureChatAnchorNow()
      const cached = latestAnchorRef.current
      // 会话切换后旧缓存可能指向已不在当前消息列表里的 message_id：只有
      // 缓存目标仍存在于当前 DOM 才回退写入，避免把上一会话的锚点写进新会话。
      if (
        anchor === null &&
        cached !== null &&
        chatScrollRef.current?.querySelector(
          `[data-message-id="${cached.messageId}"]`,
        ) !== null
      ) {
        anchor = cached
      }
      if (anchor !== null) onChatAnchorChange?.(anchor)
    }
    onFlushPosition?.()
  }
  useEffect(() => {
    return () => {
      // F3：切 tab/隐藏或卸载前尽力 flush('position')（不阻塞 UI）。
      flushPositionRef.current()
    }
  }, [])

  const surfaceActivePrevRef = useRef(surfaceActive)
  useEffect(() => {
    // F3：可见 → 隐藏的瞬间 flush 一次，避免 <1000ms 的滚动位置丢失。
    if (surfaceActivePrevRef.current && !surfaceActive) flushPositionRef.current()
    // N9：隐藏期间成功/回填被延迟的 follow_tail 意图，回到可见时结算。
    if (!surfaceActivePrevRef.current && surfaceActive && followTailPendingRef.current) {
      settleFollowTailRef.current()
    }
    surfaceActivePrevRef.current = surfaceActive
  }, [surfaceActive])

  // PR-4：恢复消息锚点（§5.7.1）——只设 scrollTop，不动焦点、不写回锚点。
  const savedChatAnchor = wired ? editorSnapshot?.chatAnchor ?? null : null
  // live 轮解析出稳定 message_id 后要重新尝试恢复（turns.length 不变但 ID 集变了）。
  const stableMessageIdSignature = turns
    .map(turn => turn.serverMessageId ?? '')
    .join('|')
  // P1-3（02_INTERFACE_FREEZE §4）：服务端净化锚点（position_unavailable）后
  // 关闭位置保存——不尝试恢复，也不再伪装“已恢复”；能力恢复后重置隐藏标记。
  useEffect(() => {
    if (!wired) return
    if (editorSnapshot?.positionUnavailable === true) {
      restoringRef.current = false
      restoreExpectedScrollTopRef.current = null
      restoreAttemptRef.current = null
      setAnchorUnavailable(true)
      return
    }
    setPositionUnavailableDismissed(false)
  }, [wired, editorSnapshot?.positionUnavailable])

  useEffect(() => {
    if (!wired || !surfaceActive || savedChatAnchor === null || editorSnapshot?.positionUnavailable === true) {
      restoringRef.current = false
      if (!surfaceActive) return
      restoreAttemptRef.current = null
      userScrolledRef.current = false
      return
    }
    const container = chatScrollRef.current
    if (container === null) {
      restoringRef.current = false
      return
    }
    const attemptKey = `${savedChatAnchor.messageId}|${savedChatAnchor.offsetPx}|${savedChatAnchor.followTail}`
    const attempt = restoreAttemptRef.current
    if (attempt?.key === attemptKey) {
      // 已成功恢复，或用户已手动接管 → 不再重设 scrollTop。
      if (attempt.succeeded) return
      if (userScrolledRef.current) {
        // 用户已接管阅读位置：ID 回填不再重试，失败提示也不再成立。
        restoringRef.current = false
        restoreExpectedScrollTopRef.current = null
        setAnchorUnavailable(false)
        return
      }
    } else {
      restoreAttemptRef.current = { key: attemptKey, failed: false, succeeded: false }
      userScrolledRef.current = false
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
    restoreExpectedScrollTopRef.current = container.scrollTop
    setAnchorUnavailable(!result.ok)
    if (result.ok) setPositionUnavailableDismissed(true)
    restoreAttemptRef.current = {
      key: attemptKey,
      failed: !result.ok,
      succeeded: result.ok,
    }
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
      restoreExpectedScrollTopRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在锚点/消息集变化时恢复
  }, [
    wired,
    surfaceActive,
    savedChatAnchor?.messageId,
    savedChatAnchor?.offsetPx,
    savedChatAnchor?.followTail,
    stableMessageIdSignature,
  ])

  // F4：范围条稳定禁用原因（只读/受阻/冲突/不可读）——不能用 null 静默禁用。
  // legacy（base_scope=null）保持可交互：§7.2 要求用户显式重选才能修复。
  const scopeBarDisabledReason: string | null = (() => {
    if (editorSnapshot === null || editorSnapshot === undefined) return t('research.loading')
    if (editorSnapshot.readOnly || editorSnapshot.phase === 'readonly') {
      return t('research.workbench.adminWriteDenied')
    }
    if (editorSnapshot.blocked || editorSnapshot.phase === 'blocked') {
      return t('research.editor.blocked')
    }
    if (editorSnapshot.conflict !== null || editorSnapshot.phase === 'conflict') {
      return t('research.errors.revisionChanged')
    }
    if (editorSnapshot.invalidated || editorSnapshot.unreadable) {
      return t('research.errors.internal')
    }
    if (!editorSnapshot.transportAvailable) return t('research.errors.internal')
    return null
  })()

  // P1-1：Coverage 草稿的合成快照——只承载文本投影，保存/门禁状态与
  // 会话 editor 隔离（composer 以 localDraft 模式渲染）。
  // P2-6：Coverage 输入始终由本地 coverageDraft 直接受控——快照不依赖会话
  // editor 是否存在（尚无全局会话时 coverage 仍可输入/发送）。
  const coverageEditorSnapshot: EditorSnapshot = {
          ...(editorSnapshot ?? EMPTY_COVERAGE_EDITOR_SNAPSHOT),
          phase: 'ready',
          loading: false,
          draftText: coverageDraft.text,
          dirty: false,
          saving: false,
          readOnly: false,
          blocked: false,
          unreadable: false,
          invalidated: false,
          conflict: null,
          saveFailure: null,
          oversize: false,
          positionUnavailable: false,
  }

  // P1-2/P1-4：发送时还没有稳定 message_id → pending；ID 回填（signature 变化）
  // 或重新可见时统一走最新闭包结算（隐藏期间只保留意图）。
  useEffect(() => {
    if (!wired || !followTailPendingRef.current) return
    settleFollowTailRef.current()
  }, [wired, surfaceActive, stableMessageIdSignature, editorSnapshot?.positionUnavailable])

  return (
    <div
      ref={panelRootRef}
      className="flex h-full min-h-0 flex-col"
      onFocusCapture={handlePanelFocusCapture}
      onBlurCapture={handlePanelBlurCapture}
    >
      {sessionWired && (
        <div
          ref={sessionHeaderRef}
          tabIndex={-1}
          className="shrink-0 border-b px-3 py-2 focus:outline-none"
          data-testid="chat-session-header"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {restrictedSession ? (
              <span
                className="text-sm font-medium"
                data-testid="chat-session-restricted"
              >
                {t('research.session.visibility.restricted')}
                {sessionShortId !== null && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {t('research.session.shortId', { id: sessionShortId })}
                  </span>
                )}
              </span>
            ) : sessionHeaderTitle === null ? (
              <span
                className="text-sm text-muted-foreground"
                data-testid={
                  sessionVisibility.visibility === null
                    ? 'chat-session-title-unknown'
                    : 'chat-session-title-loading'
                }
              >
                {sessionVisibility.visibility === null
                  ? t('research.session.visibility.unknownBadge')
                  : t('research.loading')}
              </span>
            ) : (
              <span
                className="min-w-0 truncate text-sm font-medium"
                title={sessionHeaderTitle}
                data-testid="chat-session-title"
              >
                {sessionHeaderTitle}
              </span>
            )}
            {legacySession && (
              <Badge variant="outline" data-testid="chat-session-legacy-badge">
                {t('research.session.visibility.legacyBadge')}
              </Badge>
            )}
            {sessionVisibility.visibility === null && (
              <Badge variant="outline" data-testid="chat-session-visibility-unknown">
                {t('research.session.visibility.unknownBadge')}
              </Badge>
            )}
            {markerWriteFailed && (
              <span
                className="text-xs font-medium text-amber-600"
                data-testid="chat-marker-write-failed"
              >
                {t('research.submission.markerWriteFailed')}
              </span>
            )}
          </div>
        </div>
      )}
      {sessionWired && submissionView !== null && (
        <div className="shrink-0 border-b px-3 py-2">
          <ResearchSubmissionStatus
            submissionView={submissionView}
            currentDraft={editorSnapshot?.draftText ?? null}
            contextReport={
              submissionLookup?.contextReport !== null &&
              submissionLookup?.contextReport !== undefined
                ? submissionLookup.contextReport
                : null
            }
            visibility={sessionVisibility.visibility ?? undefined}
            onLookup={() => {
              void sessionConversation?.lookupSubmission(submissionLookup?.token)
              void refreshMarkerLookups?.(editorSnapshot?.draftToken ?? null)
            }}
            onRestore={(text) => {
              editorHandle?.setDraftText(text)
              void sessionConversation?.lookupSubmission(submissionLookup?.token)
            }}
            onCopy={(text) => {
              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                void navigator.clipboard.writeText(text)
              }
            }}
          />
        </div>
      )}
      {wired && !noActiveSession && (
        <div className="shrink-0 border-b px-3 py-2">
          <ResearchSessionScopeBar
            editorSnapshot={editorSnapshot ?? null}
            sources={scopeSources ?? []}
            notes={scopeNotes ?? []}
            disabledReason={scopeBarDisabledReason}
            onChangeScope={onChangeScope ?? (() => {})}
          />
        </div>
      )}
      <div
        ref={chatScrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
        onScroll={scheduleChatAnchor}
        data-testid="chat-messages"
      >
        {wired &&
          (anchorUnavailable ||
            (positionUnavailableDismissed !== true &&
              editorSnapshot?.positionUnavailable === true)) && (
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
        {renderedTurns.map((turn) =>
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
          ) : turn.recordVisibility === 'restricted' ? (
            <div
              key={turn.id}
              className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
              data-testid="chat-restricted-message"
              data-message-id={turn.serverMessageId ?? undefined}
            >
              {t('research.session.visibility.restricted')}
              {turn.serverMessageId !== null && (
                <span className="ml-1 font-mono">
                  {turn.serverMessageId.slice(0, 12)}
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

                  {/* PR-5b（§7.3 / Codex P2-#11）：assistant 消息下方固定
                      “上下文说明”折叠区；缺失/null = unknown（不填零、
                      不显示“完整”），不得隐藏入口。 */}
                  <ResearchContextReport
                    report={
                      (turn.contextReport as ResearchContextReportProjection | undefined) ??
                      null
                    }
                    onNewSession={onNewSession}
                  />

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
                  role="alert"
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
                      (RETRYABLE_SSE_ERROR_CODES.includes(turn.errorCode) ||
                        // PR-13：明确未受理（idle+code）轮只在 wire 动作为
                        // retry_same_key/reconcile_then_retry 时允许 Retry；
                        // show_unavailable（如 c05_entry_not_ready）不提供。
                        allowsRetryAction(turn.errorCode)) &&
                      turn.scopeSnapshot !== null && (
                        <>
                          <Badge variant="secondary">{t('research.chatRetryable')}</Badge>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const userTurn = turns[turns.indexOf(turn) - 1]
                              const retryText =
                                turn.submittedQuery ?? userTurn?.content ?? ''
                              void onSend(retryText, {
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
        {/* PR-5b（§6.9）：失败/排队/运行中 Generation 卡（completed 已交付
            不出卡；失败卡必须携带失败码与可选容量报告）。 */}
        {sessionWired &&
          sessionCards !== undefined &&
          sessionCards
            .filter((card) => card.status !== 'completed')
            .map((card) => (
              <div
                key={`${card.generation_id}:${card.job_id ?? ''}`}
                className="rounded-lg border px-3 py-2 text-xs"
                data-testid="chat-generation-card"
                data-status={card.status}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{card.status}</Badge>
                  <code className="font-mono">{card.generation_id}</code>
                  {card.failure_code !== null && card.failure_code !== undefined && (
                    <span className="text-destructive" data-testid="chat-generation-failure-code">
                      {card.failure_code}
                    </span>
                  )}
                </div>
                {card.status === 'failed' && (
                  <div className="mt-2">
                    <ResearchContextReport
                      report={(() => {
                        // PR-5b（§7.3 / Codex P2-#10）：card 自身报告优先；
                        // 仅当查回报告属于**同一 Generation**才回退，
                        // 避免多张卡共享另一轮的计数。
                        const cardReport = card.context_report as
                          | ResearchContextReportProjection
                          | null
                          | undefined
                        if (cardReport !== null && cardReport !== undefined) {
                          return cardReport
                        }
                        const lookup = submissionLookup ?? null
                        if (
                          lookup !== null &&
                          lookup.generationId !== null &&
                          lookup.generationId === card.generation_id
                        ) {
                          return lookup.contextReport
                        }
                        return null
                      })()}
                      variant="failed-card"
                      defaultOpen
                      onNewSession={onNewSession}
                    />
                  </div>
                )}
              </div>
            ))}
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

      {coverageOutcome !== null && coverageOutcome.status === 'accepted' && (
        <p
          className={
            coverageOutcome.registration === 'failed'
              ? 'border-t px-3 pt-2 text-xs font-medium text-amber-600'
              : 'border-t px-3 pt-2 text-xs text-muted-foreground'
          }
          data-testid={
            coverageOutcome.registration === 'failed'
              ? 'coverage-registration-pending'
              : 'coverage-accepted'
          }
          role="status"
        >
          {coverageOutcome.registration === 'failed'
            ? t('research.coverage.registrationPending')
            : t('research.coverage.accepted')}
          {' · '}
          <code>{coverageOutcome.jobId}</code>
        </p>
      )}
      {coverageOutcome !== null && coverageOutcome.status === 'failed' && (
        <p
          className="border-t px-3 pt-2 text-xs text-destructive"
          data-testid="coverage-submit-error"
          role="alert"
        >
          {t(userErrorMessageKey(coverageOutcome.errorCode))}
          {coverageOutcome.errorMessage && (
            <span className="text-muted-foreground"> · {coverageOutcome.errorMessage}</span>
          )}
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
          scope === 'all_selected' ? (
            <ResearchDraftComposer
              editorSnapshot={coverageEditorSnapshot}
              conversationSnapshot={coverageConversation}
              gate={coverageGate}
              gateReasonText={composerGateReasonText}
              onDraftChange={(text) => {
                // Coverage 独立草稿：只更新本地状态与版本，不触发会话保存。
                coverageDraftVersionRef.current += 1
                setCoverageDraft({ text, version: coverageDraftVersionRef.current })
              }}
              onSend={submit}
              onRetrySave={() => {}}
              localDraftMode
            />
          ) : noActiveSession ? (
            // O-3：没有活动会话是正常空态，不是加载失败——按 §4.3 只给
            // “新对话”入口，不渲染可持久化输入，也不显示任何故障文案。
            <div
              className="flex flex-col items-start gap-2 rounded-md border border-dashed p-3"
              data-testid="chat-no-session"
            >
              <p className="text-sm text-muted-foreground">
                {t('research.session.newConversation')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('chat.createToStart')}
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => onNewSession?.()}
                disabled={onNewSession === undefined}
                data-testid="chat-no-session-new"
              >
                {t('research.sourceChat.newSession')}
              </Button>
            </div>
          ) : (
            <ResearchDraftComposer
              editorSnapshot={editorSnapshot ?? null}
              conversationSnapshot={wiredConversation}
              gate={composerGate}
              gateReasonText={composerGateReasonText}
              onDraftChange={(text) => {
                // PR-10：用户在会话里输入＝当前 token 与“加载时的持久草稿”无关，
                // 不得触发冷启动查回（否则会产出 not_observed 的 external turn
                // 并阻断随后首次真实发送）。
                markDraftUserAuthored(text)
                ;(onDraftChange ?? (() => {}))(text)
              }}
              onSend={submit}
              onRetrySave={onRetrySave ?? (() => {})}
              onRestoreDraft={
                onRestoreDraft === undefined
                  ? undefined
                  : (writerId) => {
                      // PR-10：恢复他人草稿同样产出“从未提交过的新 token”，归入
                      // 用户/宿主写入，不得触发冷启动查回（否则同样会生成
                      // not_observed external turn 并阻断首次真实发送）。
                      // 恢复文本只有 editor 知道（候选记录不含文本）：记下当前
                      // token，等观察到 token 变化后把恢复出的文本登记为用户写入。
                      restoreSuppressRef.current = {
                        fromToken: editorSnapshot?.draftToken ?? '',
                      }
                      onRestoreDraft(writerId)
                    }
              }
              focusRequestToken={composerFocusToken}
            />
          )
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
