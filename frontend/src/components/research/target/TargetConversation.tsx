'use client'

import { History, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { CoverageSubmitOutcome } from '@/lib/hooks/use-research-chat'
import { ResearchChatPanel } from '../ResearchChatPanel'
import { translateOrFallback } from '@/lib/locales/translate-or-fallback'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { TargetCitationPreview, TargetRightPaneKind } from './target-types'
import type { TargetConversationState } from './use-target-conversation'
import { TargetComposer } from './TargetComposer'

/** §3.2：中央对话正文列/面板的水平内边距（双侧一致的 clamp）。 */
const CENTER_INLINE_PADDING = 'clamp(28px, 5vw, 84px)'

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
 * - W1 允许「引用点击 → 右栏引用预览」的最小可用行为；W2/W3 能力明确不可用。
 */
export function TargetConversation({
  conversation,
  onOpenHistory,
  onNewConversation,
  onOpenCitation,
  rightPane,
  onOpenRightPane,
  onOpenSearch,
  onOpenCompare,
  searchAvailable,
  compareAvailable,
  secondaryBlockedReason,
  compactScopeChip,
  onCompactScopeChipActivate,
}: {
  conversation: TargetConversationState
  onOpenHistory: (trigger: HTMLElement) => void
  onNewConversation: () => void
  onOpenCitation: (preview: TargetCitationPreview, trigger: HTMLElement | null) => void
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
}) {
  const { t } = useTranslation()
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

  // W1：引用点击只打开右栏引用预览（BEH-05 往返/原文阅读属 W2）。
  const handleCitationReturn = (citation: ResearchCitationDisplayItem): void => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    onOpenCitation(
      { citation, sourceId: null },
      active instanceof HTMLElement ? active : null,
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
        <div style={{ maxWidth: '850px', width: '100%', marginInline: 'auto' }}>
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
          style={{ maxWidth: '850px', width: '100%', marginInline: 'auto' }}
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
          // 目标壳 composer 由 shell 拥有：面板不得把用户输入当作“冷启动
          // 外部草稿”去查回 submissions（真实 harness 缺陷，见 prop 注释）。
          suppressColdStartLookup
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
        <div style={{ maxWidth: '682px', width: '100%', marginInline: 'auto' }}>
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
          />
        </div>
      </div>
    </div>
  )
}
