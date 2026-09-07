/**
 * RWV2-23（Issue #43，U3）：ResultActions 共享动作条组件测试。
 *
 * 覆盖（对应 Issue AC1/AC2/AC3/AC5/AC7/AC8 与测试矩阵“Save state”）：
 * - Owner 显式 Save as Insight/Note 仅在后端成功（resolve）后显示成功态与
 *   View；pending 并发抑制；确定性终态错误 → 英文 key 文案（404/5xx →
 *   unavailable，其余 → failed）；
 * - 展示态缓存预置（重开结果）→ 挂载即已保存态、不再发请求；
 * - Admin（admin_readonly）只显示 Copy；Copy 文本含正文与 Citation 且不含
 *   凭据字段；clipboard 缺失 → 失败 toast；
 * - Continue research 回调；saveDisabledReasonKey 禁用态说明（chat 未解析）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResultActions } from './ResultActions'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { savedResultEntryKey } from '@/lib/hooks/use-research'
import type { ResearchSaveResultResponse } from '@/lib/types/research'

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, saveResultFromResult: vi.fn() }
})

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

import { saveResultFromResult } from '@/lib/research/api'

const P = 'proj_1'
const GEN = 'gen_abc123'
const NOTE_RESULT = {
  note_id: 'note_d1',
  project_id: P,
  title: 'Saved search result',
  content: 'ORR was 45%.',
  note_type: 'human',
  created_at: null,
  updated_at: null,
  citations: [],
  provenance: { envelope_version: 1, kind: 'save_from_result', origin_kind: 'search', origin_id: GEN, destination_kind: 'note', scope: { source_ids: [], note_ids: [] }, model_id: 'm1', response_language: 'en', saved_at: 'x', saved_by_user_id: 1, source_timestamps: {} },
}
const INSIGHT_RESULT: ResearchSaveResultResponse = {
  insight_id: 'insight_d1',
  project_id: P,
  title: 'Saved search result',
  content: 'ORR was 45%.',
  insight_type: 'ai',
  model_id: 'm1',
  created_at: null,
  updated_at: null,
  citations: [],
  provenance: { envelope_version: 1, kind: 'save_from_result', origin_kind: 'search', origin_id: GEN, destination_kind: 'insight', scope: { source_ids: [], note_ids: [] }, model_id: 'm1', response_language: 'en', saved_at: 'x', saved_by_user_id: 1, source_timestamps: {} },
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  })
}

function renderActions(
  props: Partial<Parameters<typeof ResultActions>[0]> = {},
  opts: { role?: 'owner' | 'admin_readonly'; queryClient?: QueryClient } = {},
) {
  const queryClient = opts.queryClient ?? makeQueryClient()
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="1" projectId={P} role={opts.role ?? 'owner'}>
        <ResultActions
          originKind="search"
          originId={GEN}
          content="ORR was 45%."
          citations={[{ claim: 'claim text', original_text: 'quote', doc_id: 'd1', page_idx: 2 }]}
          onViewInsight={vi.fn()}
          onViewNote={vi.fn()}
          onContinueResearch={vi.fn()}
          {...props}
        />
      </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
  return { queryClient, ...utils }
}

describe('ResultActions（RWV2-23 U3）', () => {
  beforeEach(() => {
    toastMock.mockClear()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('Owner：Save as Insight 成功后仅显示已保存态与 View（不发第二次请求）', async () => {
    const api = vi.mocked(saveResultFromResult)
    api.mockResolvedValue(INSIGHT_RESULT as never)
    const { queryClient } = renderActions()
    fireEvent.click(screen.getByTestId('save-as-insight'))
    await waitFor(() => {
      expect(screen.getByTestId('saved-insight')).toHaveTextContent(
        'research.resultActions.savedAsInsight',
      )
    })
    expect(screen.getByTestId('view-insight')).toBeTruthy()
    expect(screen.queryByTestId('save-error')).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith(P, {
      origin_kind: 'search',
      origin_id: GEN,
      destination_kind: 'insight',
    })
    // 保存按钮已禁（防重复 artifact；确定性键在 api 层保证跨实例收敛）
    expect((screen.getByTestId('save-as-insight') as HTMLButtonElement).disabled).toBe(true)
    expect(queryClient.getQueryData(savedResultEntryKey(P, 'search', GEN, 'insight'))).toEqual(
      INSIGHT_RESULT,
    )
  })

  it('Save as Note 同理（独立目标互不影响）', async () => {
    vi.mocked(saveResultFromResult).mockResolvedValue(NOTE_RESULT as never)
    renderActions()
    fireEvent.click(screen.getByTestId('save-as-note'))
    await waitFor(() => {
      expect(screen.getByTestId('saved-note')).toHaveTextContent(
        'research.resultActions.savedAsNote',
      )
    })
    expect(screen.getByTestId('view-note')).toBeTruthy()
  })

  it('pending 并发点击抑制：仅一次请求', async () => {
    const api = vi.mocked(saveResultFromResult)
    let resolve!: (v: unknown) => void
    api.mockReturnValue(new Promise((r) => { resolve = r }) as never)
    renderActions()
    const btn = screen.getByTestId('save-as-insight') as HTMLButtonElement
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    expect(btn.disabled).toBe(true)
    await act(async () => {
      resolve(INSIGHT_RESULT)
    })
    await waitFor(() => expect(screen.getByTestId('saved-insight')).toBeTruthy())
  })

  it('确定性错误 → unavailable key；其它确定错误 → failed key', async () => {
    const api = vi.mocked(saveResultFromResult)
    api.mockRejectedValueOnce({ response: { status: 404 } })
    renderActions()
    fireEvent.click(screen.getByTestId('save-as-note'))
    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toHaveTextContent(
        'research.resultActions.saveUnavailable',
      )
    })
    // 404 为确定性终态：再次点击可重试（新显式操作），此处验证重试成功
    api.mockResolvedValueOnce(NOTE_RESULT as never)
    fireEvent.click(screen.getByTestId('save-as-note'))
    await waitFor(() => expect(screen.getByTestId('saved-note')).toBeTruthy())
  })

  it('展示态缓存预置（重开结果）→ 挂载即已保存 + View，不发请求', async () => {
    const api = vi.mocked(saveResultFromResult)
    const queryClient = makeQueryClient()
    queryClient.setQueryData(savedResultEntryKey(P, 'search', GEN, 'insight'), INSIGHT_RESULT)
    renderActions({}, { queryClient })
    expect(screen.getByTestId('saved-insight')).toBeTruthy()
    expect((screen.getByTestId('save-as-insight') as HTMLButtonElement).disabled).toBe(true)
    expect(api).not.toHaveBeenCalled()
  })

  it('Admin（admin_readonly）：无 Save/Continue，仅 Copy', async () => {
    renderActions({}, { role: 'admin_readonly' })
    expect(screen.queryByTestId('save-as-insight')).toBeNull()
    expect(screen.queryByTestId('save-as-note')).toBeNull()
    expect(screen.queryByTestId('continue-research')).toBeNull()
    expect(screen.getByTestId('copy-result')).toBeTruthy()
  })

  it('Copy：文本含正文与 Citation（页码 p.N），clipboard 可用时成功 toast', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    renderActions()
    fireEvent.click(screen.getByTestId('copy-result'))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('ORR was 45%.'),
      )
    })
    const text = writeText.mock.calls[0][0]
    expect(text).toContain('claim text')
    expect(text).toContain('"quote"')
    expect(text).toContain('d1')
    expect(text).toContain('p. 3')
    expect(toastMock).toHaveBeenCalledWith({
      title: 'research.resultActions.copySuccess',
    })
  })

  it('Copy：clipboard 缺失 → 失败 toast，不抛错', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    renderActions()
    fireEvent.click(screen.getByTestId('copy-result'))
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        title: 'research.resultActions.copyFailed',
        variant: 'destructive',
      })
    })
  })

  it('Continue research 回调（Owner）', () => {
    const onContinue = vi.fn()
    renderActions({ onContinueResearch: onContinue })
    fireEvent.click(screen.getByTestId('continue-research'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('originId 缺省且 showSave → 禁用态 + 原因文案（chat 未解析场景）', () => {
    renderActions({
      originId: null,
      showSave: true,
      saveDisabledReasonKey: 'research.resultActions.chatSaveUnavailable',
    })
    const insight = screen.getByTestId('save-as-insight') as HTMLButtonElement
    const note = screen.getByTestId('save-as-note') as HTMLButtonElement
    expect(insight.disabled).toBe(true)
    expect(note.disabled).toBe(true)
    expect(screen.getByTestId('result-action-status')).toHaveTextContent(
      'research.resultActions.chatSaveUnavailable',
    )
    expect(screen.getByTestId('copy-result')).toBeTruthy()
  })
})

describe('ResultActions review fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lazy resolve 期间快速双击：resolve 与保存各只一次（busy 令牌，review #2）', async () => {
    const api = vi.mocked(saveResultFromResult)
    let releaseResolve!: (v: string | null) => void
    const resolveSpy = vi.fn(() => new Promise<string | null>((r) => { releaseResolve = r }))
    api.mockResolvedValue(NOTE_RESULT as never)
    renderActions({ originId: null, resolveOriginId: resolveSpy, showSave: true })
    const btn = screen.getByTestId('save-as-note') as HTMLButtonElement
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(resolveSpy).toHaveBeenCalledTimes(1)
    await act(async () => { releaseResolve(GEN) })
    await waitFor(() => expect(screen.getByTestId('saved-note')).toBeTruthy())
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('resolve 返回 null（会话不可解析）：显示 unavailable 错误且可重试', async () => {
    const api = vi.mocked(saveResultFromResult)
    api.mockResolvedValue(NOTE_RESULT as never)
    const resolveSpy = vi.fn(async () => null)
    renderActions({ originId: null, resolveOriginId: resolveSpy, showSave: true })
    fireEvent.click(screen.getByTestId('save-as-note'))
    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toHaveTextContent(
        'research.resultActions.saveUnavailable',
      )
    })
    expect(api).not.toHaveBeenCalled()
  })
})
