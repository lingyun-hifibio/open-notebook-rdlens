'use client'

import { useState, type ReactNode } from 'react'
import { History, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { CoverageSubmitOutcome } from '@/lib/hooks/use-research-chat'
import { ResearchChatPanel } from '../ResearchChatPanel'
import { translateOrFallback } from '@/lib/locales/translate-or-fallback'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { WireSelectionProjection } from '@/lib/research/session-contract'
import type { TargetCitationPreview, TargetRightPaneKind } from './target-types'
import type { TargetConversationState } from './use-target-conversation'
import { TargetComposer } from './TargetComposer'

/**
 * §3.2：中央对话正文列/面板的水平内边距（双侧一致的 clamp）。
 *
 * 宽度语义按规格是**分别定义**：正文列 max-width 850、composer max-width
 * 682，各自在外层同 padding 容器内居中——两者左缘相差 (850−682)/2 = 84px
 * 属规格定义，不是残留错位；不要为了“左缘完全对齐”把 composer 拉宽到 850。
 */
const CENTER_INLINE_PADDING = 'clamp(28px, 5vw, 84px)'
const CENTER_BODY_MAX_WIDTH = '850px'
const CENTER_COMPOSER_MAX_WIDTH = '682px'

/**
 * UI-07 中央对话（W1 #1104；UI 规格 v1 §5.4）。
 *
 * - 标题区：上下文 kicker + 对话标题 + 一句说明 + 历史/新对话（位于标题右侧，
 *   §2.4）；历史打开右栏 UI-16，新对话走既有 session 能力；
 * - 消息区：复用 `ResearchChatPanel` 作为**内容面**（加性 props 关闭面板内的
 *   会话标题/范围条/composer/coverage 范围选择器——目标壳不叠加第二套范围
 *   或模型控件）；
 * - composer 固定在中央列底部，不随消息滚走；
 * - runtime 可用但无活动会话（F3）：显示「新建/选择会话」说明并禁用发送，
 *   不静默退化到 legacy 单连续会话；
 * - `overviewSlot`（可选，由 shell 注入 #1125 主题概览入口）：渲染在标题区
 *   之下、消息区之上的「中央对话起始位置」轻量卡片行，与正文列同内边距/
 *   同最大宽度（D-UI-04=A：不打开右栏、不新增一级导航/主区动作/路由）；
 *   不传时不影响既有布局；
 * - W1 允许「引用点击 → 右栏引用预览」的最小可用行为；W2/W3 能力明确不可用。
 */
export function TargetConversation({
  conversation,
  onOpenHistory,
  onNewConversation,
  onOpenCitation,
  onViewNote,
  rightPane,
  onOpenRightPane,
  onOpenSearch,
  onOpenCompare,
  searchAvailable,
  compareAvailable,
  secondaryBlockedReason,
  compactScopeChip,
  onCompactScopeChipActivate,
  selectionChip,
  scrollToMessage,
  onSelectionJump,
  overviewSlot,
}: {
  conversation: TargetConversationState
  onOpenHistory: (trigger: HTMLElement) => void
  onNewConversation: () => void
  onOpenCitation: (
    preview: TargetCitationPreview,
    trigger: HTMLElement | null,
    messageId: string | null,
  ) => void
  /**
   * #1191 W3-G1（BEH-09）：回答结果「查看笔记」→ 目标壳打开右栏成果目录并
   * reveal 该行（不自动打开编辑器；不传时既有 ResultActions 行为不变）。
   */
  onViewNote?: (noteId: string) => void
  /** 当前右栏面板（aria-expanded 与真实状态一致） */
  rightPane: TargetRightPaneKind | null
  onOpenRightPane: (kind: 'conversations', trigger: HTMLElement) => void
  onOpenSearch: () => void
  onOpenCompare: () => void
  searchAvailable: boolean
  compareAvailable: boolean
  /** 空 selected 时次级操作的阻断原因（F4，与 composer 同源） */
  secondaryBlockedReason: string | null
  compactScopeChip: string | null
  onCompactScopeChipActivate: () => void
  /** W2 #1077/BEH-11：阅读器选段 chip（由 shell 计算，独立于单篇 pin） */
  selectionChip?: {
    readonly label: string
    readonly title?: string
    readonly onRemove: () => void
  } | null
  /** W2 #1077/#1013 §2.10：返回原回答的 durable message 滚动请求 */
  scrollToMessage?: {
    readonly sessionId: string
    readonly messageId: string
    readonly seq: number
  } | null
  /** W2 #1077/#1013 §2.10：user turn 选段 chip 点击 → 打开阅读器定位选段 */
  onSelectionJump?: (selection: WireSelectionProjection) => void
  /**
   * #1125/D-UI-04=A：中央对话起始位置的轻量概览入口（由 shell 注入，仅在
   * 对话中心视图传入）。可选——不传时保持既有结构（次级视图不走对话列）。
   */
  overviewSlot?: ReactNode
}) {
  const { t } = useTranslation()
  // #1106：用途展开态由本层拥有——composer 自身切换与回答脚注「改用途」
  // 入口共用同一展开状态（打开后把焦点送到 composer 用途控件）。
  const [purposeMenuOpen, setPurposeMenuOpen] = useState(false)
  // 回答「改用途」把该轮提问放回 composer（新请求/旧回答不变）；seq 递增
  // 触发面板既有 prefill 接线（不自动发送，需用户确认后发送）。
  const [purposePrefill, setPurposePrefill] = useState<{ text: string; seq: number } | null>(null)
  const handleRequestPurposeChange = (query: string): void => {
    if (query.trim() === '') {
      setPurposeMenuOpen(true)
      return
    }
    setPurposePrefill((previous) => ({
      text: query,
      seq: (previous?.seq ?? 0) + 1,
    }))
    setPurposeMenuOpen(true)
  }
  const sessionTitle =
    conversation.sessionMeta?.recordVisibility === 'restricted'
      ? translateOrFallback(
          t,
          'research.session.restrictedConversation',
          'Restricted conversation',
        )
      : conversation.sessionMeta?.title ?? null
  const title = sessionTitle ?? t('research.target.conversation.titleFallback')

  const sessions = conversation.sessions
  const sessionsLoading = sessions !== null && sessions.loading
  const sessionsError = sessions !== null && sessions.error !== null
  // F15：loading / unavailable / error 原因分开，不再把“加载中”写成“运行时未接入”。
  const historyUnavailableReason =
    sessions === null
      ? t('research.target.conversation.sessionUnavailable')
      : sessionsLoading
        ? t('research.target.conversation.loading')
        : sessionsError
          ? t('research.loadFailed')
          : null
  const historyAvailable = historyUnavailableReason === null
  const createUnavailableReason =
    sessions === null
      ? t('research.target.conversation.newUnavailable')
      : sessionsLoading
        ? t('research.target.conversation.loading')
        : !sessions.canCreate
          ? t('research.target.conversation.newUnavailable')
          : null
  const createAvailable = createUnavailableReason === null && !sessions?.creating

  // W2 #1077/BEH-05：#1013 citation 点击继续走既有右栏引用预览；durable
  // message_id 一并透传（shell 据此记录「返回原回答」目标 + 阅读器请求）。
  const handleCitationReturn = (
    citation: ResearchCitationDisplayItem,
    messageId: string | null,
  ): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    onOpenCitation(
      { citation, sourceId: null },
      active instanceof HTMLElement ? active : null,
      messageId,
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="rdlens-target-conversation">
      <div
        className="shrink-0 border-b pb-3 pt-5"
        style={{
          borderColor: 'var(--rdlens-line)',
          paddingInline: CENTER_INLINE_PADDING,
        }}
        data-testid="rdlens-target-conversation-header"
      >
        {/* N4：标题区与正文列使用同一内宽容器（850 居中），左缘一致 */}
        <div style={{ maxWidth: CENTER_BODY_MAX_WIDTH, width: '100%', marginInline: 'auto' }}>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--rdlens-ink-muted)' }}
            >
              {t('research.target.conversation.kicker')}
            </p>
            <h2
              className="rdlens-serif mt-0.5 min-w-0 truncate text-[23px] font-medium leading-snug"
              title={title}
              data-testid="rdlens-target-conversation-title"
            >
              {title}
            </h2>
            {/* §5.4 UI-07「一句说明」：解释本对话的用途边界 */}
            <p
              className="mt-1 text-sm leading-relaxed"
              style={{ color: 'var(--rdlens-ink-muted)' }}
              data-testid="rdlens-target-conversation-description"
            >
              {t('research.target.conversation.description')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-[38px] gap-1.5"
              disabled={!historyAvailable}
              title={historyAvailable ? undefined : historyUnavailableReason ?? undefined}
              aria-describedby={historyAvailable ? undefined : 'rdlens-target-history-reason'}
              aria-expanded={rightPane === 'conversations'}
              // A11Y-03：仅在面板真实渲染时输出 aria-controls（关闭时不悬空）
              aria-controls={rightPane !== null ? 'rdlens-target-right-pane' : undefined}
              onClick={(event) => {
                if (rightPane !== 'conversations') {
                  onOpenRightPane('conversations', event.currentTarget)
                  return
                }
                onOpenHistory(event.currentTarget)
              }}
              data-testid="rdlens-target-history-trigger"
            >
              <History aria-hidden="true" className="h-4 w-4" />
              <span className="max-xl:hidden">{t('research.target.conversation.history')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-[38px] gap-1.5"
              disabled={!createAvailable}
              title={createAvailable ? undefined : createUnavailableReason ?? undefined}
              aria-describedby={createAvailable ? undefined : 'rdlens-target-new-reason'}
              onClick={onNewConversation}
              data-testid="rdlens-target-new-conversation"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              <span className="max-xl:hidden">{t('research.target.conversation.newConversation')}</span>
            </Button>
          </div>
        </div>
        {/* 不可用原因常显（不是假控件：按钮 disabled 且原因可见，F15）。 */}
        {!historyAvailable && (
          <p
            id="rdlens-target-history-reason"
            className="mt-2 text-xs"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-history-unavailable"
          >
            {historyUnavailableReason}
          </p>
        )}
        {!createAvailable && (
          <p
            id="rdlens-target-new-reason"
            className="mt-2 text-xs"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-new-unavailable"
          >
            {createUnavailableReason ?? t('research.target.conversation.newUnavailable')}
          </p>
        )}
        {/* F3：runtime 可用但无活动会话——明确的新建会话入口，不静默走 legacy。 */}
        {conversation.noActiveSession && (
          <div
            className="mt-3 space-y-2 rounded-[4px] px-3 py-2"
            style={{ backgroundColor: 'var(--rdlens-field)' }}
            data-testid="rdlens-target-no-session"
          >
            <p className="text-sm font-medium">{t('research.target.conversation.noActiveSession')}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!createAvailable}
              onClick={onNewConversation}
              data-testid="rdlens-target-no-session-new"
            >
              {t('research.target.conversation.newConversation')}
            </Button>
          </div>
        )}
        </div>
      </div>

      {/* #1125/D-UI-04=A：中央对话起始位置的轻量概览入口行（标题区之下、
          消息区之上）。仅当 shell 注入时渲染；与正文列同内边距/同最大宽度
          （850），不覆盖/不拦截消息区与 composer。 */}
      {overviewSlot !== undefined && (
        <div
          className="shrink-0"
          style={{ paddingInline: CENTER_INLINE_PADDING }}
          data-testid="rdlens-target-overview-slot"
        >
          <div style={{ maxWidth: CENTER_BODY_MAX_WIDTH, width: '100%', marginInline: 'auto' }}>
            {overviewSlot}
          </div>
        </div>
      )}

      {/* 消息内容面：复用既有 ChatPanel；关闭其会话标题/范围条/composer，
          避免重复范围权威与重复标题（目标壳 composer 在中央列底部）。 */}
      <div
        className="min-h-0 flex-1"
        style={{ paddingInline: CENTER_INLINE_PADDING }}
        data-testid="rdlens-target-message-area-padded"
      >
        <div
          className="h-full min-h-0"
          data-testid="rdlens-target-message-area"
          style={{ maxWidth: CENTER_BODY_MAX_WIDTH, width: '100%', marginInline: 'auto' }}
        >
        <ResearchChatPanel
          turns={conversation.turns}
          isStreaming={conversation.isStreaming}
          onSend={() => Promise.resolve(false)}
          onSendCoverage={(): Promise<CoverageSubmitOutcome> =>
            Promise.resolve({ status: 'not_dispatched' })
          }
          sendDisabled={!conversation.canExecute}
          blockedHint={conversation.blockedHint}
          onCitationReturn={handleCitationReturn}
          onViewNote={onViewNote}
          scrollToMessage={scrollToMessage}
          onSelectionJump={onSelectionJump}
          backgroundNotice={conversation.backgroundNotice}
          resolveChatOrigin={conversation.resolveChatOrigin}
          editorSnapshot={conversation.sessionWired ? conversation.editorSnapshot : undefined}
          submissionReady={conversation.submissionReady}
          editorHandle={conversation.editor}
          conversation={conversation.conversation}
          sessionRef={conversation.activeRef}
          sessionMeta={conversation.sessionMeta}
          sessionCards={conversation.sessionCards}
          submissionLookup={conversation.submissionLookup}
          markerWriteFailed={conversation.markerWriteFailed}
          refreshMarkerLookups={conversation.refreshMarkerLookups}
          onSendSession={async () => false}
          onNewSession={onNewConversation}
          onDraftChange={(text) => conversation.editor.setDraftText(text)}
          onRetrySave={() => void conversation.editor.retrySave()}
          hideComposer
          // 目标壳 composer 由 shell 拥有：跨端草稿的 draft-token 级冷启动
          // 查回不适用（mount 的 reconcileMarkers 仍恢复 active/marker）；
          // 详见 ResearchChatPanel 的 prop 注释（真实 harness 缺陷修复）。
          suppressColdStartLookup
          // #1106：回答脚注「改用途」入口（能力位 false 时不传入 → 不渲染
          // 纠正动作，避免假控件）。点击把该轮提问放回 composer。
          onRequestPurposeChange={
            conversation.purposeInferenceAvailable
              ? handleRequestPurposeChange
              : undefined
          }
          // #1106/D6：422 scope_selected_empty 的「改为探索讨论并重发」。
          onRetryWithPurpose={
            conversation.purposeInferenceAvailable
              ? (query) => conversation.sendWithPurpose(query, 'exploration')
              : undefined
          }
          prefill={purposePrefill}
          showCoverageScopeSelector={false}
          showSessionScopeBar={false}
          showSessionHeader={false}
        />
        </div>
      </div>

      <div
        className="shrink-0 border-t pt-3"
        style={{
          borderColor: 'var(--rdlens-line)',
          backgroundColor: 'var(--rdlens-surface-subtle)',
          paddingInline: CENTER_INLINE_PADDING,
        }}
      >
        <div style={{ maxWidth: CENTER_COMPOSER_MAX_WIDTH, width: '100%', marginInline: 'auto' }}>
          <TargetComposer
            sessionWired={conversation.sessionWired}
            editor={conversation.editor}
            editorSnapshot={conversation.editorSnapshot}
            submissionReady={conversation.submissionReady}
            isStreaming={conversation.isStreaming}
            canExecute={conversation.canExecute}
            blockedHint={conversation.blockedHint}
            scopeBlockedText={conversation.scopeBlockedText}
            noActiveSession={conversation.noActiveSession}
            sendError={conversation.sendError}
            onClearSendError={conversation.clearSendError}
            onSend={conversation.send}
            onOpenSearch={onOpenSearch}
            onOpenCompare={onOpenCompare}
            searchAvailable={searchAvailable}
            compareAvailable={compareAvailable}
            secondaryBlockedReason={secondaryBlockedReason}
            compactScopeChip={compactScopeChip}
            onCompactScopeChipActivate={onCompactScopeChipActivate}
            selectionChip={selectionChip}
            workPurpose={conversation.workPurpose}
            onWorkPurposeChange={conversation.setWorkPurpose}
            purposeInferenceAvailable={conversation.purposeInferenceAvailable}
            purposeMenuOpen={purposeMenuOpen}
            onPurposeMenuOpenChange={setPurposeMenuOpen}
          />
        </div>
      </div>
    </div>
  )
}
