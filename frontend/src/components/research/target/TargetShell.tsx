'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslation } from '@/lib/hooks/use-translation'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useResearchD1e } from '@/lib/hooks/use-research-c05'
import { useSourceMedia } from '@/lib/hooks/use-source-media'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchHostOptional } from '@/lib/embedded/host-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { useResearchJobsController } from '../ResearchJobsProvider'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { countActiveJobs } from '@/lib/research/jobs'
import { formatScopeLabel, useResearchScope } from '@/lib/research/scope'
import { readerBodyMode } from '@/lib/research/reader'
import {
  planReturnToAnswer,
  recordCitationReturnTarget,
  type SessionReturnTarget,
} from '@/lib/research/conversation-machine'
import type {
  ResearchCitationDisplayItem,
  ResearchPendingSelection,
} from '@/lib/research/types'
import type { WireSelectionProjection } from '@/lib/research/session-contract'
import type {
  ResearchCitation as ResearchCitationRecord,
  ResearchSource,
} from '@/lib/types/research'
import { resolveCitationSource } from '../citation-utils'
import { TargetTopBar } from './TargetTopBar'
import { TargetSourcesPane } from './TargetSourcesPane'
import { TargetConversation } from './TargetConversation'
import { TargetRightPane } from './TargetRightPane'
import { TargetSecondaryView } from './TargetSecondaryView'
import { TargetTopicOverview } from './TargetTopicOverview'
import { TargetReaderFocus } from './TargetReaderFocus'
import { useTargetConversation } from './use-target-conversation'
import { useResearchPurposeCapability } from './use-purpose-capability'
import {
  citationReaderRequest,
  locateReaderPages,
  resolveReaderInitialPage,
  sourceReaderRequest,
  type TargetReaderOpenRequest,
} from './target-reader-state'
import {
  TARGET_MIN_VIEWPORT,
  TARGET_THREE_COLUMN_VIEWPORT,
  resolveTargetLayout,
  targetBreakpointForWidth,
} from './target-layout'
import {
  TARGET_RIGHT_PANE_TITLE_KEYS,
  type TargetCitationPreview,
  type TargetRightPaneKind,
} from './target-types'

/** 实际视口宽度（F19：中央列宽度/内边距按真实宽度推导，不止断点下限）。 */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? TARGET_MIN_VIEWPORT : window.innerWidth,
  )
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/**
 * 「返回原回答」目标的 window storage（沙箱/禁用存储时取不到也不阻断：
 * 返回目标仍保留在本次页面内存中，重开由 position_unavailable 兜底）。
 */
function windowReturnTargetStorages(): {
  sessionStorage?: Storage
  localStorage?: Storage
} {
  if (typeof window === 'undefined') return {}
  const storages: { sessionStorage?: Storage; localStorage?: Storage } = {}
  try {
    storages.sessionStorage = window.sessionStorage
  } catch {
    // 隔离沙箱禁止访问 storage：不伪造“已记录”，由内存目标兜底。
  }
  try {
    storages.localStorage = window.localStorage
  } catch {
    // 同上。
  }
  return storages
}

/**
 * 目标工作台壳（W1 #1104；UI 规格 v1 §2.2/§3/§5/§7）。
 *
 * 布局：UI-02 顶栏（72px）＋ UI-04 左资料栏（282px）＋ UI-07 中央对话 ＋
 * UI-12 按需右栏（355px，默认收起）。断点：
 * - 1024–1279：右栏打开时左栏**临时收起**（状态保留），关闭后恢复左栏；
 * - ≥1280：三栏并排，左栏不收起；
 * - 中央列最小 640px；页面无横向滚动。
 *
 * 键盘：跳过链接 → 输入区；右栏打开焦点进面板标题/关闭，`Esc` 关闭并
 * 焦点返回触发控件（A11Y-02，含 citation/source 预览与 compact 左栏恢复，
 * F7）；header/aside/main 地标。
 *
 * 诚实边界（W1）：W2/W3/P6 能力（原文阅读、成果编辑、深入研究执行）不绘制
 * 假控件；空 selected 同时阻断 composer 与次级搜索/比较（BEH-03/F4）；
 * 「本次用途」（UI-11）由 #1106 PR-B 提供：能力位严格 true 时才渲染三选
 * 控件，空 selected 时另给真实的「改为探索讨论/写作」显式动作（D6）。
 * #1125（owner「选A」defect 修复）：中央对话起始位置挂载既有 #1016 主题
 * 概览入口/Dialog（UI 规格 v1 BEH-12/§5.4/D-UI-04=A）；不新增一级导航、
 * 主区动作、路由或右栏面板。
 *
 * W2 #1077（UI 规格 v1 §5.7/BEH-05/BEH-11）：宽屏阅读器以 **overlay** 覆盖
 * 工作台（不新增路由、不卸载 shell）：工作台对话/右栏/草稿全部保活，打开时
 * 对工作台内容设 `inert` + `aria-hidden`；关闭后焦点回触发控件。引用预览/
 * 资料预览「打开原文」经 `citationReaderRequest`/`sourceReaderRequest`
 * 构造请求（citation 携带 durable message_id 与成对版本），「返回原回答」由
 * 纯逻辑 `planReturnToAnswer` 决策（navigate → 关阅读器/右栏 + 滚动目标
 * message；否则 position_unavailable）。阅读器「讨论选段」只把 pending
 * selection 放入 composer chip，发送时才随 `selection_context` 透传且
 * 不改变范围/检索载荷。
 */
export function TargetShell() {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const host = useResearchHostOptional()
  const purposeInferenceAvailable = useResearchPurposeCapability(projectId)
  /**
   * W2 #1077/BEH-11：阅读器显式「讨论选段」→ composer chip。必须声明在
   * conversation hook 之前（hook 的 `getSelectionContext` 读取最新 pending）。
   */
  const [pendingSelection, setPendingSelection] = useState<ResearchPendingSelection | null>(null)
  const conversation = useTargetConversation({
    purposeInferenceAvailable,
    getPendingSelection: () => pendingSelection,
  })
  // 稳定成员引用（React hook 依赖按值比较；避免整个 conversation 对象抖动）。
  const {
    activeRef: conversationActiveRef,
    send: conversationSend,
    turns: conversationTurns,
    pinSingleSource: conversationPinSingleSource,
  } = conversation
  const jobsController = useResearchJobsController()
  const scopeApi = useResearchScope()
  const sourcesQuery = useResearchSources(projectId)
  const { runGuarded, confirmedModelIsExternal } = useResearchGlobalModel()
  const viewportWidth = useViewportWidth()
  const isWideViewport = useMediaQuery(`(min-width: ${TARGET_THREE_COLUMN_VIEWPORT}px)`)
  // 断点判定走媒体查询（响应式/测试可注入）；中央列宽度用真实视口宽度推导
  // （F19：1440 右栏打开时中心 ≥720，不能按 1280 下限误判）。
  const breakpoint = isWideViewport
    ? 'wide'
    : targetBreakpointForWidth(viewportWidth)

  const [rightPane, setRightPane] = useState<TargetRightPaneKind | null>(null)
  const [citationPreview, setCitationPreview] = useState<TargetCitationPreview | null>(null)
  const [sourcePreviewId, setSourcePreviewId] = useState<string | null>(null)
  /** W2 #1077（计划 §2.3-3）：引用跳转的 `page_idx` 作为资料预览的初始页提示；
   *  该预览再进 reader 时作为 `initial_page_idx`（不再 `void pageIdx`）。 */
  const [sourcePreviewInitialPage, setSourcePreviewInitialPage] = useState<number | null>(null)
  const [centerView, setCenterView] = useState<'conversation' | 'evidence-search' | 'compare'>(
    'conversation',
  )
  const [scopeFocusRequest, setScopeFocusRequest] = useState(0)
  // —— W2 #1077：阅读器 overlay 状态（与工作台状态并存；关闭不丢） ——
  const [readerRequest, setReaderRequest] = useState<TargetReaderOpenRequest | null>(null)
  const [readerPageIdx, setReaderPageIdx] = useState<number | null>(null)
  /** citation 点击时的 durable message id（打开原文 → 返回原回答目标）。 */
  const [lastCitationMessageId, setLastCitationMessageId] = useState<string | null>(null)
  const [returnTarget, setReturnTarget] = useState<SessionReturnTarget | null>(null)
  const [returnUnavailable, setReturnUnavailable] = useState(false)
  const [scrollToMessage, setScrollToMessage] = useState<{
    sessionId: string
    messageId: string
    seq: number
  } | null>(null)
  /** media.sourceType 的镜像（wantPageImage 由上一轮 detail 推导，避免循环）。 */
  const [readerSourceType, setReaderSourceType] = useState<string | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const restoreFocusPendingRef = useRef(false)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const shellContentRef = useRef<HTMLDivElement | null>(null)
  const readerTriggerRef = useRef<HTMLElement | null>(null)
  const readerRestorePendingRef = useRef(false)
  const readerRequestKeyRef = useRef<string | null>(null)
  const returnScrollSeqRef = useRef(0)

  // W2 #1077（§5.7）：D1-E 阅读能力 fail-closed（只有严格 ready 才启用入口）。
  const d1e = useResearchD1e(projectId)
  const readerReady = d1e.ready
  const media = useSourceMedia({
    projectId,
    request: readerRequest,
    pageIdx: readerPageIdx,
    wantPageImage: readerBodyMode(readerSourceType) === 'page-image',
  })

  useEffect(() => {
    setReaderSourceType(media.sourceType)
  }, [media.sourceType])

  const readerRequestKey =
    readerRequest === null
      ? null
      : [
          readerRequest.origin,
          readerRequest.sourceId,
          readerRequest.messageId ?? '',
          readerRequest.initialPageIdx === null ? '' : String(readerRequest.initialPageIdx),
        ].join('|')

  // detail ready 后解析初始页（新请求/切 source 重置；不伪造页）。
  useEffect(() => {
    if (readerRequest === null) {
      readerRequestKeyRef.current = null
      return
    }
    if (readerRequestKeyRef.current === readerRequestKey) return
    if (media.detailStatus !== 'ready') return
    readerRequestKeyRef.current = readerRequestKey
    const pages = locateReaderPages({
      chunks: Array.isArray(media.detail?.markdown_chunks) ? media.detail.markdown_chunks : [],
      citationPageIdx: readerRequest.initialPageIdx,
      versionState: media.versionState,
    })
    setReaderPageIdx(
      resolveReaderInitialPage(pages, readerRequest.initialPageIdx, media.versionState),
    )
  }, [
    readerRequest,
    readerRequestKey,
    media.detailStatus,
    media.detail,
    media.versionState,
  ])

  // —— W2 #1077：工作台内容 inert（关闭后移除；不卸载状态） ——
  useEffect(() => {
    const node = shellContentRef.current
    if (node === null) return
    if (readerRequest !== null) {
      node.setAttribute('inert', '')
      node.setAttribute('aria-hidden', 'true')
    } else {
      node.removeAttribute('inert')
      node.removeAttribute('aria-hidden')
    }
    return () => {
      node.removeAttribute('inert')
      node.removeAttribute('aria-hidden')
    }
  }, [readerRequest])

  // —— W2 #1077：关闭阅读器后焦点回触发控件（工作台不重挂载） ——
  useEffect(() => {
    if (readerRequest !== null) return
    if (!readerRestorePendingRef.current) return
    readerRestorePendingRef.current = false
    const trigger = readerTriggerRef.current
    readerTriggerRef.current = null
    if (trigger !== null && trigger.isConnected) {
      trigger.focus()
      return
    }
    // 阅读器触发控件已被移除（如「返回原回答」同时关闭右栏）：焦点回工作台
    // 输入区；`preventScroll` 不得覆盖刚下发的 durable message 滚动定位。
    shellRef.current
      ?.querySelector<HTMLElement>('[data-testid="chat-input"]')
      ?.focus({ preventScroll: true })
  }, [readerRequest])

  const layout = resolveTargetLayout({
    breakpoint,
    rightPaneOpen: rightPane !== null,
    viewportWidth,
  })

  // —— F4/BEH-03：空 selected 同时阻断 composer 与证据搜索/比较 ——
  const scopeSnapshot = scopeApi.getSnapshot()
  const scopeBlocked =
    scopeSnapshot.mode === 'selected' &&
    scopeSnapshot.sourceIds.length === 0 &&
    scopeSnapshot.noteIds.length === 0
  const scopeBlockedText = scopeBlocked ? t('research.target.composer.scopeBlocked') : null

  // —— F7：关闭右栏后焦点回到触发控件；compact 左栏恢复可见后再执行 ——
  useEffect(() => {
    if (rightPane !== null) return
    if (!restoreFocusPendingRef.current) return
    restoreFocusPendingRef.current = false
    const trigger = triggerRef.current
    triggerRef.current = null
    if (trigger !== null && trigger.isConnected) {
      trigger.focus()
      if (typeof document !== 'undefined' && document.activeElement === trigger) return
    }
    shellRef.current
      ?.querySelector<HTMLElement>('[data-testid="chat-input"]')
      ?.focus()
  }, [rightPane])

  const closeRightPane = useCallback(() => {
    restoreFocusPendingRef.current = true
    setRightPane(null)
  }, [])

  const openPane = useCallback(
    (kind: TargetRightPaneKind, trigger: HTMLElement | null) => {
      triggerRef.current = trigger
      setRightPane(kind)
    },
    [],
  )

  // `Esc` 关闭右栏（文档级：焦点在面板任意位置都生效；不拦截弹层自身）。
  // W2 #1077：阅读器打开时 Esc 归阅读器（关闭 overlay），不关底层右栏。
  useEffect(() => {
    if (rightPane === null) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (readerRequest !== null) return
      const target = event.target
      // 弹层（Radix Dialog/Popover，role=dialog/listbox）自行处理 Esc，不抢。
      if (
        target instanceof Element &&
        target.closest('[role="dialog"], [role="listbox"]') !== null
      ) {
        return
      }
      event.stopPropagation()
      closeRightPane()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [rightPane, closeRightPane, readerRequest])

  const openSourcePreview = useCallback(
    (sourceId: string, trigger: HTMLElement | null, initialPageIdx: number | null = null) => {
      triggerRef.current = trigger
      setSourcePreviewId(sourceId)
      setSourcePreviewInitialPage(initialPageIdx)
      setRightPane('source')
    },
    [],
  )

  // —— W2 #1077：引用预览/资料预览 → 宽屏阅读器 overlay ——
  const sources = useMemo(() => sourcesQuery.data?.items ?? [], [sourcesQuery.data])

  /** 记录「返回原回答」目标（durable message_id + citation 身份 + 会话）。 */
  const recordReturnTargetForCitation = useCallback(
    (
      citation: ResearchCitationDisplayItem,
      sourceId: string,
      messageId: string | null,
    ): SessionReturnTarget | null => {
      const activeRef = conversationActiveRef
      if (
        messageId === null ||
        messageId.length === 0 ||
        activeRef === null ||
        sourceId.length === 0
      ) {
        return null
      }
      return recordCitationReturnTarget({
        projectId,
        ref: activeRef,
        messageId,
        citation: {
          sourceId,
          docId: citation.doc_id,
          docVersion: citation.doc_version ?? null,
          chunkId: citation.chunk_id ?? null,
          pageIdx: citation.page_idx ?? null,
        },
        ...windowReturnTargetStorages(),
      })
    },
    [conversationActiveRef, projectId],
  )

  /**
   * W2 #1077（§5.6 UI-13/BEH-05）：citation 点击 → 右栏引用预览。
   *
   * 记录 durable message_id（打开原文 → citation 阅读器请求）并**尽力**
   * 记录「返回原回答」目标（有 messageId + activeRef 时；storage 不可用也
   * 保留本次内存目标）。citation 来源此刻可能尚未解析（sources 未加载）——
   * 打开原文时会按精确来源补记。
   */
  const openCitation = useCallback(
    (
      preview: TargetCitationPreview,
      trigger: HTMLElement | null,
      messageId: string | null,
    ) => {
      triggerRef.current = trigger
      setCitationPreview(preview)
      setRightPane('citation')
      setLastCitationMessageId(messageId)
      setReturnUnavailable(false)
      const citation = preview.citation
      const resolved =
        preview.sourceId !== null
          ? sources.find((source) => source.source_id === preview.sourceId)
          : resolveCitationSource(sources, citation as unknown as ResearchCitationRecord)
      const citationSourceId = resolved?.source_id ?? preview.sourceId ?? ''
      setReturnTarget(recordReturnTargetForCitation(citation, citationSourceId, messageId))
    },
    [recordReturnTargetForCitation, sources],
  )

  /** 打开阅读器：记录触发控件（关闭后焦点回位），重置页/返回提示。 */
  const startReader = useCallback((request: TargetReaderOpenRequest) => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    readerTriggerRef.current = active instanceof HTMLElement ? active : null
    setReaderRequest(request)
    setReaderPageIdx(null)
    setReturnUnavailable(false)
  }, [])

  const closeReader = useCallback(() => {
    readerRestorePendingRef.current = true
    setReaderRequest(null)
  }, [])

  /** 引用预览「打开原文」：citation 入口（成对版本 + durable messageId）。 */
  const openCitationOriginal = useCallback(
    (source: ResearchSource) => {
      if (citationPreview === null || source.source_id === null) return
      const citation = citationPreview.citation
      // sources 未加载时点击预览会漏记返回目标；打开原文时按精确来源补记
      // （只补一次；已有目标不覆盖，避免重复写 storage）。
      if (returnTarget === null) {
        const recorded = recordReturnTargetForCitation(
          citation,
          source.source_id,
          lastCitationMessageId,
        )
        if (recorded !== null) setReturnTarget(recorded)
      }
      startReader(
        citationReaderRequest({
          citation,
          sourceId: source.source_id,
          messageId: lastCitationMessageId,
        }),
      )
    },
    [citationPreview, lastCitationMessageId, recordReturnTargetForCitation, returnTarget, startReader],
  )

  /** 资料预览「打开原文」：source 入口（最新版；不携带 citation/返回目标）。 */
  const openSourceOriginal = useCallback(
    (source: ResearchSource) => {
      if (source.source_id === null) return
      startReader(
        sourceReaderRequest({
          sourceId: source.source_id,
          initialPageIdx: sourcePreviewInitialPage,
        }),
      )
    },
    [sourcePreviewInitialPage, startReader],
  )

  /**
   * W2 #1077（BEH-05）：返回原回答 = 纯逻辑决策。
   *
   * navigate → 关闭阅读器与右栏，向对话下发 durable message 滚动请求；
   * 否则（无目标/会话不匹配/storage 不可得）→ position_unavailable，
   * 绝不跳最新、不改写任何历史。
   */
  const handleReturnToAnswer = useCallback(() => {
    const plan = planReturnToAnswer({
      target: returnTarget,
      globalRef: conversationActiveRef,
      sourceRef: null,
    })
    if (plan.kind !== 'navigate') {
      setReturnUnavailable(true)
      return
    }
    setReturnUnavailable(false)
    returnScrollSeqRef.current += 1
    setScrollToMessage({
      sessionId: plan.sessionId,
      messageId: plan.messageId,
      seq: returnScrollSeqRef.current,
    })
    // 返回原回答时右栏也关闭；右栏的「焦点回触发控件」会聚焦 citation 按钮
    // 并把会话滚动拉离目标回答（1024 下目标回答被滚出视口）。滚动定位由
    // `scrollToMessage` 负责，焦点由阅读器关闭路径回输入区（preventScroll）。
    restoreFocusPendingRef.current = false
    closeReader()
    closeRightPane()
  }, [closeReader, closeRightPane, conversationActiveRef, returnTarget])

  /** W2 #1077/BEH-11：阅读器「讨论选段」→ composer chip + 关闭阅读器。 */
  const handleDiscussSelection = useCallback(
    (pending: ResearchPendingSelection) => {
      // 目标壳只有 headed global 对话面；来源会话选段一律不携带（不改变范围）。
      setPendingSelection({ ...pending, target: 'global' })
      closeReader()
    },
    [closeReader],
  )

  /** 阅读器「只问此来源」：复用既有 single-pin；成功后关闭 overlay 露出 chip。 */
  const handleAskThisSource = useCallback(() => {
    if (readerRequest === null) return
    if (conversationPinSingleSource(readerRequest.sourceId)) {
      closeReader()
      closeRightPane()
    }
  }, [closeReader, closeRightPane, conversationPinSingleSource, readerRequest])

  /** W2 #1077/#1013：user turn 选段 chip → 打开阅读器并定位到选段页。 */
  const handleSelectionJump = useCallback(
    (selection: WireSelectionProjection) => {
      startReader(
        sourceReaderRequest({ sourceId: selection.sourceId, initialPageIdx: selection.pageIdx }),
      )
    },
    [startReader],
  )

  const handleOpenHistory = useCallback(
    (trigger: HTMLElement) => {
      openPane('conversations', trigger)
    },
    [openPane],
  )

  const handleCitationJump = useCallback(
    (sourceId: string, pageIdx: number | null) => {
      // W2 #1077（计划 §2.3-3）：引用跳转按资料预览（最新版）语义打开，
      // 但保留 citation `page_idx` 作为该预览再进 reader 时的初始页提示；
      // 不再丢弃（不声称被引版本，需要被引版本时走 UI-13 引用预览入口）。
      openSourcePreview(sourceId, null, typeof pageIdx === 'number' ? pageIdx : null)
    },
    [openSourcePreview],
  )

  const sourcesReady = sourcesQuery.isSuccess && (sourcesQuery.data?.items.length ?? 0) > 0
  const secondaryAvailable = sourcesReady && !scopeBlocked
  const composerScopeLabel = useMemo(
    () =>
      layout.composerShowsCompactScope
        ? formatScopeLabel(scopeApi.getSnapshot(), t)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每次渲染快照按需重取
    [layout.composerShowsCompactScope, t, scopeApi, conversation.activeRef, conversation.scopeBlockedText],
  )

  // —— W2 #1077/BEH-11：composer 选段 chip（与单篇 pin 并存；移除即清） ——
  const selectionChip = useMemo(() => {
    if (pendingSelection === null || pendingSelection.target !== 'global') return null
    const quote = pendingSelection.selection.quote
    return {
      label: t('research.selection.chip', {
        source: pendingSelection.sourceTitle ?? pendingSelection.sourceId,
        page: pendingSelection.pageIdx === null ? '-' : pendingSelection.pageIdx + 1,
        start: pendingSelection.selection.startOffset + 1,
        end: pendingSelection.selection.endOffset,
        quote: quote.length > 40 ? `${quote.slice(0, 40)}…` : quote,
      }),
      title: quote,
      onRemove: () => setPendingSelection(null),
    }
  }, [pendingSelection, t])

  // 发送成功才清 pending 选段（失败保留可重试）；范围/检索载荷不变。
  const handleComposerSend = useCallback(
    async (text: string): Promise<boolean> => {
      const sent = await conversationSend(text)
      if (sent) setPendingSelection(null)
      return sent
    },
    [conversationSend],
  )
  const conversationView = { ...conversation, send: handleComposerSend }

  // 阅读器 aside「当前回答」：citation 入口按 durable message 取当轮回答正文；
  // source 入口/无法绑定 → null（aside 如实显示不可用）。
  const readerAnswerContext = useMemo(() => {
    if (readerRequest === null || readerRequest.messageId === null) return null
    const turn = conversationTurns.find(
      (item) => item.role === 'assistant' && item.serverMessageId === readerRequest.messageId,
    )
    if (turn === undefined) return null
    return turn.content.trim().length > 0 ? turn.content : null
  }, [conversationTurns, readerRequest])

  // 「返回原回答」只在 citation 入口且存在耐久目标时出现。
  const readerReturnAvailable =
    readerRequest !== null && readerRequest.origin === 'citation' && returnTarget !== null

  const layoutStyle = {
    borderColor: 'var(--rdlens-line)',
    backgroundColor: 'var(--rdlens-paper)',
  } as const

  const paneTitle = rightPane === null ? null : t(TARGET_RIGHT_PANE_TITLE_KEYS[rightPane])

  return (
    <div
      ref={shellRef}
      className="rdlens-target-shell flex h-full min-h-0 flex-col"
      style={layoutStyle}
      data-testid="rdlens-target-shell"
      data-breakpoint={breakpoint}
      data-center-width={layout.centerColumnWidth}
      data-right-pane-open={rightPane !== null ? 'true' : undefined}
      data-left-pane-collapsed={layout.leftPaneTemporarilyCollapsed ? 'true' : undefined}
    >
      {/* W2 #1077：工作台内容（顶栏 + 三栏 + 播报）在阅读器打开时
          `inert` + `aria-hidden`（ref effect 设置，关闭移除）；对话/右栏/
          草稿保持挂载，关闭阅读器后原样恢复。 */}
      <div
        ref={shellContentRef}
        className="flex h-full min-h-0 flex-1 flex-col"
        data-testid="rdlens-target-shell-content"
      >
      {/* A11Y-01：跳到输入区（首个可聚焦元素，键盘用户可直接进入 composer） */}
      <a
        href="#rdlens-target-composer"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:px-3 focus:py-2 focus:text-sm"
        style={{
          backgroundColor: 'var(--rdlens-evidence)',
          color: 'var(--rdlens-on-evidence)',
        }}
        data-testid="rdlens-target-skip-link"
      >
        {t('research.target.a11y.skipToComposer')}
      </a>

      <TargetTopBar
        projectName={host?.projectName ?? null}
        activeJobCount={countActiveJobs(jobsController.jobs)}
        rightPane={rightPane}
        onOpenPane={openPane}
      />

      <div className="flex min-h-0 flex-1">
        {/* §3.3/§5.6：compact + 右栏打开 → 左栏**临时收起但保持挂载**，
            保留搜索/滚动/范围显示状态；关闭右栏立即恢复（不重挂载）。 */}
        <aside
          aria-label={t('research.target.a11y.sources')}
          aria-hidden={layout.leftPaneVisible ? undefined : true}
          className={`h-full min-h-0 w-[282px] shrink-0 flex-col border-r ${
            layout.leftPaneVisible ? 'flex' : 'hidden'
          }`}
          style={{ borderColor: 'var(--rdlens-line)', backgroundColor: 'var(--rdlens-surface-subtle)' }}
          data-testid="rdlens-target-sources-aside"
        >
          <TargetSourcesPane
            onOpenSource={openSourcePreview}
            scopeFocusRequest={scopeFocusRequest}
            purposeInferenceAvailable={conversation.purposeInferenceAvailable}
            onSetWorkPurpose={conversation.setWorkPurpose}
          />
        </aside>

        <main
          id="rdlens-target-main"
          aria-label={t('research.target.a11y.main')}
          className="flex min-h-0 min-w-[640px] flex-1 flex-col"
          style={{ backgroundColor: 'var(--rdlens-paper)' }}
          data-testid="rdlens-target-main"
        >
          {/* 对话保持挂载：切到次级视图不丢流式/草稿 */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            hidden={centerView !== 'conversation'}
            data-testid="rdlens-target-conversation-slot"
          >
            <TargetConversation
              conversation={conversationView}
              onOpenHistory={handleOpenHistory}
              onNewConversation={() => void conversation.newSession()}
              onOpenCitation={openCitation}
              rightPane={rightPane}
              onOpenRightPane={openPane}
              onOpenSearch={() => setCenterView('evidence-search')}
              onOpenCompare={() => setCenterView('compare')}
              searchAvailable={secondaryAvailable}
              compareAvailable={secondaryAvailable}
              secondaryBlockedReason={scopeBlockedText}
              compactScopeChip={composerScopeLabel}
              selectionChip={selectionChip}
              scrollToMessage={scrollToMessage}
              onSelectionJump={handleSelectionJump}
              onCompactScopeChipActivate={() => {
                closeRightPane()
                setScopeFocusRequest((request) => request + 1)
              }}
              // #1125：中央对话起始位置的既有 #1016 概览入口/Dialog。仅在
              // 对话中心视图注入（次级视图不渲染，DOM 不残留 hidden 入口）；
              // 引用跳转复用 shell 既有右栏来源预览；继续讨论写当前会话既有
              // 草稿（无活动会话 → `editorHandle=null`，动作 fail-closed 隐藏）。
              overviewSlot={
                centerView === 'conversation' ? (
                  <TargetTopicOverview
                    projectId={projectId}
                    onCitationJump={handleCitationJump}
                    editorHandle={conversation.sessionWired ? conversation.editor : null}
                    canExecute={conversation.canExecute}
                    blockedHint={conversation.blockedHint}
                    isAdminReadonly={isAdminReadonly}
                    confirmedModelIsExternal={confirmedModelIsExternal === true}
                  />
                ) : undefined
              }
            />
          </div>

          {centerView !== 'conversation' && (
            <TargetSecondaryView
              view={centerView}
              onBack={() => setCenterView('conversation')}
              onCitationJump={handleCitationJump}
              scopeBlockedText={scopeBlockedText}
              compare={{
                isCreating: jobsController.isCreating,
                error: jobsController.error,
                errorCode: jobsController.errorCode ?? null,
                onCreate: async (documentIds, groupSize) => {
                  const scopeLabel = formatScopeLabel(
                    {
                      mode: 'selected',
                      sourceIds: [...documentIds],
                      noteIds: [],
                      singleSourceId: null,
                    },
                    t,
                  )
                  const sent = await runGuarded(
                    (modelId) => {
                      jobsController.createCompare(documentIds, modelId, groupSize)
                      return true
                    },
                    { scopeLabel },
                  )
                  return sent === true
                },
                modelBlocked: !conversation.canExecute,
                blockedHint: conversation.blockedHint,
              }}
            />
          )}
        </main>

        {layout.rightPaneVisible && rightPane !== null && (
          <TargetRightPane
            kind={rightPane}
            onClose={closeRightPane}
            citationPreview={citationPreview}
            sourceId={sourcePreviewId}
            sessions={conversation.sessions}
            activeRef={conversation.activeRef}
            onOpenSession={conversation.openSession}
            onNewSession={() => void conversation.newSession()}
            canPinSingleSource={conversation.canPinSingleSource}
            onAskThisSource={(sourceId) => {
              if (conversation.pinSingleSource(sourceId)) closeRightPane()
            }}
            jobs={jobsController.jobs}
            readerReady={readerReady}
            onOpenCitationOriginal={openCitationOriginal}
            onOpenSourceOriginal={openSourceOriginal}
          />
        )}
      </div>

      {/* 面板打开/关闭播报（不打断焦点；标题随面板切换） */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="rdlens-target-pane-live">
        {paneTitle === null ? '' : t('research.target.rightPane.openedLive', { title: paneTitle })}
      </p>
      </div>

      {/* W2 #1077（UI 规格 v1 §5.7/BEH-05）：宽屏阅读器 overlay。
          覆盖整个工作台（fixed inset-0），不新增路由、不卸载 shell。 */}
      {readerRequest !== null && (
        <TargetReaderFocus
          request={readerRequest}
          media={media}
          answerContext={readerAnswerContext}
          returnAvailable={readerReturnAvailable}
          returnUnavailableNotice={returnUnavailable}
          canPinSingleSource={conversation.canPinSingleSource}
          onAskThisSource={handleAskThisSource}
          onReturnToAnswer={handleReturnToAnswer}
          onOpenFile={media.openFile}
          onDiscussSelection={handleDiscussSelection}
          onClose={closeReader}
          pageIdx={readerPageIdx}
          onSelectPage={setReaderPageIdx}
          viewportWidth={viewportWidth}
        />
      )}
    </div>
  )
}
