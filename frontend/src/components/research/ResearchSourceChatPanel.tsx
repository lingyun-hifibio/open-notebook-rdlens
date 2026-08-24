'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { useResearchSourceChat, type ResearchSourceChatTurn } from '@/lib/hooks/use-research-source-chat'

/**
 * Source-scoped Chat 面板（Issue #182，/research 下半屏选中 Source 时）。
 *
 * 最小会话 UI：「新会话」+ 会话选择（title + updated_at，首页列表）；
 * 消息气泡展示 thinking（折叠）/answer/citation/usage 元数据徽标
 * （resolved_mode、降级原因、source_ref.document_version）；streaming 中
 * 输入禁用；断线重连与两类错误（活动冲突 / Gateway 不可用）状态条。
 *
 * Citation 点击 → `onHighlightPage(page_idx)` 联动上半屏 SourceDetailPanel
 * 高亮对应 chunk/page（0-based 存储仅展示 +1）。浏览器断开 ≠ 取消——
 * 本面板没有「取消 Chat」入口。
 */
export function ResearchSourceChatPanel({
  projectId,
  sourceId,
  onHighlightPage,
}: {
  projectId: string
  sourceId: string
  onHighlightPage: (pageIdx: number) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const chat = useResearchSourceChat({ projectId, sourceId })

  const submit = () => {
    const trimmed = query.trim()
    if (!trimmed || chat.isStreaming) return
    chat.send(trimmed)
    setQuery('')
  }

  const localizedError = (turn: ResearchSourceChatTurn): string | null => {
    if (turn.errorCode === 'conflict_busy') return t('research.sourceChat.conflictBusy')
    if (turn.errorCode === 'gateway_unavailable') return t('research.sourceChat.errorGatewayUnavailable')
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="srcchat-panel">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">{t('research.sourceChat.title')}</h2>
        <Button
          size="sm"
          variant="outline"
          data-testid="srcchat-new-session"
          onClick={() => chat.selectSession(null)}
        >
          {t('research.sourceChat.newSession')}
        </Button>
      </div>

      {chat.loadDetailError && (
        <div className="px-4 py-2 text-xs text-destructive" role="alert">
          {t('research.workbench.loadFailed')}: {chat.loadDetailError}
        </div>
      )}

      {chat.sessions.length > 0 && (
        <ul className="max-h-24 space-y-1 overflow-y-auto border-b px-4 py-2" data-testid="srcchat-sessions">
          {chat.sessions.map((session) => (
            <li key={session.session_id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
                data-testid={`srcchat-session-${session.session_id}`}
                aria-current={session.session_id === chat.activeSessionId}
                onClick={() => chat.selectSession(session.session_id)}
              >
                <span className="font-medium">{session.title ?? session.session_id}</span>
                <span className="ml-2 text-muted-foreground">{session.updated_at}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {chat.turns.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('research.sourceChat.emptyState')}</p>
        )}
        {chat.turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-2 text-sm">
                {turn.content}
              </div>
            </div>
          ) : (
            <div key={turn.id} className="space-y-2">
              {turn.thinking && (
                <details className="rounded-lg border px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                    {t('research.chatThinking')}
                  </summary>
                  <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {turn.thinking}
                  </div>
                </details>
              )}
              <div className="rounded-lg border px-3 py-2 text-sm">
                {turn.content ? (
                  <MarkdownRenderer>{turn.content}</MarkdownRenderer>
                ) : (
                  <span className="text-muted-foreground">{t('research.chatNoAnswer')}</span>
                )}
              </div>

              {(turn.usage || turn.resolvedMode || turn.degradationReasons.length > 0 || turn.sourceRef) && (
                <div
                  className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  data-testid={`srcchat-turn-meta-${turn.id}`}
                >
                  {turn.resolvedMode && (
                    <Badge variant="outline">
                      {t('research.sourceChat.modeLabel')}: {turn.resolvedMode}
                    </Badge>
                  )}
                  {turn.degradationReasons.length > 0 && (
                    <Badge variant="secondary">{t('research.sourceChat.degradedBadge')}</Badge>
                  )}
                  {turn.sourceRef && (
                    <span>
                      {t('research.sourceChat.sourceVersionLabel')}: {turn.sourceRef.documentVersion}
                    </span>
                  )}
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

              <ResearchCitationList
                citations={turn.citations}
                onCitationClick={(citation) => {
                  if (typeof citation.page_idx === 'number') {
                    onHighlightPage(citation.page_idx)
                  }
                }}
              />

              {turn.status === 'reconnecting' && (
                <p className="text-xs font-medium text-amber-600" data-testid="srcchat-reconnecting">
                  {t('research.sourceChat.disconnected', { count: turn.reconnectCount })}
                </p>
              )}

              {turn.status === 'error' && (
                <div
                  className="space-y-1 rounded-lg border border-destructive/50 px-3 py-2 text-xs"
                  data-testid="srcchat-error"
                >
                  <p className="font-medium text-destructive">
                    {localizedError(turn) ?? turn.errorCode}
                  </p>
                  {!localizedError(turn) && turn.errorMessage && (
                    <p className="text-muted-foreground">{turn.errorMessage}</p>
                  )}
                  {chat.retryableQuery !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="srcchat-error-retry"
                      onClick={chat.retry}
                    >
                      {t('research.sourceChat.retry')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ),
        )}
        {chat.isStreaming && (
          <p className="text-xs text-muted-foreground" data-testid="srcchat-streaming">
            {t('research.chatStreaming')}
          </p>
        )}
      </div>

      <div className="flex gap-2 border-t p-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
          disabled={chat.isStreaming}
          placeholder={t('research.sourceChat.placeholder')}
          data-testid="srcchat-input"
        />
        <Button onClick={submit} disabled={!query.trim() || chat.isStreaming} data-testid="srcchat-send">
          {t('research.sourceChat.send')}
        </Button>
      </div>
    </div>
  )
}
