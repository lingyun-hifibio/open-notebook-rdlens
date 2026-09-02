'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { RETRYABLE_SSE_ERROR_CODES } from '@/lib/research/sse'
import type {
  ResearchBackgroundNotice,
  ResearchChatTurn,
  ResearchChatSelection,
} from '@/lib/hooks/use-research-chat'

/**
 * Research Chat 面板（UI-03，REQ-ENG-04/REQ-API-02）。
 *
 * 每条助手消息展示 thinking（可折叠）、answer（Markdown）、citation
 * 列表、usage 与 resolved_mode 徽标；断线自动重连时显示重连徽标；
 * 错误终态展示 code/可重试标记，可重试错误可一键重发（复用当前选择）。
 * 浏览器断开 ≠ 取消——本面板没有「取消 Chat」入口（契约 §9.6）。
 */
export function ResearchChatPanel({
  turns,
  isStreaming,
  onSend,
  selectedSourceIds,
  selectedNoteIds,
  sendDisabled,
  blockedHint,
  backgroundNotice,
}: {
  turns: ResearchChatTurn[]
  isStreaming: boolean
  /**
   * 返回是否已真正派发。Issue #243 §6.4：外部模型需确认时执行被推迟，
   * 调用方据此决定「派发后」的清理（如清空输入），使取消零副作用。
   */
  onSend: (query: string, selection?: ResearchChatSelection) => Promise<boolean>
  selectedSourceIds: string[]
  selectedNoteIds: string[]
  /** #243：无可用全局模型时禁用发送（不变量 2/7 的 Chat 侧表达） */
  sendDisabled?: boolean
  blockedHint?: string | null
  /**
   * Issue #302：刷新恢复后仍在后台/未完成的后台 Generation 提示——静态
   * 如实呈现（绝不渲染为假「进行中」流式态）。
   */
  backgroundNotice?: ResearchBackgroundNotice | null
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const generationBlocked = sendDisabled === true

  const submit = () => {
    const trimmed = query.trim()
    if (!trimmed || generationBlocked) return
    void onSend(trimmed, { sourceIds: selectedSourceIds, noteIds: selectedNoteIds }).then((sent) => {
      if (sent) setQuery('')
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
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

              {turn.status === 'reconnecting' && (
                <p className="text-xs font-medium text-amber-600" data-testid="chat-reconnecting">
                  {t('research.chatReconnecting', { count: turn.reconnectCount })}
                </p>
              )}

              {turn.status === 'error' && (
                <div
                  className="space-y-1 rounded-lg border border-destructive/50 px-3 py-2 text-xs"
                  data-testid="chat-error"
                >
                  <p className="font-medium text-destructive">{turn.errorCode}</p>
                  {turn.errorMessage && (
                    <p className="text-muted-foreground">{turn.errorMessage}</p>
                  )}
                  <div className="flex items-center gap-2">
                    {turn.errorCode && RETRYABLE_SSE_ERROR_CODES.includes(turn.errorCode) && (
                      <>
                        <Badge variant="secondary">{t('research.chatRetryable')}</Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const userTurn = turns[turns.indexOf(turn) - 1]
                            void onSend(userTurn?.content ?? '', {
                              sourceIds: selectedSourceIds,
                              noteIds: selectedNoteIds,
                            })
                          }}
                        >
                          {t('research.chatRetry')}
                        </Button>
                      </>
                    )}
                  </div>
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

      <div className="flex gap-2 border-t p-3">
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
        <Button onClick={submit} disabled={!query.trim() || isStreaming || generationBlocked}>
          {t('research.chatSend')}
        </Button>
      </div>
    </div>
  )
}
