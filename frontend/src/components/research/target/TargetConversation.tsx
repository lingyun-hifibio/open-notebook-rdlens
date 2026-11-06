'use client'

import { History, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { CoverageSubmitOutcome } from '@/lib/hooks/use-research-chat'
import { ResearchChatPanel } from '../ResearchChatPanel'
import { translateOrFallback } from '@/lib/locales/translate-or-fallback'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { TargetCitationPreview } from './target-types'
import type { TargetConversationState } from './use-target-conversation'
import { TargetComposer } from './TargetComposer'

/**
 * UI-07 中央对话（W1 #1104；UI 规格 v1 §5.4）。
 *
 * - 标题区：上下文 kicker + 对话标题 + 一句说明 + 历史/新对话（位于标题右侧，
 *   §2.4）；历史打开右栏 UI-16，新对话走既有 session 能力；
 * - 消息区：复用 `ResearchChatPanel` 作为**内容面**（加性 props 关闭面板内的
 *   会话标题/范围条/composer/coverage 范围选择器——目标壳不叠加第二套范围
 *   或模型控件）；
 * - composer 固定在中央列底部，不随消息滚走；
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
  compactScopeChip,
  onCompactScopeChipActivate,
  focusComposerToken,
}: {
  conversation: TargetConversationState
  onOpenHistory: (trigger: HTMLElement) => void
  onNewConversation: () => void
  onOpenCitation: (preview: TargetCitationPreview) => void
  /** 当前右栏面板（aria-expanded 与真实状态一致） */
  rightPane: string | null
  onOpenRightPane: (kind: 'conversations', trigger: HTMLElement) => void
  onOpenSearch: () => void
  onOpenCompare: () => void
  searchAvailable: boolean
  compareAvailable: boolean
  compactScopeChip: string | null
  onCompactScopeChipActivate: () => void
  focusComposerToken?: number
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
  const historyAvailable = conversation.sessions !== null && !conversation.sessions.loading
  const createAvailable =
    conversation.sessions !== null &&
    !conversation.sessions.loading &&
    conversation.sessions.canCreate &&
    !conversation.sessions.creating

  // W1：引用点击只打开右栏引用预览（BEH-05 往返/原文阅读属 W2）。
  const handleCitationReturn = (citation: ResearchCitationDisplayItem): void => {
    onOpenCitation({ citation, sourceId: null })
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="rdlens-target-conversation">
      <div
        className="shrink-0 border-b px-7 pb-3 pt-5 max-xl:px-[18px]"
        style={{ borderColor: 'var(--rdlens-line)' }}
        data-testid="rdlens-target-conversation-header"
      >
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
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-[38px] gap-1.5"
              disabled={!historyAvailable}
              title={historyAvailable ? undefined : t('research.target.conversation.sessionUnavailable')}
              aria-describedby={historyAvailable ? undefined : 'rdlens-target-history-reason'}
              aria-expanded={rightPane === 'conversations'}
              aria-controls="rdlens-target-right-pane"
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
              title={createAvailable ? undefined : t('research.target.conversation.newUnavailable')}
              aria-describedby={createAvailable ? undefined : 'rdlens-target-new-reason'}
              onClick={onNewConversation}
              data-testid="rdlens-target-new-conversation"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              <span className="max-xl:hidden">{t('research.target.conversation.newConversation')}</span>
            </Button>
          </div>
        </div>
        {/* 不可用原因的可见说明（不是假控件：按钮 disabled 且原因常显） */}
        {!historyAvailable && (
          <p
            id="rdlens-target-history-reason"
            className="mt-2 text-xs"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-history-unavailable"
          >
            {t('research.target.conversation.sessionUnavailable')}
          </p>
        )}
        {!createAvailable && historyAvailable && (
          <p
            id="rdlens-target-new-reason"
            className="mt-2 text-xs"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-new-unavailable"
          >
            {t('research.target.conversation.newUnavailable')}
          </p>
        )}
      </div>

      {/* 消息内容面：复用既有 ChatPanel；关闭其会话标题/范围条/composer，
          避免重复范围权威与重复标题（目标壳 composer 在中央列底部）。 */}
      <div
        className="min-h-0 flex-1"
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
          showCoverageScopeSelector={false}
          showSessionScopeBar={false}
          showSessionHeader={false}
        />
      </div>

      <div
        className="shrink-0 border-t px-7 pt-3 max-xl:px-[18px]"
        style={{ borderColor: 'var(--rdlens-line)', backgroundColor: 'var(--rdlens-surface-subtle)' }}
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
          onSend={conversation.send}
          onOpenSearch={onOpenSearch}
          onOpenCompare={onOpenCompare}
          searchAvailable={searchAvailable}
          compareAvailable={compareAvailable}
          compactScopeChip={compactScopeChip}
          onCompactScopeChipActivate={onCompactScopeChipActivate}
          focusRequestToken={focusComposerToken}
        />
        </div>
      </div>
    </div>
  )
}
