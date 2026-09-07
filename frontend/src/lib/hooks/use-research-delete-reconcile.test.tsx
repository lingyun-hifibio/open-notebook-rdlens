/**
 * RWV2-23（review #4）：删除 Note 后清除对应 saved-result 展示缓存，
 * 避免原结果面残留“已保存/View”指向已删除行。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useDeleteResearchNote, savedResultEntryKey } from './use-research'
import { deleteNote } from '@/lib/research/api'

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, deleteNote: vi.fn() }
})

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const P = 'p1'
const NOTE_ID = 'note_abc'

describe('useDeleteResearchNote saved-result reconcile', () => {
  beforeEach(() => {
    vi.mocked(deleteNote).mockResolvedValue(undefined)
  })
  it('删除成功移除同 note_id 的 saved-result 缓存条目', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    queryClient.setQueryData(
      savedResultEntryKey(P, 'search', 'gen_1', 'note'),
      { note_id: NOTE_ID, project_id: P } as never,
    )
    // 其它 origin/insight 条目不受影响
    queryClient.setQueryData(
      savedResultEntryKey(P, 'chat', 'gen_2', 'insight'),
      { insight_id: 'insight_x' } as never,
    )
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useDeleteResearchNote(P), { wrapper })
    await act(async () => {
      await result.current.mutateAsync(NOTE_ID)
    })
    expect(
      queryClient.getQueryData(savedResultEntryKey(P, 'search', 'gen_1', 'note')),
    ).toBeUndefined()
    expect(
      queryClient.getQueryData(savedResultEntryKey(P, 'chat', 'gen_2', 'insight')),
    ).toBeDefined()
  })
})
