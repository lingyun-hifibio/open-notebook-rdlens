import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { EmbeddedRouteGuard } from './EmbeddedRouteGuard'

// UI-02 Red：禁用矩阵导航守卫（REQ-SCOPE-03）——嵌入式模式下非 research
// 路由被重定向回 /research；research 路径不动；非嵌入式模式完全不干预。

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => pathnameMock,
}))

const replaceMock = vi.fn()
let pathnameMock = '/notebooks'

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: vi.fn(() => embeddedMock),
}))

let embeddedMock = true

describe('EmbeddedRouteGuard', () => {
  beforeEach(() => {
    replaceMock.mockClear()
    embeddedMock = true
    pathnameMock = '/notebooks'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('嵌入式模式 + 非 research 路径 → router.replace("/research")', () => {
    render(<EmbeddedRouteGuard />)
    expect(replaceMock).toHaveBeenCalledWith('/research')
  })

  it('嵌入式模式 + /research 路径 → 不重定向', () => {
    pathnameMock = '/research'
    render(<EmbeddedRouteGuard />)
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('非嵌入式模式 → 完全不干预任何路径', () => {
    embeddedMock = false
    pathnameMock = '/settings'
    render(<EmbeddedRouteGuard />)
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
