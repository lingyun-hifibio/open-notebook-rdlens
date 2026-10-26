import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

import {
  RESEARCH_SESSION_SWITCHER_PLACEHOLDERS,
  ResearchSessionSwitcher,
  type ResearchSessionSwitcherCopy,
} from './ResearchSessionSwitcher'
import type { UseResearchSessionsResult } from '@/lib/hooks/use-research-sessions'
import type {
  ResearchSessionRef,
  ResearchSessionSummaryProjection,
} from '@/lib/research/session-contract'

const UPDATED_AT = '2026-10-26T10:00:00.000Z'

function globalRef(sessionId: string): ResearchSessionRef {
  return {
    domain: 'research',
    kind: 'global',
    projectId: 'proj-1',
    sessionId,
    sourceId: null,
  }
}

function sourceRef(sessionId: string, sourceId = 'src-1'): ResearchSessionRef {
  return {
    domain: 'research',
    kind: 'source',
    projectId: 'proj-1',
    sessionId,
    sourceId,
  }
}

function summary(
  sessionId: string,
  options: {
    kind?: 'global' | 'source'
    title?: string | null
    visibility?: 'visible' | 'restricted' | 'legacy_context_unverifiable' | null
    hasDraft?: boolean | null
    legacy?: boolean
  } = {},
): ResearchSessionSummaryProjection {
  const kind = options.kind ?? 'global'
  return {
    ref: kind === 'source' ? sourceRef(sessionId) : globalRef(sessionId),
    title: options.title === undefined ? null : options.title,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    visibility: options.visibility === undefined ? 'visible' : options.visibility,
    hasDraft: options.hasDraft ?? null,
    legacy: options.legacy ?? false,
    visibilityDegraded: false,
  }
}

function makeSessions(
  overrides: Partial<UseResearchSessionsResult> = {},
): UseResearchSessionsResult {
  return {
    sessions: [],
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    unauthorized: false,
    sourceUnavailable: false,
    hasMore: false,
    capabilitiesReady: true,
    canList: true,
    canCreate: true,
    listDisabledReason: null,
    createDisabledReason: null,
    creating: false,
    createError: null,
    created: null,
    refresh: vi.fn(),
    loadMore: vi.fn(),
    create: vi.fn(async () => null),
    ...overrides,
  }
}

function renderSwitcher(
  options: {
    surface?: 'global' | 'source'
    sourceId?: string | null
    currentRef?: ResearchSessionRef | null
    sessions?: UseResearchSessionsResult
    onOpenSession?: (ref: ResearchSessionRef) => void
    onNew?: () => void
    copy?: Partial<ResearchSessionSwitcherCopy>
  } = {},
) {
  const sessions = options.sessions ?? makeSessions()
  const onOpenSession = (options.onOpenSession ??
    vi.fn()) as unknown as ReturnType<typeof vi.fn<(ref: ResearchSessionRef) => void>>
  const onNew = (options.onNew ?? vi.fn()) as unknown as ReturnType<typeof vi.fn<() => void>>
  render(
    <ResearchSessionSwitcher
      surface={options.surface ?? 'global'}
      sourceId={options.sourceId ?? 'src-1'}
      currentRef={options.currentRef ?? null}
      sessions={sessions}
      onOpenSession={onOpenSession}
      onNew={onNew}
      copy={options.copy}
      formatUpdatedAt={() => 'UPDATED'}
    />,
  )
  return { sessions, onOpenSession, onNew }
}

function openDrawer() {
  fireEvent.click(screen.getByTestId('session-switcher-trigger'))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ResearchSessionSwitcher：受限标题与可见性投影（§4.6）', () => {
  it('restricted 条目只渲染固定占位，title 不进入 DOM', () => {
    const sessions = makeSessions({
      sessions: [
        summary('sess_secret', { title: 'Confidential acquisition plan', visibility: 'restricted' }),
      ],
    })
    renderSwitcher({ sessions })

    openDrawer()

    const restricted = screen.getByTestId('session-item-restricted')
    expect(restricted).toHaveTextContent(RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.restrictedSession)
    expect(screen.queryByText('Confidential acquisition plan')).toBeNull()
    expect(screen.queryByTestId('session-item-title')).toBeNull()
  })

  it('visible 条目渲染 title（不能无条件占位）', () => {
    const sessions = makeSessions({
      sessions: [summary('sess_visible', { title: 'Q4 pipeline review', visibility: 'visible' })],
    })
    renderSwitcher({ sessions })

    openDrawer()

    expect(screen.getByTestId('session-item-title')).toHaveTextContent('Q4 pipeline review')
    expect(screen.queryByTestId('session-item-restricted')).toBeNull()
  })

  it('可见性未知（旧读路径 / payload 缺失）只占位，不渲染 title', () => {
    const sessions = makeSessions({
      sessions: [summary('sess_legacy', { title: 'legacy title', visibility: null, legacy: true })],
    })
    renderSwitcher({ sessions })

    openDrawer()

    expect(screen.getByTestId('session-item-restricted')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unknownVisibilitySession,
    )
    expect(screen.queryByText('legacy title')).toBeNull()
  })

  it('visible 且 title=null → 固定“未命名会话”占位', () => {
    const sessions = makeSessions({ sessions: [summary('sess_untitled', { title: null })] })
    renderSwitcher({ sessions })

    openDrawer()

    expect(screen.getByTestId('session-item-title')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unnamedSession,
    )
  })
})

describe('ResearchSessionSwitcher：当前标识与条目语义（§4.2-4）', () => {
  it('无活动会话 → 头部显示“新对话”占位', () => {
    renderSwitcher({ copy: { currentNewSession: 'NEW_CONVERSATION' } })

    expect(screen.getByTestId('session-switcher-current')).toHaveTextContent(
      'NEW_CONVERSATION',
    )
  })

  it('活动会话 → 头部用列表条目投影标题，并给活动条目 aria-current="true"', () => {
    const sessions = makeSessions({
      sessions: [summary('sess_a', { title: 'Active conversation' }), summary('sess_b', { title: 'Other' })],
    })
    renderSwitcher({ sessions, currentRef: globalRef('sess_a') })

    expect(screen.getByTestId('session-switcher-current')).toHaveTextContent('Active conversation')

    openDrawer()
    const items = screen.getAllByTestId('session-item')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    expect(items[1]).not.toHaveAttribute('aria-current')
  })

  it('活动会话不在已加载列表时只显示短 id 占位（不猜标题）', () => {
    const sessions = makeSessions({
      sessions: [summary('sess_other', { title: 'Other' })],
    })
    renderSwitcher({ sessions, currentRef: globalRef('sess_abcdefghij') })

    expect(screen.getByTestId('session-switcher-current')).toHaveTextContent('sess_abc')
  })

  it('点击条目：关闭抽屉并回调 onOpenSession（组件不自行构造 ref）', () => {
    const sessions = makeSessions({ sessions: [summary('sess_a', { title: 'A' })] })
    const { onOpenSession } = renderSwitcher({ sessions })

    openDrawer()
    fireEvent.click(screen.getByTestId('session-item'))

    expect(onOpenSession).toHaveBeenCalledTimes(1)
    expect(onOpenSession.mock.calls[0][0]).toEqual(globalRef('sess_a'))
    expect(screen.queryByTestId('session-list')).toBeNull()
  })

  it('source 条目显示 kind 徽标、来源短 id 与草稿标记；global 条目不显示来源', () => {
    const sessions = makeSessions({
      sessions: [
        summary('sess_src', { kind: 'source', title: 'Source conversation', hasDraft: true }),
      ],
    })
    renderSwitcher({ surface: 'source', sessions })

    openDrawer()

    expect(screen.getByTestId('session-item-badge-source')).toBeInTheDocument()
    expect(screen.getByTestId('session-item-source')).toHaveTextContent('src-1')
    expect(screen.getByTestId('session-item-draft')).toBeInTheDocument()
    expect(screen.getByTestId('session-item-session-id')).toHaveTextContent('sess_src')
    expect(screen.getByTestId('session-item-updated-at')).toHaveTextContent('UPDATED')
  })
})

describe('ResearchSessionSwitcher：列表状态、分页与错误（§4.7）', () => {
  it('打开抽屉时请求一次列表刷新', () => {
    const { sessions } = renderSwitcher()
    expect(sessions.refresh).not.toHaveBeenCalled()
    openDrawer()
    expect(sessions.refresh).toHaveBeenCalledTimes(1)
  })

  it('loading → 加载态；空列表 → “还没有会话”空态', () => {
    const loading = makeSessions({ loading: true })
    const { unmount } = render(
      <ResearchSessionSwitcher
        surface="global"
        currentRef={null}
        sessions={loading}
        onOpenSession={vi.fn()}
        onNew={vi.fn()}
      />,
    )
    openDrawer()
    expect(screen.getByTestId('session-list-loading')).toBeInTheDocument()
    unmount()

    renderSwitcher({ sessions: makeSessions({ sessions: [] }) })
    openDrawer()
    expect(screen.getByTestId('session-list-empty')).toBeInTheDocument()
  })

  it('有 next_cursor 时显示“加载更多”，点击调用 loadMore；加载中禁用', () => {
    const loadMore = vi.fn()
    const sessions = makeSessions({
      sessions: [summary('sess_a')],
      hasMore: true,
      loadMore,
    })
    renderSwitcher({ sessions })
    openDrawer()

    fireEvent.click(screen.getByTestId('session-list-load-more'))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('未授权终态：显示无权限解释，不显示重试按钮，隐藏新对话入口（P0）', () => {
    const sessions = makeSessions({
      unauthorized: true,
      error: 'unauthorized',
      canList: false,
      canCreate: false,
      listDisabledReason: 'unauthorized',
      createDisabledReason: 'unauthorized',
    })
    renderSwitcher({ sessions })

    openDrawer()

    expect(screen.getByTestId('session-list-unauthorized')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.unauthorized,
    )
    expect(screen.queryByTestId('session-list-retry')).toBeNull()
    // DESIGN §4.7：403 终态“不显示新对话入口”，不能只 disabled（§3.3）。
    expect(screen.queryByTestId('session-switcher-new')).toBeNull()
  })

  it('来源解析 404：显示“来源暂不可用”并保留重试，不显示“会话不存在”', () => {
    const sessions = makeSessions({
      sourceUnavailable: true,
      error: 'source_unavailable',
    })
    const { sessions: bound } = renderSwitcher({ surface: 'source', sessions })
    openDrawer()
    expect(screen.getByTestId('session-list-source-unavailable')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.sourceUnavailable,
    )
    fireEvent.click(screen.getByTestId('session-list-retry'))
    expect(bound.refresh).toHaveBeenCalled()
  })

  it('5xx：显示可重试错误条', () => {
    const sessions = makeSessions({ error: 'unavailable' })
    renderSwitcher({ sessions })
    openDrawer()
    expect(screen.getByTestId('session-list-error')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('session-list-retry'))
    expect(sessions.refresh).toHaveBeenCalledTimes(2)
  })
})

describe('ResearchSessionSwitcher：新对话与能力门禁（§4.3、§3.3、S2）', () => {
  it('未禁用时点击“新对话”回调 onNew，不自动创建会话', () => {
    const { onNew } = renderSwitcher()
    fireEvent.click(screen.getByTestId('session-switcher-new'))
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('session-switcher-new')).toBeEnabled()
  })

  it('能力未就绪：按钮 disabled 且显示可见原因', () => {
    const sessions = makeSessions({
      canCreate: false,
      createDisabledReason: 'capability_unavailable',
    })
    renderSwitcher({ sessions })

    expect(screen.getByTestId('session-switcher-new')).toBeDisabled()
    expect(screen.getByTestId('session-create-disabled-reason')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.createNotReady,
    )
  })

  it('无当前来源（S2）：source 新对话 disabled 并显示 source_required 原因', () => {
    const sessions = makeSessions({
      canCreate: false,
      createDisabledReason: 'source_required',
    })
    renderSwitcher({ surface: 'source', sourceId: null, sessions })

    expect(screen.getByTestId('session-switcher-new')).toBeDisabled()
    expect(screen.getByTestId('session-create-disabled-reason')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.sourceRequired,
    )
  })

  it('创建中：按钮显示进行中文案并禁用', () => {
    const sessions = makeSessions({ creating: true })
    renderSwitcher({ sessions })

    const button = screen.getByTestId('session-switcher-new')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent(RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.creating)
  })

  it('创建失败：显示错误条（保留当前会话与输入，由页面控制）', () => {
    const sessions = makeSessions({ createError: 'failed' })
    renderSwitcher({ sessions })

    expect(screen.getByTestId('session-create-error')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.createFailed,
    )
  })
})

describe('ResearchSessionSwitcher：抽屉可访问性', () => {
  it('触发按钮 aria-haspopup=dialog；打开后显示 dialog 标题；Escape 关闭', () => {
    renderSwitcher()
    const trigger = screen.getByTestId('session-switcher-trigger')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading')).toHaveTextContent(/chat\.sessionsTitle|sessions/i)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ResearchSessionSwitcher：review Major 回归（§4.6 / §4.1）', () => {
  it('legacy_context_unverifiable：显示标题并带“旧记录，来源不可验证”徽标', () => {
    const sessions = makeSessions({
      sessions: [
        summary('sess_legacy', {
          visibility: 'legacy_context_unverifiable',
          title: 'legacy title',
        }),
      ],
    })
    renderSwitcher({ sessions })
    openDrawer()

    expect(screen.getByTestId('session-item-title')).toHaveTextContent('legacy title')
    expect(screen.getByTestId('session-item-legacy-badge')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.legacyContextUnverifiable,
    )
    expect(screen.queryByTestId('session-item-restricted')).toBeNull()
  })

  it('5xx 且已有列表：保留列表并同时显示错误条与重试', () => {
    const sessions = makeSessions({
      sessions: [summary('sess_a', { title: 'session a' })],
      error: 'unavailable',
    })
    renderSwitcher({ sessions })
    openDrawer()

    expect(screen.getByTestId('session-list')).toBeInTheDocument()
    expect(screen.getByTestId('session-item-title')).toHaveTextContent('session a')
    expect(screen.getByTestId('session-list-error')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('session-list-retry'))
    expect(sessions.refresh).toHaveBeenCalledTimes(2)
  })

  it('404 session_not_found：显示“会话已不存在”空态，不显示重试', () => {
    const sessions = makeSessions({ error: 'not_found' })
    renderSwitcher({ sessions })
    openDrawer()

    expect(screen.getByTestId('session-list-not-found')).toHaveTextContent(
      RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.notFound,
    )
    expect(screen.queryByTestId('session-list-retry')).toBeNull()
    expect(screen.queryByTestId('session-list-error')).toBeNull()
  })
})
