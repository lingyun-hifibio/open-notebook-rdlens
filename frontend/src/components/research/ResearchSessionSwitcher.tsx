'use client'

/**
 * 研究会话切换器（RDLens #602 第三批 PR-2；DESIGN §4.2、§4.6、§9.2）。
 *
 * 职责（cards/PR-2.md / DESIGN §9.2 组件契约）：
 * - 展示当前会话标识（标题/新对话占位）、历史抽屉、分页“加载更多”、
 *   受限标题占位、基础键盘与 aria 语义；
 * - 组件内**不发请求**：数据与动作来自 `useResearchSessions` 结果与页面回调；
 * - 不自行构造 `session_ref`、不取消任务、不读正文/草稿缓存。
 *
 * 可见性（DESIGN §4.6）：列表投影 `visibility === 'visible'` 才渲染 `title`；
 * `restricted` 只渲染固定占位且 `title` 不进入 DOM；可见性未知（旧读路径/
 * payload 缺失）同样只占位——不允许把“缺失”降级成显示标题，也不允许
 * 无条件占位（visible 条目必须显示标题，测试须能区分两种错误实现）。
 *
 * i18n（Lead 裁决 R6）：`locales/*` 归 PR-6。本组件只复用既有键
 * （`chat.sessionsTitle`/`chat.noSessions`/`pagination.loadMore`/
 * `pagination.loadingMore`/`research.sourceChat.newSession`/`research.loading`/
 * `research.retry`/`research.loadFailed`），缺口文案通过 `copy` props 注入并
 * 在组件内以 exported 常量占位（证据级别 simulated；PR-6 键清单见 PR 正文）。
 */

import { useMemo, useState } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { UseResearchSessionsResult } from '@/lib/hooks/use-research-sessions'
import type { SessionSurface } from '@/lib/research/session-runtime'
import {
  sessionKey,
  sessionRefEquals,
  type ResearchSessionRef,
  type ResearchSessionSummaryProjection,
} from '@/lib/research/session-contract'

/** 未指向任何会话时的当前标识（调用方可用 copy 覆盖为本地化文案）。 */
export const RESEARCH_SESSION_SWITCHER_PLACEHOLDERS = {
  /** 当前会话为空时的“新对话”占位（§4.2-4）。 */
  currentNewSession: 'New conversation',
  /** 受限会话固定占位（§4.6；不得显示派生标题）。 */
  restrictedSession: 'Restricted conversation',
  /** 列表可见性未知时占位（不渲染 title）。 */
  unknownVisibilitySession: 'Conversation',
  /** 列表条目 title 为 null 时的固定占位（§4.6 “未命名会话”）。 */
  unnamedSession: 'Untitled conversation',
  /** 创建能力未就绪（§3.3）。 */
  createNotReady: 'New conversations are not available yet',
  /** 无活动来源时禁用 Source 新对话（S2）。 */
  sourceRequired: 'Open a source to start a conversation',
  /** Admin 只读场景的列表终态（§4.7；服务端 403）。 */
  unauthorized: 'Private conversations are only readable by the project owner',
  /** 旧读路径来源暂时不可解析（§4.1；不显示“会话不存在”）。 */
  sourceUnavailable: 'This source is temporarily unavailable. Your local draft is kept.',
  /** 创建失败（§4.3；保留当前输入，不切换会话）。 */
  createFailed: 'Could not start a new conversation',
  /** 进行中。 */
  creating: 'Starting a conversation…',
} as const

export interface ResearchSessionSwitcherCopy {
  readonly currentNewSession: string
  readonly restrictedSession: string
  readonly unknownVisibilitySession: string
  readonly unnamedSession: string
  readonly createNotReady: string
  readonly sourceRequired: string
  readonly unauthorized: string
  readonly sourceUnavailable: string
  readonly createFailed: string
  readonly creating: string
}

export interface ResearchSessionSwitcherProps {
  /** 当前 surface（`global` 走新协议列表；`source` 走旧读路径身份枚举）。 */
  readonly surface: SessionSurface
  /** surface='source' 时的当前来源。 */
  readonly sourceId?: string | null
  /** 运行时的活动会话（页面级 state；`null` 表示该 surface 无活动会话）。 */
  readonly currentRef: ResearchSessionRef | null
  /** `useResearchSessions` 结果（列表状态 + create 动作）。 */
  readonly sessions: UseResearchSessionsResult
  /** 打开某条历史（页面级导航，§4.2-1：source 条目先切 focus 再激活）。 */
  readonly onOpenSession: (ref: ResearchSessionRef) => void
  /** 显式“新对话”（§4.3：不自动创建、输入区由页面在创建成功后启用）。 */
  readonly onNew: () => void
  /** i18n 缺口文案注入（PR-6 前由页面传入既有键或占位）。 */
  readonly copy?: Partial<ResearchSessionSwitcherCopy>
  /** 时间格式化注入（测试可固定输出；默认使用本地化时间）。 */
  readonly formatUpdatedAt?: (value: string) => string
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
}

function formatLocalizedTime(value: string): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return ''
  return new Date(timestamp).toLocaleString()
}

function itemTitle(
  item: ResearchSessionSummaryProjection,
  copy: ResearchSessionSwitcherCopy,
): { text: string; restricted: boolean } {
  if (item.visibility === 'restricted') {
    return { text: copy.restrictedSession, restricted: true }
  }
  if (item.visibility !== 'visible') {
    // 旧读路径 / payload 缺失：可见性未知，不渲染 title（§4.6）。
    return { text: copy.unknownVisibilitySession, restricted: true }
  }
  return { text: item.title ?? copy.unnamedSession, restricted: false }
}

export function ResearchSessionSwitcher({
  surface,
  sourceId = null,
  currentRef,
  sessions,
  onOpenSession,
  onNew,
  copy: copyOverride,
  formatUpdatedAt = formatLocalizedTime,
}: ResearchSessionSwitcherProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const copy: ResearchSessionSwitcherCopy = useMemo(
    () => ({
      currentNewSession:
        copyOverride?.currentNewSession ??
        t('research.sourceChat.newSession') ??
        RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.currentNewSession,
      restrictedSession:
        copyOverride?.restrictedSession ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.restrictedSession,
      unknownVisibilitySession:
        copyOverride?.unknownVisibilitySession ??
        RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unknownVisibilitySession,
      unnamedSession:
        copyOverride?.unnamedSession ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unnamedSession,
      createNotReady:
        copyOverride?.createNotReady ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.createNotReady,
      sourceRequired:
        copyOverride?.sourceRequired ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.sourceRequired,
      unauthorized:
        copyOverride?.unauthorized ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unauthorized,
      sourceUnavailable:
        copyOverride?.sourceUnavailable ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.sourceUnavailable,
      createFailed:
        copyOverride?.createFailed ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.createFailed,
      creating: copyOverride?.creating ?? RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.creating,
    }),
    [copyOverride, t],
  )

  const currentItem = useMemo(() => {
    if (!currentRef) return null
    const key = sessionKey(currentRef)
    return sessions.sessions.find((item) => sessionKey(item.ref) === key) ?? null
  }, [currentRef, sessions.sessions])

  // 当前标识：无活动会话 → “新对话”占位；有条目 → 按 §4.6 投影；无条目
  // （指针/列表尚未加载）→ 只显示短 id 占位，绝不猜测标题。
  const currentLabel = currentRef
    ? currentItem
      ? itemTitle(currentItem, copy).text
      : shortSessionId(currentRef.sessionId)
    : copy.currentNewSession

  const createDisabled = sessions.createDisabledReason !== null
  const createHint =
    sessions.createDisabledReason === 'source_required'
      ? copy.sourceRequired
      : sessions.createDisabledReason === null
        ? null
        : copy.createNotReady

  const openDrawer = () => {
    setOpen(true)
    sessions.refresh()
  }

  const handleSelect = (ref: ResearchSessionRef) => {
    setOpen(false)
    onOpenSession(ref)
  }

  const handleNew = () => {
    setOpen(false)
    onNew()
  }

  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={`session-switcher-${surface}`}>
      <button
        type="button"
        data-testid="session-switcher-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1 text-sm hover:bg-accent"
        onClick={openDrawer}
      >
        <span className="sr-only">{t('chat.sessionsTitle')}</span>
        <span className="max-w-[16rem] truncate" data-testid="session-switcher-current">
          {currentLabel}
        </span>
      </button>

      <button
        type="button"
        data-testid="session-switcher-new"
        className="shrink-0 rounded-md border border-border/60 bg-background px-2 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        onClick={handleNew}
        disabled={createDisabled || sessions.creating || sessions.unauthorized}
        title={createHint ?? undefined}
        aria-describedby={createHint ? `session-create-hint-${surface}` : undefined}
      >
        {sessions.creating ? copy.creating : t('research.sourceChat.newSession')}
      </button>
      {createHint ? (
        <span
          id={`session-create-hint-${surface}`}
          data-testid="session-create-disabled-reason"
          className="max-w-[16rem] truncate text-xs text-muted-foreground"
        >
          {createHint}
        </span>
      ) : null}
      {sessions.createError ? (
        <span
          role="status"
          data-testid="session-create-error"
          className="max-w-[16rem] truncate text-xs text-destructive"
        >
          {copy.createFailed}
        </span>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[70vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('chat.sessionsTitle')}</DialogTitle>
          </DialogHeader>

          {sessions.unauthorized ? (
            <p data-testid="session-list-unauthorized" className="text-sm text-muted-foreground">
              {copy.unauthorized}
            </p>
          ) : sessions.sourceUnavailable ? (
            <div className="flex flex-col gap-2">
              <p data-testid="session-list-source-unavailable" className="text-sm text-muted-foreground">
                {copy.sourceUnavailable}
              </p>
              <button
                type="button"
                data-testid="session-list-retry"
                className="self-start rounded-md border px-2 py-1 text-sm hover:bg-accent"
                onClick={() => sessions.refresh()}
              >
                {t('research.retry')}
              </button>
            </div>
          ) : sessions.error ? (
            <div className="flex flex-col gap-2">
              <p role="alert" data-testid="session-list-error" className="text-sm text-destructive">
                {t('research.loadFailed')}
              </p>
              <button
                type="button"
                data-testid="session-list-retry"
                className="self-start rounded-md border px-2 py-1 text-sm hover:bg-accent"
                onClick={() => sessions.refresh()}
              >
                {t('research.retry')}
              </button>
            </div>
          ) : sessions.loading ? (
            <p data-testid="session-list-loading" className="text-sm text-muted-foreground">
              {t('research.loading')}
            </p>
          ) : sessions.sessions.length === 0 ? (
            <p data-testid="session-list-empty" className="text-sm text-muted-foreground">
              {t('chat.noSessions')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="session-list" role="list">
              {sessions.sessions.map((item) => {
                const isActive = currentRef !== null && sessionRefEquals(item.ref, currentRef)
                const title = itemTitle(item, copy)
                const updatedAt =
                  typeof item.updatedAt === 'string' && item.updatedAt.length > 0
                    ? formatUpdatedAt(item.updatedAt)
                    : ''
                return (
                  <li key={sessionKey(item.ref)}>
                    <button
                      type="button"
                      data-testid="session-item"
                      data-session-id={item.ref.sessionId}
                      data-kind={item.ref.kind}
                      aria-current={isActive ? 'true' : undefined}
                      className="flex w-full flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left hover:bg-accent data-[active=true]:bg-accent"
                      data-active={isActive ? 'true' : undefined}
                      onClick={() => handleSelect(item.ref)}
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span
                          data-testid={title.restricted ? 'session-item-restricted' : 'session-item-title'}
                          className="truncate text-sm"
                        >
                          {title.text}
                        </span>
                        <span
                          data-testid={`session-item-badge-${item.ref.kind}`}
                          className="shrink-0 rounded border px-1 text-[10px] uppercase text-muted-foreground"
                        >
                          {item.ref.kind}
                        </span>
                        {item.ref.kind === 'source' && item.ref.sourceId ? (
                          <span
                            data-testid="session-item-source"
                            className="shrink-0 truncate text-xs text-muted-foreground"
                          >
                            {shortSessionId(item.ref.sourceId)}
                          </span>
                        ) : null}
                        {item.hasDraft === true ? (
                          <span
                            data-testid="session-item-draft"
                            className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground"
                          >
                            draft
                          </span>
                        ) : null}
                      </span>
                      <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                        <span data-testid="session-item-session-id">{shortSessionId(item.ref.sessionId)}</span>
                        {updatedAt ? (
                          <span data-testid="session-item-updated-at">{updatedAt}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {!sessions.loading && sessions.hasMore && !sessions.error ? (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                data-testid="session-list-load-more"
                className="self-start rounded-md border px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
                onClick={() => sessions.loadMore()}
                disabled={sessions.loadingMore}
              >
                {sessions.loadingMore ? t('pagination.loadingMore') : t('pagination.loadMore')}
              </button>
              {sessions.loadMoreError ? (
                <p role="alert" data-testid="session-list-load-more-error" className="text-xs text-destructive">
                  {t('research.loadFailed')}
                </p>
              ) : null}
            </div>
          ) : null}

          {!sessions.canList ? (
            <p data-testid="session-list-disabled-reason" className="text-xs text-muted-foreground">
              {sessions.listDisabledReason === 'source_required'
                ? copy.sourceRequired
                : copy.createNotReady}
            </p>
          ) : null}

          {surface === 'source' && !sourceId ? (
            <p data-testid="session-list-source-required" className="text-xs text-muted-foreground">
              {copy.sourceRequired}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
