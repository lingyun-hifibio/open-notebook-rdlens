import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listModels } from '@/lib/research/api'
import { useResearchPurposeCapability } from './use-purpose-capability'

// #120 M3：composer「自动判断」能力位 fail-closed 读取 + 同一 identity query key。
vi.mock('@/lib/research/api', () => ({
  listModels: vi.fn(),
}))

const listModelsMock = vi.mocked(listModels)

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
}

function wrapper(client: QueryClient) {
  function ResearchQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return ResearchQueryWrapper
}

describe('#120 M3：useResearchPurposeCapability', () => {
  beforeEach(() => {
    listModelsMock.mockReset()
  })

  it('capabilities.purpose_inference 严格 true → true（调用携带 projectId）', async () => {
    listModelsMock.mockResolvedValue({ capabilities: { purpose_inference: true } } as never)
    const { result } = renderHook(() => useResearchPurposeCapability('proj_1'), {
      wrapper: wrapper(makeClient()),
    })
    await waitFor(() => expect(result.current).toBe(true))
    expect(listModelsMock).toHaveBeenCalledWith('proj_1')
  })

  it.each([
    ['缺失', {}],
    ['capabilities 缺失', undefined],
    ['false', { purpose_inference: false }],
    ['非布尔 true 字符串', { purpose_inference: 'true' }],
    ['数值 1', { purpose_inference: 1 }],
  ])('purpose_inference %s → false（fail-closed）', async (_label, capabilities) => {
    listModelsMock.mockResolvedValue(
      (capabilities === undefined ? {} : { capabilities }) as never,
    )
    const { result } = renderHook(() => useResearchPurposeCapability('proj_1'), {
      wrapper: wrapper(makeClient()),
    })
    await waitFor(() => expect(listModelsMock).toHaveBeenCalledWith('proj_1'))
    expect(result.current).toBe(false)
  })

  it('同一 project 的两个 hook 共用同一 query key（只请求一次）', async () => {
    listModelsMock.mockResolvedValue({ capabilities: { purpose_inference: true } } as never)
    const client = makeClient()
    const { result } = renderHook(
      () => ({
        first: useResearchPurposeCapability('proj_1'),
        second: useResearchPurposeCapability('proj_1'),
      }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.first).toBe(true))
    expect(result.current.second).toBe(true)
    expect(listModelsMock).toHaveBeenCalledTimes(1)
  })
})
