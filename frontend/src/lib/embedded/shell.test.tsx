import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ResearchWorkspaceShell } from './shell'
import { useResearchWorkspace } from './workspace-context'
import { clearResearchToken, getResearchToken } from './token-store'
import { useResearchScope } from '@/lib/research/scope'
import { useThemeStore } from '@/lib/stores/theme-store'
import { listChatSessions } from '@/lib/research/api'
import { useSessionSnapshot } from '@/lib/hooks/research-session-runtime'
import {
  SESSION_CONTRACT_VERSION,
  type ResearchSessionCapabilities,
} from '@/lib/research/session-contract'
import type { SessionRuntimeTransport } from '@/lib/research/session-runtime'
import {
  SESSION_CACHE_PREFIX,
  clearSessionCacheMemoryFallback,
  writeDraft,
  type SessionDraftRecord,
} from '@/lib/research/session-cache'
import type { ResearchSessionRef } from '@/lib/research/session-contract'

// UI-01 Red：ResearchWorkspaceShell 加载/错误/就绪三态 + ready 握手 +
// 卸载销毁（任务卡 Checklist：bootstrap、session state、销毁无残留）。
// #243 §6.1：就绪态在 WorkspaceProvider 内再包一层全局模型 Provider——
// 本文件被测对象是 shell 生命周期，用测试替身替换该 Provider。

vi.mock('@/lib/hooks/use-research-global-model')

// PR-8 / 6b：shell 的默认生产 transport 会经 `api.ts` 拉真实列表；单测里
// 固定为永不结算以隔离网络，只有显式断言默认接线的用例才读取调用参数。
vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, listChatSessions: vi.fn() }
})

const listChatSessionsMock = vi.mocked(listChatSessions)

const READY_CAPABILITIES: ResearchSessionCapabilities = {
  contract: SESSION_CONTRACT_VERSION,
  editorReady: true,
  submissionReady: { global: true, source: true },
  degraded: false,
  reason: null,
}

const PARENT_ORIGIN = 'https://rdlens.example.com'

interface PostCaptures {
  posted: Array<{ data: Record<string, unknown>; targetOrigin: string }>
}

function stubParentWindow(): PostCaptures {
  const captures: PostCaptures = { posted: [] }
  vi.spyOn(window.parent, 'postMessage').mockImplementation(((data: unknown, targetOrigin: string) => {
    captures.posted.push({ data: data as Record<string, unknown>, targetOrigin })
  }) as Window['postMessage'])
  return captures
}

function dispatchMessage(payload: Record<string, unknown>, origin = PARENT_ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: payload,
      origin,
      source: window.parent as unknown as MessageEventSource,
    }))
  })
}

// UI-02：合法 claims 的 Research Token（契约 v0 §4.1）；session 只对
// 可解码 claims 的 token 进入 authenticated（fail-closed）。
function validToken(claims: Record<string, unknown> = {}): string {
  const payload = {
    sub: 'user_1',
    project_id: 'proj_abc',
    role: 'owner',
    scopes: ['workspace:read', 'notes:write', 'research:run'],
    aud: 'research-workspace',
    iat: 1754460000,
    nbf: 1754460000,
    exp: 1754460300,
    jti: 'j_1',
    ...claims,
  }
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  return `header.${b64}.signature`
}

function validTokenMessage(nonce: string, channel: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: 'research-v0',
    channel,
    type: 'token',
    nonce,
    token: validToken(),
    expires_at: 1754460300,
    ...overrides,
  }
}

function localStorageKeys(): string[] {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key !== null) keys.push(key)
  }
  return keys
}

function ScopeProbe() {
  const { mode } = useResearchScope()
  return <span data-testid="scope-probe">{mode}</span>
}

/** PR-8：读取会话运行时快照，验证 bootstap transport 是否真正接线。 */
function RuntimeProbe() {
  const snapshot = useSessionSnapshot()
  return (
    <span data-testid="runtime-probe">
      {`${snapshot.phase}|${snapshot.capabilities?.contract ?? 'none'}|${
        snapshot.capabilities?.editorReady ? 'editor' : 'no-editor'
      }|${snapshot.viewerUserId ?? 'null'}`}
    </span>
  )
}

describe('ResearchWorkspaceShell', () => {
  beforeEach(() => {
    clearResearchToken()
    vi.stubEnv('NEXT_PUBLIC_RD_PARENT_ORIGIN', PARENT_ORIGIN)
    // 默认生产 transport 的列表请求在单测中永不结算：不触网、不产生
    // Provider 状态回写；需要断言的用例自行改 mock 或注入 transport。
    listChatSessionsMock.mockReset()
    listChatSessionsMock.mockImplementation(() => new Promise<unknown>(() => {}))
  })

  afterEach(() => {
    cleanup()
    clearResearchToken()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('挂载即发送 ready（精确 targetOrigin，携带 schema/channel/nonce）并显示加载态', () => {
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace</ResearchWorkspaceShell>)
    expect(captures.posted).toHaveLength(1)
    expect(captures.posted[0].targetOrigin).toBe(PARENT_ORIGIN)
    expect(captures.posted[0].data.schema).toBe('research-v0')
    expect(captures.posted[0].data.type).toBe('ready')
    expect(String(captures.posted[0].data.nonce)).toMatch(/^n_/)
    expect(String(captures.posted[0].data.channel)).toMatch(/^ch_/)
    expect(screen.getByText('research.loading')).toBeInTheDocument()
  })

  it('收到合法 token 后进入就绪态并渲染工作区内容', () => {
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(screen.getByText('workspace-panels')).toBeInTheDocument()
  })

  it('认证根只挂载一个可用的 Research Scope Provider，初始模式明确为 entire project', () => {
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell><ScopeProbe /></ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(screen.getByTestId('scope-probe')).toHaveTextContent('all')
  })

  it('error 消息显示错误面板（含 code 与本地化文案）', () => {
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage({
      schema: 'research-v0',
      channel: ready.channel,
      type: 'error',
      nonce: ready.nonce,
      code: 'bootstrap_failed',
      message: 'mapping unavailable',
    })
    expect(screen.getByText('research.errorTitle')).toBeInTheDocument()
    expect(screen.getByText(/bootstrap_failed/)).toBeInTheDocument()
    expect(screen.queryByText('workspace-panels')).not.toBeInTheDocument()
  })

  it('logout 后回到加载态且不再渲染工作区', () => {
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(screen.getByText('workspace-panels')).toBeInTheDocument()
    dispatchMessage({ schema: 'research-v0', channel: ready.channel, type: 'logout', nonce: ready.nonce })
    expect(screen.queryByText('workspace-panels')).not.toBeInTheDocument()
    expect(screen.getByText('research.loading')).toBeInTheDocument()
  })

  it('logout 在 Provider 卸载前以 logout 语义 dispose：当前 viewer 本机草稿被清除（review F1/D9）', () => {
    localStorage.clear()
    clearSessionCacheMemoryFallback()
    const globalRef: ResearchSessionRef = {
      domain: 'research',
      kind: 'global',
      projectId: 'proj_abc',
      sessionId: 'sess_1',
      sourceId: null,
    }
    const record: SessionDraftRecord = {
      version: 1,
      text: '待确认草稿',
      token: 'draft_token_a',
      baseScope: null,
      singleSourceId: null,
      noteIds: [],
      localVersion: 3,
      baseRevision: 7,
      savedAt: '2026-10-26T09:00:00.000Z',
      dirty: true,
    }
    writeDraft({ viewerUserId: 'user_1', projectId: 'proj_abc' }, globalRef, 'writer_a', record)
    writeDraft({ viewerUserId: 'user_2', projectId: 'proj_abc' }, globalRef, 'writer_a', record)
    expect(localStorageKeys().some((key) => key.includes('.draft.user_1.'))).toBe(true)

    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(screen.getByText('workspace-panels')).toBeInTheDocument()

    dispatchMessage({ schema: 'research-v0', channel: ready.channel, type: 'logout', nonce: ready.nonce })
    expect(screen.queryByText('workspace-panels')).not.toBeInTheDocument()
    const keys = localStorageKeys()
    // 当前 viewer 的明文草稿在卸载前被同步清理（若是 'unmount' 语义则不会被清）
    expect(keys.some((key) => key.includes('.draft.user_1.'))).toBe(false)
    // 其他 viewer 分区不在本次清理范围
    expect(keys.some((key) => key.includes('.draft.user_2.'))).toBe(true)
    expect(keys.some((key) => key.startsWith(`${SESSION_CACHE_PREFIX}.`))).toBe(true)
  })

  it('同一 viewer 切换项目：重建 runtime 但保留旧项目未同步草稿（review R4）', () => {
    localStorage.clear()
    clearSessionCacheMemoryFallback()
    const dbRef: ResearchSessionRef = {
      domain: 'research',
      kind: 'global',
      projectId: 'proj_abc',
      sessionId: 'sess_1',
      sourceId: null,
    }
    const record: SessionDraftRecord = {
      version: 1,
      text: '旧项目未同步稿',
      token: 'draft_token_a',
      baseScope: null,
      singleSourceId: null,
      noteIds: [],
      localVersion: 3,
      baseRevision: 7,
      savedAt: '2026-10-26T09:00:00.000Z',
      dirty: true,
    }
    function ProjectProbe() {
      const workspace = useResearchWorkspace()
      return <span data-testid="project-probe">{workspace.projectId}</span>
    }
    writeDraft({ viewerUserId: 'user_1', projectId: 'proj_abc' }, dbRef, 'writer_a', record)
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell>
        <ProjectProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(screen.getByTestId('project-probe').textContent).toBe('proj_abc')
    // 同一 sub、不同项目：不得按换人清理旧项目的未同步草稿；Provider 必须按新项目重建
    dispatchMessage(
      validTokenMessage(String(ready.nonce), String(ready.channel), {
        token: validToken({ project_id: 'proj_def' }),
      }),
    )
    expect(screen.getByTestId('project-probe').textContent).toBe('proj_def')
    const keys = localStorageKeys()
    expect(keys.some((key) => key.includes('.draft.user_1.') && key.includes('proj_abc'))).toBe(true)
  })

  it('destroy 消息后清空渲染并终止会话（无残留）', () => {
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    dispatchMessage({ schema: 'research-v0', channel: ready.channel, type: 'destroy', nonce: ready.nonce })
    expect(screen.queryByText('workspace-panels')).not.toBeInTheDocument()
    expect(screen.queryByText('research.loading')).not.toBeInTheDocument()
    // 销毁后合法 token 也不恢复渲染
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(screen.queryByText('workspace-panels')).not.toBeInTheDocument()
  })

  it('伪造消息（错误 origin）不改变加载态', () => {
    stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    dispatchMessage({ schema: 'research-v0', type: 'token', channel: 'ch_x', nonce: 'n_x', token: 'jwt', expires_at: 1 }, 'https://evil.example.com')
    expect(screen.getByText('research.loading')).toBeInTheDocument()
    expect(screen.queryByText('workspace-panels')).not.toBeInTheDocument()
  })

  it('组件卸载时销毁会话：之后的消息不再生效、Token 被清除', () => {
    const captures = stubParentWindow()
    const { unmount } = render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(screen.getByText('workspace-panels')).toBeInTheDocument()
    unmount()
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    expect(document.body.textContent ?? '').not.toContain('workspace-panels')
    expect(getResearchToken()).toBeNull()
  })

  // ── PR-8 / 6b：bootstrap transport 接线（真实接入 P0） ──

  it('PR-8：注入 transport 时 Provider 以认证身份完成 bootstrap 并解除能力门禁', async () => {
    const bootstrap = vi.fn(async () => ({
      status: 'ok' as const,
      viewerUserId: 'user_1',
      capabilities: READY_CAPABILITIES,
    }))
    const transport: SessionRuntimeTransport = { bootstrap }
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell transport={transport}>
        <RuntimeProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))

    await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1))
    expect(bootstrap).toHaveBeenCalledWith({
      authGeneration: 1,
      projectId: 'proj_abc',
      viewerUserId: 'user_1',
      role: 'owner',
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-probe')).toHaveTextContent(
        'ready|research-session-v1|editor|user_1',
      ),
    )
  })

  it('PR-8：默认生产 transport 发起 listChatSessions(kind=all, limit=1)', async () => {
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))

    await waitFor(() =>
      expect(listChatSessionsMock).toHaveBeenCalledWith('proj_abc', {
        kind: 'all',
        limit: 1,
      }),
    )
  })

  it('PR-8：显式 transport=null 不启用生产传输（owner 保持遮蔽/降级能力）', async () => {
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell transport={null}>
        <RuntimeProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-probe')).toHaveTextContent(
        'masked|none|no-editor|user_1',
      ),
    )
    expect(listChatSessionsMock).not.toHaveBeenCalled()
  })

  // ── RWV2-50：父页主题应用（authenticated 后生效；离开即还原独立 fallback）──

  function dataTheme(): string | null {
    return document.documentElement.getAttribute('data-theme')
  }

  function dispatchTheme(ready: Record<string, unknown>, theme: string) {
    dispatchMessage({
      schema: 'research-v0',
      channel: ready.channel,
      type: 'theme',
      nonce: ready.nonce,
      theme,
    })
  }

  it('authenticated 后收到 theme 消息即应用到 document（data-theme/class）', () => {
    // 共享 document 与模块级 store：显式重置起始态，保证用例自洽
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    useThemeStore.setState({ theme: 'light', embeddedTheme: null })
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    dispatchTheme(ready, 'dark')
    expect(dataTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    dispatchTheme(ready, 'light')
    expect(dataTheme()).toBe('light')
  })

  it('未 authenticated 时 theme 消息不应用（fail-closed）', () => {
    // 共享 document：显式清空起始 DOM，断言未认证 theme 不写入任何主题
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    useThemeStore.setState({ theme: 'light', embeddedTheme: null })
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchTheme(ready, 'dark')
    expect(dataTheme()).toBeNull()
  })

  it('logout/destroy 后还原独立主题（override 清空）', () => {
    useThemeStore.setState({ theme: 'dark', embeddedTheme: null })
    const captures = stubParentWindow()
    render(<ResearchWorkspaceShell>workspace-panels</ResearchWorkspaceShell>)
    const ready = captures.posted[0].data
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    dispatchTheme(ready, 'light')
    expect(dataTheme()).toBe('light')
    dispatchMessage({ schema: 'research-v0', channel: ready.channel, type: 'logout', nonce: ready.nonce })
    expect(dataTheme()).toBe('dark')
    dispatchMessage(validTokenMessage(String(ready.nonce), String(ready.channel)))
    dispatchTheme(ready, 'light')
    dispatchMessage({ schema: 'research-v0', channel: ready.channel, type: 'destroy', nonce: ready.nonce })
    expect(dataTheme()).toBe('dark')
    useThemeStore.setState({ theme: 'system', embeddedTheme: null })
  })
})
