import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ResearchScopeProvider,
  formatScopeLabel,
  normalizePersistedScope,
  scopeStorageKey,
  useResearchScope,
} from './scope'

/**
 * PR5（D-04）T5 / T17 / T39：三档范围模型的**行为**断言。
 *
 * 为什么单列一个文件：`scope.test.tsx` 覆盖的是持久化恢复与 reconcile，
 * 而 `single`（临时单篇限定）的会话归属语义此前**一行测试都没有**——
 * 它却是 D-04 的核心（v3 审查 Critical ①、round-2 H5）。本文件把它钉住：
 * - T5  限定语义：同会话连续两轮生效、取消/改选清除、提交不清除；
 * - T17 限定归属：无存储会话身份丢弃、同会话激活、异会话清除并恢复基础范围；
 * - T39 旧持久快照（`entire_project`）经 normalizePersistedScope 归一为
 *       `all`，不可识别值丢弃而**不落 selected**。
 */

const projectId = 'proj_1'
const userId = 'user_1'

/** 与 scope.tsx 的 SINGLE_STORAGE_PREFIX 同形（该前缀未导出，测试钉住格式） */
function singleStorageKey(user: string, project: string): string {
  return `rdlens.research.scope.single.v1/${encodeURIComponent(user)}/${encodeURIComponent(project)}`
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ResearchScopeProvider projectId={projectId} userId={userId}>
      {children}
    </ResearchScopeProvider>
  )
}

const t = (key: string, opts?: Record<string, unknown>): string => {
  if (key === 'research.scopeSummary.entireProject') return 'Entire project'
  if (key === 'research.scopeSummary.singleSource') return `This source only: ${String(opts?.name)}`
  if (key === 'research.scopeSummary.sourceOne') return '1 source'
  if (key === 'research.layout.scope.selected') return 'Selected sources and notes'
  return key
}

describe('ResearchScopeProvider · single 限定（T5 / T17）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  // ── T5：限定语义 ──
  it('T5：同会话连续两轮派发都携带 single（提交本身不清除限定）', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.setSingle('src_9', 'sess_1')
    })

    const first = result.current.getSnapshot()
    expect(first.mode).toBe('single')
    expect(first.singleSourceId).toBe('src_9')

    // 第二轮派发（再次读取快照）——限定必须仍在
    const second = result.current.getSnapshot()
    expect(second.mode).toBe('single')
    expect(second.singleSourceId).toBe('src_9')
    expect(result.current.mode).toBe('single')
  })

  it('T5：取消限定 → 恢复到基础范围（all）', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.setSingle('src_9', 'sess_1')
    })
    expect(result.current.getSnapshot().mode).toBe('single')

    act(() => {
      result.current.clearSingle()
    })
    const restored = result.current.getSnapshot()
    expect(restored.mode).toBe('all')
    expect(restored.singleSourceId).toBeNull()
  })

  it('T5：selected 基础范围下取消限定 → 恢复 selected（不丢选择）', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.toggleSource('src_1')
    })
    act(() => {
      result.current.setSingle('src_9', 'sess_1')
    })
    expect(result.current.getSnapshot().mode).toBe('single')

    act(() => {
      result.current.clearSingle()
    })
    const restored = result.current.getSnapshot()
    expect(restored.mode).toBe('selected')
    expect(restored.sourceIds).toEqual(['src_1'])
  })

  it('T5：改选资料（显式范围操作）→ 清除限定', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.setSingle('src_9', 'sess_1')
    })
    act(() => {
      result.current.toggleSource('src_1')
    })

    const snapshot = result.current.getSnapshot()
    expect(snapshot.mode).toBe('selected')
    expect(snapshot.singleSourceId).toBeNull()
    expect(result.current.singlePin).toBeNull()
  })

  it('T5：显式切档（setMode）→ 清除限定', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.toggleSource('src_1')
    })
    act(() => {
      result.current.setSingle('src_9', 'sess_1')
    })
    act(() => {
      result.current.setMode('all')
    })

    expect(result.current.getSnapshot().mode).toBe('all')
    expect(result.current.singlePin).toBeNull()
  })

  // ── T17：限定归属 ──
  it('T17：用户当轮设置但会话未知（sessionId=null）→ 未绑定，暂不生效', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.setSingle('src_9', null)
    })

    // boundSessionId 为空 → 首请求不得携带限定（避免"属于会话 A 却在 B 生效"）
    const snapshot = result.current.getSnapshot()
    expect(snapshot.mode).toBe('all')
    expect(snapshot.singleSourceId).toBeNull()
    expect(result.current.singlePin).not.toBeNull()
  })

  it('T17：bindSession(同会话) → 待绑定的限定立即生效', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.setSingle('src_9', null)
    })
    act(() => {
      result.current.bindSession('sess_1')
    })

    const snapshot = result.current.getSnapshot()
    expect(snapshot.mode).toBe('single')
    expect(snapshot.singleSourceId).toBe('src_9')
    expect(result.current.singlePin?.boundSessionId).toBe('sess_1')
  })

  it('T17：恢复的持久限定只在**声明会话 == 核验会话**时激活', () => {
    localStorage.setItem(
      singleStorageKey(userId, projectId),
      JSON.stringify({ version: 1, sessionId: 'sess_A', sourceId: 'src_9', baseMode: 'all' }),
    )

    const { result } = renderHook(() => useResearchScope(), { wrapper })
    // 恢复态：未核验 → 不生效
    expect(result.current.getSnapshot().mode).toBe('all')

    act(() => {
      result.current.bindSession('sess_A')
    })
    expect(result.current.getSnapshot().mode).toBe('single')
    expect(result.current.getSnapshot().singleSourceId).toBe('src_9')
  })

  it('T17：持久限定属于另一会话 → 核验时丢弃（不带入新会话）', () => {
    localStorage.setItem(
      singleStorageKey(userId, projectId),
      JSON.stringify({ version: 1, sessionId: 'sess_A', sourceId: 'src_9', baseMode: 'all' }),
    )

    const { result } = renderHook(() => useResearchScope(), { wrapper })
    act(() => {
      result.current.bindSession('sess_B')
    })

    expect(result.current.singlePin).toBeNull()
    expect(result.current.getSnapshot().mode).toBe('all')
    expect(result.current.getSnapshot().singleSourceId).toBeNull()
  })

  it('T17：已绑定的限定在会话切换时被清除，并恢复基础范围', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.toggleSource('src_1')
    })
    act(() => {
      result.current.setSingle('src_9', 'sess_1')
    })
    expect(result.current.getSnapshot().mode).toBe('single')

    act(() => {
      result.current.bindSession('sess_2')
    })

    expect(result.current.singlePin).toBeNull()
    const snapshot = result.current.getSnapshot()
    expect(snapshot.mode).toBe('selected')
    expect(snapshot.singleSourceId).toBeNull()
    expect(snapshot.sourceIds).toEqual(['src_1'])
  })

  it('T17：无 session 身份的持久限定记录被丢弃（不静默扩大）', () => {
    localStorage.setItem(
      singleStorageKey(userId, projectId),
      JSON.stringify({ version: 1, sourceId: 'src_9', baseMode: 'all' }),
    )

    const { result } = renderHook(() => useResearchScope(), { wrapper })
    expect(result.current.singlePin).toBeNull()
    expect(localStorage.getItem(singleStorageKey(userId, projectId))).toBeNull()
  })
})

describe('旧持久范围迁移（T39 / D-21）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('T39：normalizePersistedScope 把 entire_project 读作 all', () => {
    expect(
      normalizePersistedScope({ version: 1, mode: 'entire_project', sourceIds: [], noteIds: [] }),
    ).toEqual({ mode: 'all', sourceIds: [], noteIds: [] })
  })

  it('T39：带 ID 的 entire_project 是不可识别值 → 丢弃（不落 selected 语义）', () => {
    expect(
      normalizePersistedScope({ version: 1, mode: 'entire_project', sourceIds: ['a'], noteIds: [] }),
    ).toBeNull()
  })

  it('T39：未知 mode / 非唯一 ID 数组 → 丢弃', () => {
    expect(normalizePersistedScope({ version: 1, mode: 'bogus', sourceIds: [], noteIds: [] })).toBeNull()
    expect(normalizePersistedScope({ version: 2, mode: 'all', sourceIds: [], noteIds: [] })).toBeNull()
    expect(
      normalizePersistedScope({ version: 1, mode: 'selected', sourceIds: ['a', 'a'], noteIds: [] }),
    ).toEqual({ mode: 'selected', sourceIds: ['a'], noteIds: [] })
    expect(
      normalizePersistedScope({ version: 1, mode: 'selected', sourceIds: [1], noteIds: [] }),
    ).toBeNull()
  })

  it('T39：旧 entire_project 持久值恢复为 all，标签**不得**渲染成 selected 文案', () => {
    localStorage.setItem(
      scopeStorageKey(userId, projectId),
      JSON.stringify({ version: 1, mode: 'entire_project', sourceIds: [], noteIds: [] }),
    )

    const { result } = renderHook(() => useResearchScope(), { wrapper })
    expect(result.current.mode).toBe('all')

    const label = formatScopeLabel(result.current.getSnapshot(), t)
    expect(label).toBe('Entire project')
    expect(label).not.toBe('Selected sources and notes')
  })

  it('T39：不可识别的持久值被清除后回基础范围 all（不落 selected）', () => {
    localStorage.setItem(
      scopeStorageKey(userId, projectId),
      JSON.stringify({ version: 1, mode: 'bogus', sourceIds: ['src_1'], noteIds: [] }),
    )

    const { result } = renderHook(() => useResearchScope(), { wrapper })
    expect(result.current.mode).toBe('all')
    expect(result.current.selectedSourceIds).toEqual([])
    // 丢弃即从持久面移除，下一次挂载不再重放旧值
    expect(localStorage.getItem(scopeStorageKey(userId, projectId))).toBeNull()
  })
})
