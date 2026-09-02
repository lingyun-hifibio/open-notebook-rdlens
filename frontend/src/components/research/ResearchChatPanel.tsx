'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { COVERAGE_SOURCE_HARD_MAX, CoverageScopeSelector } from './CoverageScopeSelector'
import { CoverageJobDetails } from './CoverageJobDetails'
import { RETRYABLE_SSE_ERROR_CODES } from '@/lib/research/sse'
import type {
  ResearchBackgroundNotice,
  ResearchChatTurn,
  ResearchChatSelection,
} from '@/lib/hooks/use-research-chat'
import type { ResearchCitationDisplayItem, ResearchJob, ResearchSynthesisScope } from '@/lib/research/types'

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
 *   稳定错误码优先展示面向用户的本地化文案，errorMessage 仅作诊断行，
 *   未知 code 原样兜底展示。
 */
const CHAT_ERROR_USER_COPY: Record<string, string> = {
  daily_limit_exceeded: 'research.chatErrorDailyLimitExceeded',
  superseded: 'research.chatErrorSuperseded',
}

export function ResearchChatPanel({
  turns,
  isStreaming,
  onSend,
  onSendCoverage,
  selectedSourceIds,
  selectedNoteIds,
  sendDisabled,
  blockedHint,
  coverageJobs,
  onCoverageRetry,
  onCitationJump,
  backgroundNotice,
}: {
  turns: ResearchChatTurn[]
  isStreaming: boolean
  /**
   * 返回是否已真正派发。Issue #243 §6.4：外部模型需确认时执行被推迟，
   * 调用方据此决定「派发后」的清理（如清空输入），使取消零副作用。
   */
  onSend: (query: string, selection?: ResearchChatSelection) => Promise<boolean>
  /** COV-09：all_selected 提交（返回是否已真正受理） */
  onSendCoverage: (query: string) => Promise<boolean>
  selectedSourceIds: string[]
  selectedNoteIds: string[]
  /** #243：无可用全局模型时禁用发送（不变量 2/7 的 Chat 侧表达） */
  sendDisabled?: boolean
  blockedHint?: string | null
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
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ResearchSynthesisScope>('relevant')
  const generationBlocked = sendDisabled === true
  // 与 CoverageScopeSelector 相同的预检条件（§12.3：1～50 Source 前端预检，
  // Notes 禁用；服务端仍是权威）
  const coverageAllowed =
    selectedNoteIds.length === 0 &&
    selectedSourceIds.length > 0 &&
    selectedSourceIds.length <= COVERAGE_SOURCE_HARD_MAX

  const submit = () => {
    const trimmed = query.trim()
    if (!trimmed || generationBlocked) return
    if (scope === 'all_selected') {
      if (!coverageAllowed) return
      void onSendCoverage(trimmed).then((sent) => {
        if (sent) setQuery('')
      })
      return
    }
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
              {turn.coverageJobId !== null ? (
                <CoverageJobDetails
                  job={coverageJobs?.find((j) => j.job_id === turn.coverageJobId)}
                  onRetry={onCoverageRetry ?? (async () => false)}
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
                  {/* #292 P0：已知稳定码展示本地化用户文案（未知 code 原样
                      兜底）；errorMessage 仅作诊断行，不作主要提示 */}
                  <p className="font-medium text-destructive">
                    {turn.errorCode
                      ? t(CHAT_ERROR_USER_COPY[turn.errorCode] ?? turn.errorCode)
                      : turn.errorCode}
                  </p>
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

      <div className="space-y-2 border-t p-3">
        <CoverageScopeSelector
          value={scope}
          onChange={setScope}
          selectedSourceCount={selectedSourceIds.length}
          selectedNoteCount={selectedNoteIds.length}
        />
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
      </div>
    </div>
  )
}
