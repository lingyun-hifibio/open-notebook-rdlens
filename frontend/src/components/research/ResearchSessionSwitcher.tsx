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

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import { translateOrFallback } from '@/lib/locales/translate-or-fallback'
import type { UseResearchSessionsResult } from '@/lib/hooks/use-research-sessions'
import type { SessionSurface } from '@/lib/research/session-runtime'
import {
  sessionKey,
  sessionRefEquals,
  type ResearchSessionRef,
  type ResearchSessionSummaryProjection,
} from '@/lib/research/session-contract'

/**
 * en-US 兜底文案（PR-6：i18n 键已在 14 locale 登记；真实 i18n 返回译文，
 * 未初始化/缺键时回退到这里的英文，保证既有 PR-2 断言口径不变）。
 * 调用方仍可用 `copy` 覆盖本地化文案。
 */
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
  /** has_draft 徽标（§4.2-1；PR-6 键）。 */
  draft: 'Draft',
  /** 旧记录：来源不可验证（§4.6；允许显示标题 + 徽标）。 */
  legacyContextUnverifiable: 'Legacy record — source cannot be verified',
  /** 会话已不存在（404 `session_not_found`；§4.1 清指针 + 空态）。 */
  notFound: 'This conversation no longer exists',
  /** 新导航可用但会话内容尚未接线（PR-2 半接线隔离；PR-4/5a 后移除）。 */
  contentNotReady:
    'Session content is not wired yet (PR-5a). Legacy chat panels are disabled while session navigation is active.',
} as const

/** §8.1 抽屉键盘说明（sr-only；真实 i18n 时由 `research.a11y.keyboardHint` 提供）。 */
const KEYBOARD_HINT_FALLBACK =
  'Use the Up and Down arrow keys to move between conversations. Home and End jump to the first or last conversation. Press Enter to open the focused conversation. Press Escape to close.'

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
  readonly draft: string
  readonly legacyContextUnverifiable: string
  readonly notFound: string
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
  if (item.visibility === 'legacy_context_unverifiable') {
    // 旧记录：允许显示标题 + “来源不可验证”徽标（§4.6），不得当作受限隐藏。
    return { text: item.title ?? copy.unnamedSession, restricted: false }
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
        translateOrFallback(
          t,
          'research.session.newConversation',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.currentNewSession,
        ),
      restrictedSession:
        copyOverride?.restrictedSession ??
        translateOrFallback(
          t,
          'research.session.restrictedConversation',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.restrictedSession,
        ),
      unknownVisibilitySession:
        copyOverride?.unknownVisibilitySession ??
        translateOrFallback(
          t,
          'research.session.unknownVisibility',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unknownVisibilitySession,
        ),
      unnamedSession:
        copyOverride?.unnamedSession ??
        translateOrFallback(
          t,
          'research.session.unnamed',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unnamedSession,
        ),
      createNotReady:
        copyOverride?.createNotReady ??
        translateOrFallback(
          t,
          'research.session.createNotReady',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.createNotReady,
        ),
      sourceRequired:
        copyOverride?.sourceRequired ??
        translateOrFallback(
          t,
          'research.session.sourceRequired',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.sourceRequired,
        ),
      unauthorized:
        copyOverride?.unauthorized ??
        translateOrFallback(
          t,
          'research.session.unauthorized',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unauthorized,
        ),
      sourceUnavailable:
        copyOverride?.sourceUnavailable ??
        translateOrFallback(
          t,
          'research.session.sourceUnavailable',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.sourceUnavailable,
        ),
      createFailed:
        copyOverride?.createFailed ??
        translateOrFallback(
          t,
          'research.session.createFailed',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.createFailed,
        ),
      creating:
        copyOverride?.creating ??
        translateOrFallback(
          t,
          'research.session.creating',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.creating,
        ),
      draft:
        copyOverride?.draft ??
        translateOrFallback(
          t,
          'research.session.draft',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.draft,
        ),
      legacyContextUnverifiable:
        copyOverride?.legacyContextUnverifiable ??
        translateOrFallback(
          t,
          'research.session.visibility.legacyBadge',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.legacyContextUnverifiable,
        ),
      notFound:
        copyOverride?.notFound ??
        translateOrFallback(
          t,
          'research.session.notFound',
          RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.notFound,
        ),
    }),
    [copyOverride, t],
  )

  // 键盘/可达性文案（DESIGN §8.1、§8.5）。
  const labels = useMemo(
    () => ({
      currentSession: translateOrFallback(t, 'research.a11y.currentSession', 'Current conversation'),
      sessionList: translateOrFallback(t, 'research.a11y.sessionList', 'Conversation list'),
      newConversation: translateOrFallback(
        t,
        'research.a11y.newConversation',
        'Start a new conversation',
      ),
      loadMoreSessions: translateOrFallback(
        t,
        'research.a11y.loadMoreSessions',
        'Load more conversations',
      ),
      keyboardHint: translateOrFallback(t, 'research.a11y.keyboardHint', KEYBOARD_HINT_FALLBACK),
    }),
    [t],
  )

  const drawerId = `research-session-drawer-${surface}`

  // roving tabindex（§8.1）：列表内只有当前条目可 Tab 进入；方向键/Home/End
  // 在条目间移动焦点，Enter/Space 由原生 button 激活。
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // 选择会话/新建对话触发的关闭不把焦点拉回触发按钮（§8.1：激活后焦点去
  // 输入框或面板标题，由面板在 sessionRef 变化时接管）。
  const activatedRef = useRef(false)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [activeItemIndex, setActiveItemIndex] = useState(0)
  const itemCount = sessions.sessions.length

  useEffect(() => {
    itemRefs.current.length = itemCount
  }, [itemCount])

  useEffect(() => {
    if (!open) return
    const currentIndex = currentRef
      ? sessions.sessions.findIndex((item) => sessionRefEquals(item.ref, currentRef))
      : -1
    const nextIndex = currentIndex >= 0 ? currentIndex : 0
    setActiveItemIndex(nextIndex)
    // 打开后焦点进入抽屉并落在当前/首条（§8.1）；列表刷新不重复抢焦点。
    const timer = window.setTimeout(() => {
      itemRefs.current[nextIndex]?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
    // 仅在打开时定位一次（sessions/currentRef 不参与依赖，避免刷新抢焦点）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    setActiveItemIndex((prev) => {
      if (itemCount === 0) return 0
      return Math.min(prev, itemCount - 1)
    })
  }, [itemCount])

  const moveItemFocus = (next: number): void => {
    if (itemCount === 0) return
    const clamped = Math.max(0, Math.min(next, itemCount - 1))
    setActiveItemIndex(clamped)
    itemRefs.current[clamped]?.focus()
  }

  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (itemCount === 0) return
    const focusedIndex = itemRefs.current.findIndex((element) => element === document.activeElement)
    const base = focusedIndex >= 0 ? focusedIndex : activeItemIndex
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveItemFocus(focusedIndex >= 0 ? (base + 1) % itemCount : 0)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveItemFocus(focusedIndex >= 0 ? (base - 1 + itemCount) % itemCount : itemCount - 1)
        break
      case 'Home':
        event.preventDefault()
        moveItemFocus(0)
        break
      case 'End':
        event.preventDefault()
        moveItemFocus(itemCount - 1)
        break
      default:
        break
    }
  }

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
    activatedRef.current = true
    setOpen(false)
    onOpenSession(ref)
  }

  const handleNew = () => {
    // 只有“从抽屉里新建”才把关闭焦点交接给面板；顶栏按钮不关闭抽屉，
    // 不得留下未消费的激活标记（否则下一次 Escape 会跳过回焦）。
    const fromDrawer = open
    if (fromDrawer) {
      activatedRef.current = true
    }
    setOpen(false)
    onNew()
  }

  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={`session-switcher-${surface}`}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="session-switcher-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={drawerId}
        aria-label={`${labels.currentSession}: ${currentLabel}`}
        title={currentLabel}
        className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1 text-sm hover:bg-accent"
        onClick={openDrawer}
      >
        <span className="sr-only">{t('chat.sessionsTitle')}</span>
        <span className="max-w-[16rem] truncate" data-testid="session-switcher-current">
          {currentLabel}
        </span>
      </button>

      {/* 403 `chat_owner_required` 终态：DESIGN §4.7 要求“不显示新对话入口”
          （不能只靠 disabled 属性；§3.3 每个禁用原因必须有可见文案）。
          终态下入口直接隐藏，抽屉内只剩无权限原因。 */}
      {sessions.unauthorized ? null : (
        <>
          <button
            type="button"
            data-testid="session-switcher-new"
            className="shrink-0 rounded-md border border-border/60 bg-background px-2 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleNew}
            disabled={createDisabled || sessions.creating}
            aria-busy={sessions.creating || undefined}
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
        </>
      )}
      {sessions.createError ? (
        <span
          role="alert"
          data-testid="session-create-error"
          className="max-w-[16rem] truncate text-xs text-destructive"
        >
          {copy.createFailed}
        </span>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          id={drawerId}
          className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-md"
          onCloseAutoFocus={(event) => {
            // 受控 open（未用 Radix DialogTrigger）时 Radix 不会自动回焦。
            // 普通关闭（Escape/关闭按钮）→ §8.1 焦点回到触发按钮；
            // 激活会话/新建对话 → 焦点交给面板（输入框或面板标题）。
            // 兜底必须在**实际卸载**（本回调）后才排 timer：退出动画期间
            // activeElement 可能仍在条目上，过早检查会漏掉“最终落 body”。
            event.preventDefault()
            if (activatedRef.current) {
              activatedRef.current = false
              if (typeof window === 'undefined') return
              window.setTimeout(() => {
                if (typeof document === 'undefined') return
                const active = document.activeElement
                if (active === null || active === document.body) {
                  triggerRef.current?.focus()
                }
              }, 0)
              return
            }
            triggerRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('chat.sessionsTitle')}</DialogTitle>
          </DialogHeader>
          <p id={`${drawerId}-hint`} className="sr-only">
            {labels.keyboardHint}
          </p>

          {!sessions.unauthorized ? (
            <button
              type="button"
              data-testid="session-list-new"
              className="shrink-0 self-start rounded-md border px-2 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleNew}
              disabled={createDisabled || sessions.creating}
              aria-busy={sessions.creating || undefined}
              aria-label={labels.newConversation}
            >
              {sessions.creating ? copy.creating : copy.currentNewSession}
            </button>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="session-list-scroll">
          {sessions.unauthorized ? (
            <p data-testid="session-list-unauthorized" className="text-sm text-muted-foreground">
              {copy.unauthorized}
            </p>
          ) : (
            <>
              {sessions.sourceUnavailable ? (
                <div className="mb-2 flex flex-col gap-2">
                  <p
                    data-testid="session-list-source-unavailable"
                    className="text-sm text-muted-foreground"
                  >
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
              ) : null}

              {sessions.error === 'not_found' ? (
                <p data-testid="session-list-not-found" className="text-sm text-muted-foreground">
                  {copy.notFound}
                </p>
              ) : sessions.loading && sessions.sessions.length === 0 ? (
                <p data-testid="session-list-loading" className="text-sm text-muted-foreground">
                  {t('research.loading')}
                </p>
              ) : sessions.sessions.length === 0 ? (
                sessions.error && sessions.error !== 'source_unavailable' ? (
                  <div className="flex flex-col gap-2">
                    <p
                      role="alert"
                      data-testid="session-list-error"
                      className="text-sm text-destructive"
                    >
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
                ) : (
                  <p data-testid="session-list-empty" className="text-sm text-muted-foreground">
                    {t('chat.noSessions')}
                  </p>
                )
              ) : (
                <>
                  {sessions.error ? (
                    <div
                      role="alert"
                      data-testid="session-list-error"
                      className="mb-2 flex items-center justify-between gap-2"
                    >
                      <span className="text-sm text-destructive">{t('research.loadFailed')}</span>
                      <button
                        type="button"
                        data-testid="session-list-retry"
                        className="shrink-0 rounded-md border px-2 py-1 text-sm hover:bg-accent"
                        onClick={() => sessions.refresh()}
                      >
                        {t('research.retry')}
                      </button>
                    </div>
                  ) : null}
                  <ul
                    className="flex flex-col gap-1"
                    data-testid="session-list"
                    role="list"
                    aria-label={labels.sessionList}
                    aria-describedby={`${drawerId}-hint`}
                    onKeyDown={handleListKeyDown}
                  >
                    {sessions.sessions.map((item, index) => {
                      const isActive = currentRef !== null && sessionRefEquals(item.ref, currentRef)
                      const title = itemTitle(item, copy)
                      const itemAriaLabel = translateOrFallback(
                        t,
                        'research.a11y.sessionItem',
                        'Open conversation {{name}}',
                        { name: title.text },
                      )
                      const updatedAt =
                        typeof item.updatedAt === 'string' && item.updatedAt.length > 0
                          ? formatUpdatedAt(item.updatedAt)
                          : ''
                      return (
                        <li key={sessionKey(item.ref)}>
                          <button
                            type="button"
                            ref={(element) => {
                              itemRefs.current[index] = element
                            }}
                            data-testid="session-item"
                            data-session-id={item.ref.sessionId}
                            data-kind={item.ref.kind}
                            tabIndex={index === activeItemIndex ? 0 : -1}
                            aria-label={itemAriaLabel}
                            title={title.text}
                            aria-current={isActive ? 'true' : undefined}
                            className="flex w-full flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left hover:bg-accent data-[active=true]:bg-accent"
                            data-active={isActive ? 'true' : undefined}
                            onClick={() => handleSelect(item.ref)}
                          >
                            <span className="flex w-full min-w-0 items-center gap-2">
                              <span
                                data-testid={
                                  title.restricted ? 'session-item-restricted' : 'session-item-title'
                                }
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
                              {item.visibility === 'legacy_context_unverifiable' ? (
                                <span
                                  data-testid="session-item-legacy-badge"
                                  className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground"
                                >
                                  {copy.legacyContextUnverifiable}
                                </span>
                              ) : null}
                              {item.hasDraft === true ? (
                                <span
                                  data-testid="session-item-draft"
                                  className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground"
                                >
                                  {copy.draft}
                                </span>
                              ) : null}
                            </span>
                            <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                              <span data-testid="session-item-session-id">
                                {shortSessionId(item.ref.sessionId)}
                              </span>
                              {updatedAt ? (
                                <span data-testid="session-item-updated-at">{updatedAt}</span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </>
          )}

          </div>

          {!sessions.loading && sessions.hasMore && !sessions.error ? (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                data-testid="session-list-load-more"
                aria-label={labels.loadMoreSessions}
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
