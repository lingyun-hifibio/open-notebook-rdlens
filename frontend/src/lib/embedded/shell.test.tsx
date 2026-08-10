import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { ResearchWorkspaceShell } from './shell'
import { clearResearchToken, getResearchToken } from './token-store'

// UI-01 Red：ResearchWorkspaceShell 加载/错误/就绪三态 + ready 握手 +
// 卸载销毁（任务卡 Checklist：bootstrap、session state、销毁无残留）。

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

describe('ResearchWorkspaceShell', () => {
  beforeEach(() => {
    clearResearchToken()
    vi.stubEnv('NEXT_PUBLIC_RD_PARENT_ORIGIN', PARENT_ORIGIN)
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
})
