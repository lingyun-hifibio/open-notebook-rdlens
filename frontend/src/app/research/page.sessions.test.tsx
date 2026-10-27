import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const workspaceSpies = vi.hoisted(() => ({
  chatSend: vi.fn(),
  chatKeyDown: vi.fn(),
  readingAction: vi.fn(),
  sourceSend: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: () => true,
}))

vi.mock('@/lib/embedded/shell', () => ({
  ResearchWorkspaceShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => true,
  useIsDesktop: () => true,
}))

vi.mock('@/lib/research/project', () => ({
  getResearchProjectId: () => 'proj-1',
}))

vi.mock('@/components/research/ResearchJobsProvider', () => ({
  ResearchJobsProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/research/ResearchHeader', () => ({
  ResearchHeader: ({
    onCitationJump,
    onEditScopeAllStates,
  }: {
    onCitationJump: (sourceId: string, pageIdx: number | null) => void
    onEditScopeAllStates: () => void
  }) => (
    <div data-testid="header">
      <button type="button" data-testid="header-citation" onClick={() => onCitationJump('src-1', 3)} />
      <button type="button" data-testid="header-edit-scope" onClick={() => onEditScopeAllStates()} />
    </div>
  ),
}))

vi.mock('@/components/research/ResearchEgressConsentDialog', () => ({
  ResearchEgressConsentDialog: () => null,
}))

vi.mock('@/components/research/ResearchLayout', () => ({
  ResearchLayout: ({ children }: { children: ReactNode }) => (
    <div data-testid="research-layout">{children}</div>
  ),
}))

vi.mock('@/components/research/ResearchWorkbench', () => ({
  ResearchWorkbench: ({
    focusedSourceId,
    highlightPageIdx,
    onOpenSource,
    onExitSourceFocus,
  }: {
    focusedSourceId: string | null
    highlightPageIdx: number | null
    onOpenSource: (sourceId: string, pageIdx?: number | null) => void
    onExitSourceFocus: () => void
  }) => (
    <div
      data-testid="workbench"
      data-focused-source={focusedSourceId ?? ''}
      data-highlight-page-idx={highlightPageIdx ?? ''}
    >
      <button type="button" data-testid="workbench-open-source" onClick={() => onOpenSource('src-1')} />
      <button
        type="button"
        data-testid="workbench-open-source-2"
        onClick={() => onOpenSource('src-2')}
      />
      <button type="button" data-testid="workbench-back" onClick={() => onExitSourceFocus()} />
    </div>
  ),
}))

vi.mock('@/components/research/ResearchWorkspace', () => ({
  ResearchWorkspace: ({
    surfaceActive,
    activeAction,
    onActiveActionChange,
  }: {
    surfaceActive: boolean
    activeAction: string
    onActiveActionChange: (action: string) => void
  }) => (
    <div
      data-testid="workspace"
      data-surface-active={String(surfaceActive)}
      data-active-action={activeAction}
    >
      <div data-testid="workspace-tabs">
        <button
          type="button"
          data-testid="workspace-tab-chat"
          onClick={() => onActiveActionChange('research-chat')}
        />
        <button
          type="button"
          data-testid="workspace-tab-evidence"
          onClick={() => onActiveActionChange('evidence-search')}
        />
      </div>
      {activeAction === 'research-chat' ? (
        <div role="tabpanel" data-state="active" data-testid="chat-panel">
          <input
            data-testid="chat-input"
            onKeyDown={() => workspaceSpies.chatKeyDown()}
          />
          <button type="button" data-testid="chat-send" onClick={() => workspaceSpies.chatSend()} />
        </div>
      ) : (
        <div role="tabpanel" data-state="active" data-testid="reading-panel">
          <button
            type="button"
            data-testid="reading-action"
            onClick={() => workspaceSpies.readingAction()}
          />
        </div>
      )}
    </div>
  ),
}))

vi.mock('@/components/research/ResearchSourceChatPanel', () => ({
  ResearchSourceChatPanel: ({
    projectId,
    sourceId,
    onHighlightPage,
  }: {
    projectId: string
    sourceId: string
    onHighlightPage: (pageIdx: number) => void
  }) => (
    <div data-testid="source-chat-panel" data-project={projectId} data-source={sourceId}>
      <textarea
        data-testid="srcchat-input"
        onKeyDown={(event) => {
          if (event.key === 'Enter') workspaceSpies.sourceSend()
        }}
      />
      <button type="button" data-testid="srcchat-send" onClick={() => workspaceSpies.sourceSend()} />
      <button type="button" data-testid="panel-cite-page" onClick={() => onHighlightPage(7)} />
    </div>
  ),
}))

const readDisplayPointer = vi.fn()
const readPointer = vi.fn()

vi.mock('@/lib/research/session-cache', () => ({
  readDisplayPointer: (scope: unknown, authority: unknown) => readDisplayPointer(scope, authority),
  readPointer: (...args: unknown[]) => readPointer(...args),
}))

const listChatSessions = vi.fn()
const listSourceChatSessions = vi.fn()
const createChatSession = vi.fn()

vi.mock('@/lib/research/api', () => ({
  listChatSessions: (projectId: string, params: unknown) => listChatSessions(projectId, params),
  listSourceChatSessions: (projectId: string, sourceId: string, params: unknown) =>
    listSourceChatSessions(projectId, sourceId, params),
  createChatSession: (projectId: string, input: unknown) => createChatSession(projectId, input),
}))

const runtimeRef = { current: null as null | FakeRuntime }

vi.mock('@/lib/hooks/research-session-runtime', () => ({
  useResearchSessionRuntimeOptional: () => runtimeRef.current,
  useResearchSessionRuntime: () => runtimeRef.current,
  useSessionSnapshot: () => runtimeRef.current?.getSnapshot() ?? null,
}))

import ResearchPage from './page'
import type { SessionRuntimeSnapshot } from '@/lib/research/session-runtime'

const PROJECT_ID = 'proj-1'
const VIEWER_ID = '7'
const UPDATED_AT = '2026-10-26T10:00:00.000Z'
const CREATED_AT = '2026-10-26T09:00:00.000Z'

const READY_SNAPSHOT: SessionRuntimeSnapshot = {
  phase: 'ready',
  ready: true,
  projectId: PROJECT_ID,
  viewerUserId: VIEWER_ID,
  role: 'owner',
  authGeneration: 1,
  capabilities: {
    contract: 'research-session-v1',
    editorReady: true,
    submissionReady: { global: true, source: true },
    degraded: false,
    reason: null,
  },
  masked: false,
  unauthorized: false,
  disposed: false,
  transportWired: true,
  lastBootstrap: 'ok',
  lastErrorCode: null,
  active: { global: null, source: null },
  viewerChanged: false,
  revision: 1,
}

class FakeRuntime {
  snapshot: SessionRuntimeSnapshot
  listeners = new Set<() => void>()
  activate = vi.fn((surface: 'global' | 'source', ref: unknown) => {
    this.snapshot = {
      ...this.snapshot,
      active: { ...this.snapshot.active, [surface]: ref },
    }
    this.listeners.forEach((listener) => listener())
    return true
  })
  setDisplayPointer = vi.fn()

  /** runtime 的 `active(surface)` 读端口（恢复 effect 的幂等判据）。 */
  active = (surface: 'global' | 'source') => this.snapshot.active[surface]

  constructor(snapshot: Partial<SessionRuntimeSnapshot> = {}) {
    this.snapshot = { ...READY_SNAPSHOT, ...snapshot }
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  identity = () =>
    this.snapshot.role === 'owner'
      ? {
          role: 'owner' as const,
          projectId: this.snapshot.projectId,
          viewerUserId: this.snapshot.viewerUserId ?? VIEWER_ID,
          authGeneration: this.snapshot.authGeneration,
        }
      : {
          role: 'admin_readonly' as const,
          projectId: this.snapshot.projectId,
          authGeneration: this.snapshot.authGeneration,
        }

  cacheScope = () => ({ viewerUserId: VIEWER_ID, projectId: PROJECT_ID })

  cacheAuthority = () => ({
    authenticatedViewerUserId: VIEWER_ID,
    projectId: PROJECT_ID,
    authGeneration: this.snapshot.authGeneration,
    currentAuthGeneration: this.snapshot.authGeneration,
  })

  update(patch: Partial<SessionRuntimeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }
}

function globalWireRef(sessionId: string) {
  return {
    domain: 'research',
    kind: 'global',
    project_id: PROJECT_ID,
    session_id: sessionId,
    source_id: null,
  }
}

function sourceWireRef(sessionId: string, sourceId = 'src-1') {
  return {
    domain: 'research',
    kind: 'source',
    project_id: PROJECT_ID,
    session_id: sessionId,
    source_id: sourceId,
  }
}

function wireSummary(
  sessionId: string,
  options: { kind?: 'global' | 'source'; title?: string } = {},
) {
  return {
    session_ref:
      options.kind === 'source' ? sourceWireRef(sessionId) : globalWireRef(sessionId),
    title: options.title ?? `Session ${sessionId}`,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    record_visibility: 'visible',
    has_draft: null,
  }
}

function wireList(items: unknown[]) {
  return {
    items,
    next_cursor: null,
    viewer_user_id: Number(VIEWER_ID),
    capabilities: {
      sessions: {
        contract: 'research-session-v1',
        editor_ready: true,
        submission_ready: { global: true, source: true },
      },
    },
  }
}

function wireCreateResponse(sessionId: string, kind: 'global' | 'source' = 'global') {
  return {
    session_ref: kind === 'source' ? sourceWireRef(sessionId) : globalWireRef(sessionId),
    editor_revision: 0,
    editor_state: {
      schema_version: 1,
      base_scope:
        kind === 'global'
          ? { mode: 'all', source_ids: [], single_source_id: null }
          : null,
      single_source_id: null,
      note_ids: [],
      draft: { text: '', token: 'tok_1' },
      chat_anchor: null,
      reader_anchor: null,
    },
    state_warnings: [],
    created: true,
    editor_intent_hash: 'a'.repeat(64),
  }
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ResearchPage />
    </QueryClientProvider>,
  )
}

function nav() {
  return screen.getByTestId('research-session-nav')
}

/**
 * 页面层冻结探针：PR-2 门禁通过给 tabpanel / Source surface 直接写
 * `inert`、`aria-hidden` 与 `data-session-chat-*` 来关闭内容。断言时同时
 * 检查自身属性与**祖先链**——回归可能把属性写到父容器上。
 */
function frozenAttrs(element: Element): string[] {
  const found: string[] = []
  let node: Element | null = element
  while (node !== null) {
    for (const name of ['inert', 'aria-hidden', 'data-session-chat-gated', 'data-session-chat-keyboard']) {
      if (node.hasAttribute(name)) {
        const value = node.getAttribute(name)
        found.push(value === null || value === '' ? name : `${name}=${value}`)
      }
    }
    node = node.parentElement
  }
  return found
}

function switcherTrigger(surface: 'global' | 'source') {
  return within(screen.getByTestId(`session-switcher-${surface}`)).getByTestId(
    'session-switcher-trigger',
  )
}

async function openSwitcher(surface: 'global' | 'source') {
  fireEvent.click(switcherTrigger(surface))
  await screen.findByRole('dialog')
}

beforeEach(() => {
  cleanup()
  workspaceSpies.chatSend.mockReset()
  workspaceSpies.chatKeyDown.mockReset()
  workspaceSpies.readingAction.mockReset()
  workspaceSpies.sourceSend.mockReset()
  readDisplayPointer.mockReset().mockReturnValue(null)
  readPointer.mockReset().mockReturnValue(null)
  listChatSessions.mockReset().mockResolvedValue(wireList([]))
  listSourceChatSessions.mockReset().mockResolvedValue({ items: [], total: 0 })
  createChatSession.mockReset()
  runtimeRef.current = new FakeRuntime()
})

describe('ResearchPage 会话导航：空态与指针恢复（§4.5）', () => {
  it('无活动会话：只显示“新对话”入口，source 槽位显示“先打开来源”原因（无半接线）', async () => {
    renderPage()

    await waitFor(() => expect(nav()).toBeInTheDocument())
    expect(nav()).not.toHaveAttribute('data-active-global-session')
    expect(nav()).not.toHaveAttribute('data-active-source-session')
    expect(screen.getByTestId('source-session-unavailable')).toHaveTextContent(
      /Open a source to start a conversation/,
    )
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-surface-active', 'true')
  })

  it('display 有具体 global ref（刷新权威）→ 恢复并激活 runtime active(global)（P0 刷新恢复）', async () => {
    const ref = {
      domain: 'research' as const,
      kind: 'global' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_display',
      sourceId: null,
    }
    readDisplayPointer.mockReturnValue({ version: 1, surface: 'global', ref })

    renderPage()

    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_display'))
    // P0：刷新恢复必须把页面显示权威同步进 runtime.active('global')，否则
    // workspace 无法建 editor/controller，后续导航/清理会把页面 state 抹掉。
    await waitFor(() => expect(runtimeRef.current?.activate).toHaveBeenCalledTimes(1))
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('global', ref)
    expect(runtimeRef.current?.getSnapshot().active.global).toEqual(ref)
    // 恢复仍不得改写 display 指针（显示权威只由显式导航写）。
    expect(runtimeRef.current?.setDisplayPointer).not.toHaveBeenCalled()
  })

  it('display 无内容但 `.global` 指针存在 → 回退该指针并激活 runtime active(global)', async () => {
    const pointerRef = {
      domain: 'research' as const,
      kind: 'global' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_pointer',
      sourceId: null,
    }
    readPointer.mockImplementation((_scope, _authority, surface) =>
      surface === 'global' ? { version: 1, ref: pointerRef, savedAt: 1 } : null,
    )

    renderPage()

    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_pointer'))
    await waitFor(() => expect(runtimeRef.current?.activate).toHaveBeenCalledTimes(1))
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('global', pointerRef)
    expect(runtimeRef.current?.getSnapshot().active.global).toEqual(pointerRef)
    expect(runtimeRef.current?.setDisplayPointer).not.toHaveBeenCalled()
  })

  it('display global 与 `.global` 指针并存 → 只以 display 为准激活一次（优先级不变）', async () => {
    const displayRef = {
      domain: 'research' as const,
      kind: 'global' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_display',
      sourceId: null,
    }
    const pointerRef = {
      domain: 'research' as const,
      kind: 'global' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_pointer',
      sourceId: null,
    }
    readDisplayPointer.mockReturnValue({ version: 1, surface: 'global', ref: displayRef })
    readPointer.mockImplementation((_scope, _authority, surface) =>
      surface === 'global' ? { version: 1, ref: pointerRef, savedAt: 1 } : null,
    )

    renderPage()

    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_display'))
    await waitFor(() => expect(runtimeRef.current?.activate).toHaveBeenCalledTimes(1))
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('global', displayRef)
    expect(runtimeRef.current?.getSnapshot().active.global).toEqual(displayRef)
  })

  it('无 display 也无 `.global` 指针 → 不调用 activate（保持空态）', async () => {
    renderPage()

    await waitFor(() => expect(nav()).toBeInTheDocument())
    expect(nav()).not.toHaveAttribute('data-active-global-session')
    expect(runtimeRef.current?.activate).not.toHaveBeenCalled()
  })

  it('activate 拒绝（校验失败）→ 不清指针、不写 display，保持既有降级语义', async () => {
    const ref = {
      domain: 'research' as const,
      kind: 'global' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_rejected',
      sourceId: null,
    }
    readDisplayPointer.mockReturnValue({ version: 1, surface: 'global', ref })
    runtimeRef.current = new FakeRuntime()
    runtimeRef.current.activate.mockReturnValue(false)

    renderPage()

    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_rejected'))
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('global', ref)
    // 失败时保持现有语义：不清指针（不 activate(null)）、不改写 display。
    expect(runtimeRef.current?.activate).not.toHaveBeenCalledWith('global', null)
    expect(runtimeRef.current?.setDisplayPointer).not.toHaveBeenCalled()
    expect(nav()).not.toHaveAttribute('data-source-new-session')
  })

  it('display `source + null`（F-M3）：进入该来源新会话态，不恢复旧 .source 指针、不清 runtime active', async () => {
    const staleSourceRef = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_stale',
      sourceId: 'src-1',
    }
    readDisplayPointer.mockReturnValue({
      version: 1,
      surface: 'source',
      sourceId: 'src-1',
      ref: null,
    })
    // 旧 `.source` 指针存在（runtime fallback 会误恢复成它）——PR-2 必须不这样做。
    readPointer.mockImplementation((_scope, _authority, surface) =>
      surface === 'source' ? { version: 1, ref: staleSourceRef, savedAt: 1 } : null,
    )

    renderPage()

    await waitFor(() => expect(nav()).toHaveAttribute('data-source-new-session', 'src-1'))
    expect(nav()).not.toHaveAttribute('data-active-source-session')
    expect(runtimeRef.current?.activate).not.toHaveBeenCalled()
    // `.source` 指针读取即使发生，也不得把它恢复成活动会话；不得写 display。
    expect(runtimeRef.current?.setDisplayPointer).not.toHaveBeenCalled()
    expect(screen.getByTestId('workbench')).toHaveAttribute('data-focused-source', 'src-1')
  })

  it('display `source + 具体 ref` → 恢复该来源会话并激活 source surface', async () => {
    const sourceRef = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_src_display',
      sourceId: 'src-2',
    }
    readDisplayPointer.mockReturnValue({
      version: 1,
      surface: 'source',
      sourceId: 'src-2',
      ref: sourceRef,
    })

    renderPage()

    await waitFor(() =>
      expect(nav()).toHaveAttribute('data-active-source-session', 'sess_src_display'),
    )
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('source', sourceRef)
    expect(screen.getByTestId('workbench')).toHaveAttribute('data-focused-source', 'src-2')
  })
})

describe('ResearchPage 会话导航：切换与三指针独立（§4.2-1、§4.4、§4.5）', () => {
  it('全局历史选择：activate(global) 后写 display(global)，source 指针不动', async () => {
    listChatSessions.mockResolvedValue(wireList([wireSummary('sess_a', { title: 'Session A' })]))
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    await openSwitcher('global')
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('session-item'))

    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_a'))
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('global', {
      domain: 'research',
      kind: 'global',
      projectId: PROJECT_ID,
      sessionId: 'sess_a',
      sourceId: null,
    })
    expect(runtimeRef.current?.setDisplayPointer).toHaveBeenCalledWith({
      version: 1,
      surface: 'global',
      ref: expect.objectContaining({ sessionId: 'sess_a', kind: 'global' }),
    })
    // global 切换不进入 source focus。
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-surface-active', 'true')
  })

  it('source 条目：先切 Source focus 再激活 source 会话；global 活动会话保留（跨 kind 导航）', async () => {
    listChatSessions.mockResolvedValue(wireList([wireSummary('sess_g', { title: 'Global G' })]))
    listSourceChatSessions.mockResolvedValue({
      items: [
        {
          session_id: 'sess_src',
          title: null,
          source_id: 'src-1',
          created_at: CREATED_AT,
          updated_at: UPDATED_AT,
        },
      ],
      total: 1,
    })
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    // 先选全局会话。
    await openSwitcher('global')
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('session-item'))
    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_g'))

    // 打开来源 → 出现 source 会话导航。
    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() => expect(screen.getByTestId('session-switcher-source')).toBeInTheDocument())

    await openSwitcher('source')
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('session-item'))

    await waitFor(() => expect(nav()).toHaveAttribute('data-active-source-session', 'sess_src'))
    // 两个 surface 的活动会话同时存在（三指针独立，互不覆盖）。
    expect(nav()).toHaveAttribute('data-active-global-session', 'sess_g')
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-source', 'src-1')
    expect(runtimeRef.current?.setDisplayPointer).toHaveBeenLastCalledWith({
      version: 1,
      surface: 'source',
      sourceId: 'src-1',
      ref: expect.objectContaining({ sessionId: 'sess_src', kind: 'source' }),
    })
  })

  it('返回全局（Back）：只把 display 指向当前 global 活动会话，保留 source 指针/状态', async () => {
    listChatSessions.mockResolvedValue(wireList([wireSummary('sess_g', { title: 'Global G' })]))
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    await openSwitcher('global')
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('session-item'))
    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_g'))

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() => expect(screen.getByTestId('session-switcher-source')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-back'))

    await waitFor(() => expect(nav()).not.toHaveAttribute('data-active-source-session'))
    expect(runtimeRef.current?.setDisplayPointer).toHaveBeenLastCalledWith({
      version: 1,
      surface: 'global',
      ref: expect.objectContaining({ sessionId: 'sess_g', kind: 'global' }),
    })
    expect(screen.getByTestId('workbench')).toHaveAttribute('data-focused-source', '')
  })
})

describe('ResearchPage 会话导航：新对话创建（§4.3）', () => {
  it('新对话创建成功 → 激活为当前会话；不产生旧会话切换', async () => {
    createChatSession.mockResolvedValue(wireCreateResponse('sess_created'))
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(
      within(screen.getByTestId('session-switcher-global')).getByTestId('session-switcher-new'),
    )

    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_created'))
    expect(createChatSession).toHaveBeenCalledTimes(1)
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith(
      'global',
      expect.objectContaining({ sessionId: 'sess_created', kind: 'global' }),
    )
  })

  it('source 新对话：使用当前来源创建并进入该来源活动会话', async () => {
    createChatSession.mockResolvedValue(wireCreateResponse('sess_src_created', 'source'))
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() => expect(screen.getByTestId('session-switcher-source')).toBeInTheDocument())

    fireEvent.click(
      within(screen.getByTestId('session-switcher-source')).getByTestId('session-switcher-new'),
    )

    await waitFor(() =>
      expect(nav()).toHaveAttribute('data-active-source-session', 'sess_src_created'),
    )
    expect(createChatSession).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ kind: 'source', sourceId: 'src-1' }),
    )
  })

  it('创建失败：保留当前全局会话与输入，不切换到不存在会话（不显示空壳）', async () => {
    listChatSessions.mockResolvedValue(wireList([wireSummary('sess_g', { title: 'Global G' })]))
    createChatSession.mockRejectedValue(new Error('network down'))
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    await openSwitcher('global')
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('session-item'))
    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_g'))

    fireEvent.click(
      within(screen.getByTestId('session-switcher-global')).getByTestId('session-switcher-new'),
    )
    await waitFor(() => expect(screen.getByTestId('session-create-error')).toBeInTheDocument())
    expect(nav()).toHaveAttribute('data-active-global-session', 'sess_g')
  })
})

describe('ResearchPage 会话导航：身份切换（S1）', () => {
  it('viewer/authGeneration 变化 → 清页面导航 active state（不渲染上一身份会话标识）', async () => {
    listChatSessions.mockResolvedValue(wireList([wireSummary('sess_g', { title: 'Global G' })]))
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    await openSwitcher('global')
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('session-item'))
    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_g'))

    act(() => {
      runtimeRef.current?.update({
        viewerUserId: '8',
        authGeneration: 2,
        capabilities: READY_SNAPSHOT.capabilities,
      })
    })

    await waitFor(() => expect(nav()).not.toHaveAttribute('data-active-global-session'))
    expect(nav()).not.toHaveAttribute('data-active-source-session')
  })
})

describe('ResearchPage 会话导航：review B6/B7/B8/Major 回归', () => {
  it('项目级历史使用 kind=all（可列出 source 会话）', async () => {
    renderPage()

    await waitFor(() => expect(nav()).toBeInTheDocument())
    await waitFor(() =>
      expect(listChatSessions).toHaveBeenCalledWith(PROJECT_ID, {
        kind: 'all',
        limit: 20,
      }),
    )
  })

  it('普通打开来源：同步该来源 runtime active 与 display（无指针 → source+null）', async () => {
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-open-source'))

    await waitFor(() =>
      expect(runtimeRef.current?.setDisplayPointer).toHaveBeenCalledWith({
        version: 1,
        surface: 'source',
        sourceId: 'src-1',
        ref: null,
      }),
    )
    expect(nav()).toHaveAttribute('data-source-new-session', 'src-1')
    expect(nav()).not.toHaveAttribute('data-active-source-session')
  })

  it('普通打开来源：存在 `.source` 指针 → 恢复并激活该来源会话、display 指向它', async () => {
    const pointerRef = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_source_pointer',
      sourceId: 'src-1',
    }
    readPointer.mockImplementation((_scope, _authority, surface) =>
      surface === 'source' ? { version: 1, ref: pointerRef, savedAt: 1 } : null,
    )
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-open-source'))

    await waitFor(() =>
      expect(nav()).toHaveAttribute('data-active-source-session', 'sess_source_pointer'),
    )
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('source', pointerRef)
    expect(runtimeRef.current?.setDisplayPointer).toHaveBeenCalledWith({
      version: 1,
      surface: 'source',
      sourceId: 'src-1',
      ref: pointerRef,
    })
  })

  it('页面层不再冻结 Chat（PR-9）：tabpanel 及其祖先无 inert/aria-hidden/门禁标记，composer 可聚焦可输入、事件不被页面捕获', async () => {
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    // 导航可用（bootstrap ready + canList）时不得再出现任何“内容未接线”门禁。
    expect(screen.queryByTestId('session-content-gate')).toBeNull()
    expect(screen.getByTestId('reading-panel')).not.toHaveAttribute('inert')

    fireEvent.click(screen.getByTestId('workspace-tab-chat'))
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeInTheDocument())

    const panel = screen.getByTestId('chat-panel')
    // PR-5b 已把 controller/editor/composer 接进面板，PR-2 的半接线门禁必须已移除。
    expect(screen.queryByTestId('session-content-gate')).toBeNull()
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).not.toHaveAttribute('aria-hidden')
    expect(panel).not.toHaveAttribute('data-session-chat-gated')
    expect(panel).not.toHaveAttribute('data-session-chat-keyboard')

    // tabpanel 自身与祖先链都不得带门禁属性（属性写在父容器上同样会冻结）。
    expect(frozenAttrs(panel)).toEqual([])

    // composer：可聚焦、可输入、Enter/点击不被页面 capture 阶段吞掉。
    // 注意：面板在本文件是替身，这里只证明**页面层**不再冻结/拦截。
    const input = screen.getByTestId('chat-input')
    expect(input).not.toHaveAttribute('readonly')
    input.focus()
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'hello' } })
    expect((input as HTMLInputElement).value).toBe('hello')
    const enterEvent = createEvent.keyDown(input, { key: 'Enter' })
    fireEvent(input, enterEvent)
    expect(enterEvent.defaultPrevented).toBe(false)
    expect(workspaceSpies.chatKeyDown).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(workspaceSpies.chatSend).toHaveBeenCalledTimes(1)

    // tabs 与阅读区仍可切换/使用（不阻断导航与阅读链路）。
    fireEvent.click(screen.getByTestId('workspace-tab-evidence'))
    await waitFor(() => expect(screen.getByTestId('reading-panel')).toBeInTheDocument())
    expect(screen.queryByTestId('session-content-gate')).toBeNull()
    fireEvent.click(screen.getByTestId('reading-action'))
    expect(workspaceSpies.readingAction).toHaveBeenCalledTimes(1)
  })

  it('关闭后重开同一来源：重新同步 display，不沿用旧同步标记（R3）', async () => {
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() =>
      expect(runtimeRef.current?.setDisplayPointer).toHaveBeenCalledWith({
        version: 1,
        surface: 'source',
        sourceId: 'src-1',
        ref: null,
      }),
    )
    const firstSourceWrites = runtimeRef.current?.setDisplayPointer.mock.calls.length ?? 0

    fireEvent.click(screen.getByTestId('workbench-back'))
    await waitFor(() =>
      expect(runtimeRef.current?.setDisplayPointer).toHaveBeenLastCalledWith({
        version: 1,
        surface: 'global',
        ref: null,
      }),
    )

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() =>
      expect(runtimeRef.current?.setDisplayPointer.mock.calls.length).toBeGreaterThan(
        firstSourceWrites + 1,
      ),
    )
    expect(runtimeRef.current?.setDisplayPointer).toHaveBeenLastCalledWith({
      version: 1,
      surface: 'source',
      sourceId: 'src-1',
      ref: null,
    })
    expect(nav()).toHaveAttribute('data-source-new-session', 'src-1')
  })

  it('display 恢复 A → 打开 B → 再打开 A：不因残留 guard 跳过同步（R3）', async () => {
    const sourceRef = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_src_a',
      sourceId: 'src-1',
    }
    readDisplayPointer.mockReturnValue({
      version: 1,
      surface: 'source',
      sourceId: 'src-1',
      ref: sourceRef,
    })
    readPointer.mockImplementation((_scope, _authority, surface: string, sourceId: string | null) =>
      surface === 'source' && sourceId === 'src-1'
        ? { version: 1, ref: sourceRef, savedAt: 1 }
        : null,
    )
    renderPage()
    await waitFor(() => expect(nav()).toHaveAttribute('data-active-source-session', 'sess_src_a'))

    fireEvent.click(screen.getByTestId('workbench-open-source-2'))
    await waitFor(() =>
      expect(runtimeRef.current?.setDisplayPointer).toHaveBeenLastCalledWith({
        version: 1,
        surface: 'source',
        sourceId: 'src-2',
        ref: null,
      }),
    )

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() =>
      expect(runtimeRef.current?.setDisplayPointer).toHaveBeenLastCalledWith({
        version: 1,
        surface: 'source',
        sourceId: 'src-1',
        ref: sourceRef,
      }),
    )
    expect(nav()).toHaveAttribute('data-active-source-session', 'sess_src_a')
  })

  it('页面层不再冻结 Source Chat（PR-9）：surface 及祖先无 inert/门禁标记、composer 可输入、Enter/点击不被页面捕获', async () => {
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() => expect(screen.getByTestId('source-chat-surface')).toBeInTheDocument())

    const surface = screen.getByTestId('source-chat-surface')
    expect(surface).not.toHaveAttribute('inert')
    expect(surface).not.toHaveAttribute('data-session-chat-gated')
    expect(screen.queryByTestId('session-content-gate')).toBeNull()

    // surface 自身与祖先链都不得带门禁属性（PR-2 曾在此写 data-session-chat-gated）。
    expect(frozenAttrs(surface)).toEqual([])

    // composer 不再被 readOnly/contenteditable=false 冻结，可聚焦可输入。
    const input = screen.getByTestId('srcchat-input') as HTMLTextAreaElement
    expect(input.readOnly).toBe(false)
    input.focus()
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'hello source' } })
    expect(input.value).toBe('hello source')

    // 点击与 Enter 都到达面板替身（页面不再 capture 阶段阻断）。
    fireEvent.click(screen.getByTestId('srcchat-send'))
    expect(workspaceSpies.sourceSend).toHaveBeenCalledTimes(1)
    const enterEvent = createEvent.keyDown(input, { key: 'Enter' })
    fireEvent(input, enterEvent)
    expect(enterEvent.defaultPrevented).toBe(false)
    expect(workspaceSpies.sourceSend).toHaveBeenCalledTimes(2)

    // 引用跳转仍可用。
    fireEvent.click(screen.getByTestId('panel-cite-page'))
    await waitFor(() =>
      expect(screen.getByTestId('workbench')).toHaveAttribute('data-highlight-page-idx', '7'),
    )
  })

  it('来源→全局历史：切回 global 后 display 不被来源同步 effect 重写（R3 回归）', async () => {
    const sourceRef = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_source',
      sourceId: 'src-1',
    }
    readPointer.mockImplementation((_scope, _authority, surface: string) =>
      surface === 'source' ? { version: 1, ref: sourceRef, savedAt: 1 } : null,
    )
    listChatSessions.mockResolvedValue(wireList([wireSummary('sess_global', { title: 'Global' })]))
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() => expect(nav()).toHaveAttribute('data-active-source-session', 'sess_source'))

    await openSwitcher('global')
    await waitFor(() => expect(screen.getAllByTestId('session-item')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('session-item'))
    await waitFor(() => expect(nav()).toHaveAttribute('data-active-global-session', 'sess_global'))

    // activate('global') 会触发 runtime 通知；不得让来源同步 effect 把 display 再写回 source。
    expect(runtimeRef.current?.setDisplayPointer).toHaveBeenLastCalledWith({
      version: 1,
      surface: 'global',
      ref: expect.objectContaining({ sessionId: 'sess_global' }),
    })
  })

  it('后台 global 404 不覆盖正在显示的 source display（R7）', async () => {
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workbench-open-source'))
    await waitFor(() =>
      expect(runtimeRef.current?.setDisplayPointer).toHaveBeenCalledWith({
        version: 1,
        surface: 'source',
        sourceId: 'src-1',
        ref: null,
      }),
    )

    listChatSessions.mockRejectedValue(
      Object.assign(new Error('gone'), {
        response: { status: 404, data: { detail: { code: 'session_not_found' } } },
      }),
    )
    await openSwitcher('global')
    await waitFor(() => expect(runtimeRef.current?.activate).toHaveBeenCalledWith('global', null))
    expect(runtimeRef.current?.setDisplayPointer).not.toHaveBeenCalledWith({
      version: 1,
      surface: 'global',
      ref: null,
    })
  })

  it('Admin/403 终态：页面导航不渲染“新对话”入口（P0）', async () => {
    listChatSessions.mockRejectedValue(
      Object.assign(new Error('forbidden'), {
        response: { status: 403, data: { detail: { code: 'chat_owner_required' } } },
      }),
    )
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('session-switcher-trigger')).toBeInTheDocument())
    expect(
      within(screen.getByTestId('session-switcher-global')).queryByTestId('session-switcher-new'),
    ).toBeNull()
  })

  it('能力缺失/降级：新导航不可用时不门禁旧兼容阅读入口（P2）', async () => {
    runtimeRef.current = new FakeRuntime({
      capabilities: null,
      lastBootstrap: 'degraded',
    })
    renderPage()
    await waitFor(() => expect(nav()).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('workspace-tab-chat'))
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeInTheDocument())
    const panel = screen.getByTestId('chat-panel')
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).not.toHaveAttribute('data-session-chat-gated')
    // §3.3：能力未就绪时旧兼容阅读入口仍可用（不被 inert 冻结）。
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(workspaceSpies.chatSend).toHaveBeenCalledTimes(1)
  })

  it('列表 404 session_not_found → 清 global 指针与 display，显示空态', async () => {
    const displayRef = {
      domain: 'research' as const,
      kind: 'global' as const,
      projectId: PROJECT_ID,
      sessionId: 'sess_gone',
      sourceId: null,
    }
    readDisplayPointer.mockReturnValue({ version: 1, surface: 'global', ref: displayRef })
    listChatSessions.mockRejectedValue(
      Object.assign(new Error('gone'), {
        response: { status: 404, data: { detail: { code: 'session_not_found' } } },
      }),
    )
    renderPage()

    await waitFor(() => expect(nav()).not.toHaveAttribute('data-active-global-session'))
    expect(runtimeRef.current?.activate).toHaveBeenCalledWith('global', null)
    expect(runtimeRef.current?.setDisplayPointer).toHaveBeenCalledWith({
      version: 1,
      surface: 'global',
      ref: null,
    })
  })
})
