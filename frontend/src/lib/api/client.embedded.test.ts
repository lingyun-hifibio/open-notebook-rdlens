import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from './client'

// UI-01 Red：apiClient 嵌入式适配（设计 §4.1/4.3，REQ-DEP-02/REQ-EMB-02）——
// 嵌入式模式 baseURL 只指向 Research Gateway，Bearer 只取内存 Research
// Token（不读 localStorage），401 不跳转 /login。

vi.mock('@/lib/config', () => ({
  getApiUrl: vi.fn(async () => 'http://fork-backend'),
}))

vi.mock('@/lib/auth-token', () => ({
  getAuthToken: vi.fn(() => 'localstorage-jwt'),
}))

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: vi.fn(),
  getEmbeddedGatewayUrl: vi.fn(() => 'https://gateway.example.com'),
}))

vi.mock('@/lib/embedded/token-store', () => ({
  getResearchToken: vi.fn(() => 'memory-research-token'),
}))

import { getAuthToken } from '@/lib/auth-token'
import { getEmbeddedGatewayUrl, isEmbeddedMode } from '@/lib/embedded/config'

interface Capture {
  baseURL?: string
  headers: Record<string, string>
}

async function capture(configOverrides: Record<string, unknown> = {}): Promise<Capture> {
  let captured: Capture | null = null
  await apiClient.get('/v1/research/projects/p1/notes', {
    ...configOverrides,
    adapter: async (config) => {
      captured = {
        baseURL: config.baseURL as string | undefined,
        headers: (config.headers ?? {}) as Record<string, string>,
      }
      return { data: [], status: 200, statusText: 'OK', headers: {}, config }
    },
  })
  if (!captured) throw new Error('request adapter never ran')
  return captured
}

describe('apiClient 嵌入式适配', () => {
  beforeEach(() => {
    vi.mocked(isEmbeddedMode).mockReturnValue(true)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('嵌入式模式：baseURL 为 Research Gateway，Authorization 取内存 Token', async () => {
    const result = await capture()
    expect(result.baseURL).toBe('https://gateway.example.com')
    expect(result.headers.Authorization).toBe('Bearer memory-research-token')
    expect(getAuthToken).not.toHaveBeenCalled()
  })

  it('嵌入式模式：401 不清除 localStorage 也不跳转 /login', async () => {
    let rejected = false
    await apiClient.get('/v1/research/projects/p1/notes', {
      adapter: async (config) => {
        throw {
          response: { status: 401, data: { detail: 'token expired' }, headers: {}, config },
        }
      },
    }).catch(() => {
      rejected = true
    })
    expect(rejected).toBe(true)
    // 若代码尝试 window.location.href = '/login'，jsdom 会抛导航异常使测试失败
    expect(window.localStorage.getItem('auth-storage')).toBeNull()
    expect(window.location.pathname).toBe('/')
  })

  it('嵌入式模式未配置 Gateway URL 时 fail-closed 拒绝请求（Token 不发往未知基址）', async () => {
    vi.mocked(getEmbeddedGatewayUrl).mockReturnValue('')
    await expect(
      apiClient.get('/v1/research/projects/p1/notes'),
    ).rejects.toThrow('NEXT_PUBLIC_RD_GATEWAY_URL')
    expect(getAuthToken).not.toHaveBeenCalled()
  })

  it('非嵌入式模式：保持上游行为，baseURL 走 config，Authorization 取 localStorage', async () => {
    vi.mocked(isEmbeddedMode).mockReturnValue(false)
    const result = await capture()
    expect(result.baseURL).toBe('http://fork-backend/api')
    expect(result.headers.Authorization).toBe('Bearer localstorage-jwt')
  })
})
