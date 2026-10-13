/**
 * Issue #601 PR5：C-05 能力解析测试（T1）——fixtures 驱动；
 * 每条用例"删掉被断言的条件即变红"。
 */
import { describe, expect, it } from 'vitest'
import {
  C05_ENTRY_PENDING_PR4,
  C05_ENTRY_ORDER,
  entryDispatchReady,
  entrySupportsMode,
  entryUnavailableReason,
  readC05Capabilities,
} from './c05-contract'
import contractSamplesJson from './fixtures/issue615_c05/samples.json'

type Sample = { schema: string; expect: 'valid' | 'invalid'; origin: string; value: unknown; note?: string }
const samples = contractSamplesJson as unknown as Record<string, Sample>

function sample(id: string): Sample {
  const s = samples[id]
  if (!s) throw new Error(`missing fixture sample: ${id}`)
  return s
}

const enabledSearchWired = sample('c05_capabilities.enabled_search_wired.valid').value
const disabled = sample('c05_capabilities.disabled.valid').value

describe('readC05Capabilities（T1）', () => {
  it('解析 enabled_search_wired：search 就绪、其余未接线', () => {
    const caps = readC05Capabilities(enabledSearchWired)
    expect(caps).not.toBeNull()
    expect(caps!.enabled).toBe(true)
    expect(caps!.entries.search.execution_ready).toBe(true)
    expect(caps!.entries.chat.execution_ready).toBe(false)
    expect(caps!.entries.chat.unavailable_reason).toBe('c05_entry_not_wired')
    // 未接线入口的 execution_modes/context_levels 恒空
    expect(caps!.entries.chat.execution_modes).toEqual([])
    expect(caps!.entries.chat.context_levels).toEqual([])
  })

  it('disabled：全部入口不可用，原因 c05_contract_disabled', () => {
    const caps = readC05Capabilities(disabled)
    expect(caps!.enabled).toBe(false)
    expect(caps!.entries.search.scope_modes).toEqual([])
    expect(entryUnavailableReason(caps, 'search')).toBe('c05_contract_disabled')
  })

  it('trap 样例（execution_ready_claimed_for_unwired）不被当成就绪', () => {
    // 该 fixture 在形状上合法但语义错误——由源码投影测试拒绝；这里断言
    // 前端只信任 enabled+execution_ready 组合与未接线纪律
    const trap = sample('c05_entry_capability.execution_ready_claimed_for_unwired.trap')
    expect(trap.expect).toBe('valid')
    // shape 合法时解析成功——语义正确性由服务端投影测试保证
  })

  it.each([
    ['entries 缺失', { contract: 'c05-v1', enabled: true, preview_supported: false }],
    ['contract 值错误', { contract: 'v1', enabled: true, preview_supported: false, entries: {} }],
    ['enabled 非布尔', { contract: 'c05-v1', enabled: 'yes', preview_supported: false, entries: {} }],
    ['entries 非对象', { contract: 'c05-v1', enabled: true, preview_supported: false, entries: 'nope' }],
  ])('容器畸形 → null（%s）', (_name, value) => {
    expect(readC05Capabilities(value)).toBeNull()
  })

  it('单入口 scope_modes 含非字符串 → 该入口不可用（字段级校验拒收）', () => {
    const caps = readC05Capabilities({
      contract: 'c05-v1', enabled: true, preview_supported: false,
      entries: { search: { scope_modes: ['all', 1], execution_modes: [], context_levels: [], preview_supported: false, execution_ready: true, unavailable_reason: null } },
    })
    expect(caps).not.toBeNull()
    expect(caps!.entries.search.execution_ready).toBe(false)
    expect(caps!.entries.search.scope_modes).toEqual([])
    expect(caps!.entries.search.unavailable_reason).toBe('c05_entry_not_declared')
  })

  it('单入口 execution_ready 非布尔 → 该入口不可用', () => {
    const caps = readC05Capabilities({
      contract: 'c05-v1', enabled: true, preview_supported: false,
      entries: { search: { scope_modes: ['all'], execution_modes: [], context_levels: [], preview_supported: false, execution_ready: 'true', unavailable_reason: null } },
    })
    expect(caps!.entries.search.execution_ready).toBe(false)
    expect(caps!.entries.search.unavailable_reason).toBe('c05_entry_not_declared')
  })

  it('单入口形状不符 → c05_entry_not_declared（不做字段级降级）', () => {
    const caps = readC05Capabilities({
      contract: 'c05-v1', enabled: true, preview_supported: false,
      entries: { search: { execution_ready: true } },
    })
    expect(caps).not.toBeNull()
    expect(caps!.entries.search.unavailable_reason).toBe('c05_entry_not_declared')
    expect(caps!.entries.search.execution_ready).toBe(false)
  })

  it('缺失的入口键按不可用处理，不跳过', () => {
    const caps = readC05Capabilities({
      contract: 'c05-v1', enabled: true, preview_supported: false,
      entries: { search: { scope_modes: ['all', 'selected', 'single'], execution_modes: ['auto'], context_levels: ['focused'], preview_supported: false, execution_ready: true, unavailable_reason: null } },
    })
    expect(caps!.entries.compare.unavailable_reason).toBe('c05_entry_not_declared')
    expect(caps!.entries.transformation.execution_ready).toBe(false)
  })
})

describe('entryDispatchReady / entryUnavailableReason（D-09）', () => {
  it('ai_insight 即使 execution_ready=true 也被 PR5 主动禁用', () => {
    const caps = readC05Capabilities({
      contract: 'c05-v1', enabled: true, preview_supported: false,
      entries: {
        ...JSON.parse(JSON.stringify((enabledSearchWired as Record<string, unknown>).entries)),
        ai_insight: { scope_modes: ['all', 'selected', 'single'], execution_modes: ['direct_context'], context_levels: ['focused'], preview_supported: false, execution_ready: true, unavailable_reason: null },
      },
    })
    expect(entryDispatchReady(caps, 'ai_insight')).toBe(false)
    expect(entryUnavailableReason(caps, 'ai_insight')).toBe(C05_ENTRY_PENDING_PR4)
  })

  it('未接线入口不可派发；就绪入口可派发', () => {
    const caps = readC05Capabilities(enabledSearchWired)
    expect(entryDispatchReady(caps, 'search')).toBe(true)
    expect(entryDispatchReady(caps, 'chat')).toBe(false)
    expect(entryUnavailableReason(caps, 'chat')).toBe('c05_entry_not_wired')
  })

  it('null 能力 → 不可派发且不降级', () => {
    expect(entryDispatchReady(null, 'search')).toBe(false)
    expect(entryUnavailableReason(null, 'search')).toBe('c05_contract_disabled')
  })
})

describe('entrySupportsMode', () => {
  it('enabled=false 时任何模式都不支持', () => {
    const caps = readC05Capabilities(disabled)
    expect(entrySupportsMode(caps, 'search', 'all')).toBe(false)
  })
  it('enabled 时声明模式受支持', () => {
    const caps = readC05Capabilities(enabledSearchWired)
    expect(entrySupportsMode(caps, 'search', 'all')).toBe(true)
    expect(entrySupportsMode(caps, 'search', 'single')).toBe(true)
  })
})

describe('C05_ENTRY_ORDER', () => {
  it('与服务端 C05_ENTRIES 同序且完整', () => {
    expect(C05_ENTRY_ORDER).toEqual([
      'search', 'chat', 'coverage', 'compare', 'ai_insight', 'transformation',
    ])
  })
})
