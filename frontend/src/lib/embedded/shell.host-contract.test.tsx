import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ResearchWorkspaceShell } from './shell'
import { useResearchHost } from './host-context'
import { clearResearchToken } from './token-store'
import { listChatSessions } from '@/lib/research/api'

/**
 * W1 宿主契约 v1（#1104）：语言消息 → i18next 立即切换；project.name →
 * 目标壳可消费的宿主上下文（缺失时回退，不伪造）。
 *
 * 使用稳定的 useTranslation 替身以断言 `setLanguage` 调用（全局 setup 的
 * mock 每次返回新 spy，无法跨渲染断言）。
 */

const translateMock = vi.hoisted(() => ({
  t: (key: string) => key,
  setLanguage: vi.fn(async () => 'en-US'),
  i18n: { language: 'en-US' },
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => translateMock,
}))

vi.mock('@/lib/hooks/use-research-global-model')
vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, listChatSessions: vi.fn(() => new Promise<unknown>(() => {})) }
})

const PARENT_ORIGIN = 'https://rdlens.example.com'

function stubParentWindow() {
  const posted: Array<{ data: Record<string, unknown>; targetOrigin: string }> = []
  vi.spyOn(window.parent, 'postMessage').mockImplementation(((data: unknown, targetOrigin: string) => {
    posted.push({ data: data as Record<string, unknown>, targetOrigin })
  }) as Window['postMessage'])
  return { posted }
}

function dispatchMessage(payload: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: payload,
        origin: PARENT_ORIGIN,
        source: window.parent as unknown as MessageEventSource,
      }),
    )
  })
}

function validToken(): string {
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
  }
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  return `header.${b64}.signature`
}

function tokenMessage(
  ready: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'research-v0',
    channel: String(ready.channel),
    type: 'token',
    nonce: String(ready.nonce),
    token: validToken(),
    expires_at: 1754460300,
    ...overrides,
  }
}

function HostProbe() {
  const host = useResearchHost()
  // 本地状态：语言切换后必须保留（不因 changeLanguage 重挂载子树）。
  const [count, setCount] = useState(0)
  return (
    <div>
      <span data-testid="host-language">{host.language ?? 'none'}</span>
      <span data-testid="host-project">{host.projectName ?? 'none'}</span>
      <span data-testid="host-counter">{count}</span>
      <button
        type="button"
        data-testid="host-counter-increment"
        onClick={() => setCount((value) => value + 1)}
      />
    </div>
  )
}

beforeEach(() => {
  cleanup()
  clearResearchToken()
  translateMock.setLanguage.mockClear()
  vi.stubEnv('NEXT_PUBLIC_RD_PARENT_ORIGIN', PARENT_ORIGIN)
  vi.mocked(listChatSessions).mockImplementation(() => new Promise<unknown>(() => {}))
})

afterEach(() => {
  cleanup()
  clearResearchToken()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('ResearchWorkspaceShell · 宿主语言（D-UI-02）', () => {
  it('收到 language 消息 → changeLanguage 立即应用（zh-CN），并保留工作台状态', () => {
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell transport={null}>
        <HostProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    dispatchMessage(tokenMessage(ready))
    expect(screen.getByTestId('host-language')).toHaveTextContent('none')

    // 工作台本地状态（例如既有输入/位置）在切换前存在
    fireEvent.click(screen.getByTestId('host-counter-increment'))
    expect(screen.getByTestId('host-counter')).toHaveTextContent('1')

    dispatchMessage({
      schema: 'research-v0',
      channel: ready.channel,
      type: 'language',
      nonce: ready.nonce,
      language: 'zh-CN',
    })
    expect(translateMock.setLanguage).toHaveBeenCalledWith('zh-CN')
    // 语言切换不重挂载工作台：宿主上下文即时更新，本地状态保留
    expect(screen.getByTestId('host-language')).toHaveTextContent('zh-CN')
    expect(screen.getByTestId('host-counter')).toHaveTextContent('1')
  })

  it('同值 language 消息不重复调用 changeLanguage（宿主重放去重由会话层保证）', () => {
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell transport={null}>
        <HostProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    dispatchMessage(tokenMessage(ready))
    const message = {
      schema: 'research-v0',
      channel: ready.channel,
      type: 'language',
      nonce: ready.nonce,
      language: 'zh-CN',
    }
    dispatchMessage(message)
    expect(translateMock.setLanguage).toHaveBeenCalledTimes(1)
    dispatchMessage(message)
    expect(translateMock.setLanguage).toHaveBeenCalledTimes(1)
  })

  it('未认证时的 language 消息不应用（fail-closed，五要素仍合法）', () => {
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell transport={null}>
        <HostProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    // F22：使用真实 channel/nonce（通过五要素校验），仅跳过 token ——
    // 这样才真正覆盖 "authenticated guard"，而不是被消息校验提前拒绝。
    dispatchMessage({
      schema: 'research-v0',
      channel: ready.channel,
      type: 'language',
      nonce: ready.nonce,
      language: 'zh-CN',
    })
    expect(translateMock.setLanguage).not.toHaveBeenCalled()
    // 未认证时仍渲染加载态（子树的宿主上下文尚未挂载）。
    expect(screen.queryByTestId('host-language')).toBeNull()
  })
})

describe('ResearchWorkspaceShell · 宿主项目名（D-UI-01）', () => {
  it('token 携带 project.name → 目标壳可读取项目身份；重发缺字段保留', () => {
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell transport={null}>
        <HostProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    dispatchMessage(tokenMessage(ready, { project: { name: 'CAR-T 研究' } }))
    expect(screen.getByTestId('host-project')).toHaveTextContent('CAR-T 研究')

    dispatchMessage(tokenMessage(ready))
    // token 重发缺 project 字段：保留已有项目名（刷新不丢名）
    expect(screen.getByTestId('host-project')).toHaveTextContent('CAR-T 研究')
  })

  it('启动时无 project 字段 → null（顶栏回退通用 Research，不伪造）', () => {
    const captures = stubParentWindow()
    render(
      <ResearchWorkspaceShell transport={null}>
        <HostProbe />
      </ResearchWorkspaceShell>,
    )
    const ready = captures.posted[0].data
    dispatchMessage(tokenMessage(ready))
    expect(screen.getByTestId('host-project')).toHaveTextContent('none')
  })
})
