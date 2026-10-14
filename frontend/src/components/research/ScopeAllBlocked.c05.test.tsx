/**
 * PR5（D-11 / D-26 / T24）：**不能表达 `all` 的入口必须显式阻断**的清单守卫。
 *
 * 为什么需要静态守卫：D-11 的失败模式是**沉默**的——某个派发点在 `all` 下
 * 把手上的空 ID 集当成合法载荷发出去（"空 ID 集冒充 all"），不报错、不崩，
 * 只是把"全部可用资料"悄悄变成"零资料检索"。这类缺陷无法靠类型系统发现，
 * 只能靠"清单 + 每个清单项必须带阻断信号"的可证伪守卫。
 *
 * 本文件同时钉住三件事：
 * 1. **清单完整性**：每个在 `all` 下有派发能力的入口文件都必须含阻断信号；
 *    新增派发点必须显式登记（这是**有意的摩擦**，不是遗漏）。
 * 2. **文案纪律**：`all` 的阻断文案不得写成"没有可用资料"（D-11 禁用措辞），
 *    必须引导"先选择资料"。
 * 3. **契约层不可冒充**：`all` 只能经 `source_scope.mode='all'` 表达；
 *    旧契约形状（顶层 `source_ids: []`）不得由 C-05 构造器产出。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import {
  buildC05GeneratedRequest,
  buildSourceScope,
} from '@/lib/research/c05-request'
import { enUS } from '@/lib/locales/en-US'

/** D-11 派发点清单：入口 → 承接文件 → 该文件必须出现的阻断信号 */
const D11_INVENTORY: ReadonlyArray<{
  entry: string
  file: string
  signals: readonly string[]
}> = [
  { entry: 'compare', file: 'components/research/ComparePanel.tsx', signals: ["reason: 'all'"] },
  { entry: 'coverage', file: 'components/research/CoverageScopeSelector.tsx', signals: ['entireProjectNotice'] },
  { entry: 'insight', file: 'components/research/InsightsPanel.tsx', signals: ['C05_ENTRY_PENDING_PR4'] },
  { entry: 'transformation-run', file: 'components/research/TransformationsPanel.tsx', signals: ['allRequiresSelection'] },
  { entry: 'transformation-rerun', file: 'components/research/TransformationRunDetail.tsx', signals: ['allRequiresSelection'] },
  // D-26：后台 CTA 是"另一条 search 派发点"，曾漏在清单外
  { entry: 'background-cta', file: 'components/research/ResearchWorkspace.tsx', signals: ["'blocked_scope'"] },
  { entry: 'background-cta-ui', file: 'components/research/ResearchChatPanel.tsx', signals: ['backgroundJobBlockedScope'] },
  { entry: 'search', file: 'components/research/ResearchSearchPanel.tsx', signals: ['buildC05GeneratedRequest'] },
]

function readComponent(relative: string): string {
  const srcDir = join(__dirname, '..', '..')
  return readFileSync(join(srcDir, relative), 'utf8')
}

describe('D-11/T24：all 阻断清单完整性（静态守卫）', () => {
  it('每个在 all 下有派发能力的入口文件都带阻断信号', () => {
    const missing = D11_INVENTORY.filter(({ file, signals }) => {
      const content = readComponent(file)
      return !signals.some((signal) => content.includes(signal))
    })
    expect(
      missing.map((item) => `${item.entry} (${item.file}) 缺少 ${item.signals.join('|')}`),
    ).toEqual([])
  })

  it('派发 search/run 的组件文件都必须登记在清单里（新增派发点不得静默加入）', () => {
    const srcDir = join(__dirname, '..', '..')
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
      }
      return out
    }
    const registered = new Set(D11_INVENTORY.map((item) => item.file))
    const dispatchMarkers = [
      'searchV1(',
      'runTransformation(',
      'createAiInsight(',
      'createCompareJob(',
      'createCoverageChat(',
    ]
    const unregistered = walk(join(srcDir, 'components', 'research'))
      .map((full) => full.replace(`${srcDir}/`, ''))
      .filter((rel) => !registered.has(rel))
      .filter((rel) => {
        const content = readFileSync(join(srcDir, rel), 'utf8')
        return dispatchMarkers.some((marker) => content.includes(marker))
      })
    expect(
      unregistered,
      `以下文件发出生成/检索请求但未登记在 D-11 清单（请评估 all 语义并登记）：\n${unregistered.join('\n')}`,
    ).toEqual([])
  })

  it('D-11 文案不得用"没有可用资料"式措辞描述 all（必须引导先选择资料）', () => {
    const forbidden = /no available sources|no sources available|没有可用资料|暫無可用資料/i
    const d11Copies = [
      enUS.research.errors.backgroundJobBlockedScope,
      enUS.research.transformations.allRequiresSelection,
      enUS.research.layout.scope.allHint,
      enUS.research.compareEntireProjectRequiresSelection,
    ]
    for (const copy of d11Copies) {
      expect(copy).toBeTruthy()
      expect(forbidden.test(copy), `禁用措辞出现在 D-11 文案：${copy}`).toBe(false)
    }
    // 引导语必须出现"选择资料/notes"类动作
    expect(d11Copies[0]).toMatch(/select|选择/i)
  })
})

describe('D-11：契约层不可用空 ID 集冒充 all', () => {
  it('all 只经 source_scope.mode=all 表达（合法形状，不是空 ID 集）', () => {
    expect(buildSourceScope({ mode: 'all', sourceIds: [], noteIds: [], singleSourceId: null }))
      .toEqual({ mode: 'all', source_ids: [], single_source_id: null })
  })

  it('C-05 构造器产出 source_scope + 顶层 note_ids，且**不得**产出顶层 source_ids', () => {
    const body = buildC05GeneratedRequest(
      { mode: 'all', sourceIds: [], noteIds: [], singleSourceId: null },
      { query: 'q', model_id: 'm1', mode: 'auto', context_level: 'focused' },
    ) as unknown as Record<string, unknown>
    expect(body.source_scope).toEqual({ mode: 'all', source_ids: [], single_source_id: null })
    expect(body.note_ids).toEqual([])
    expect('source_ids' in body).toBe(false)
  })

  it('空 selected 在构造层 fail-closed（不得发"空 ID 集 + 选择意图"）', () => {
    expect(() => buildC05GeneratedRequest(
      { mode: 'selected', sourceIds: [], noteIds: [], singleSourceId: null },
      { query: 'q', model_id: 'm1', mode: 'auto', context_level: 'focused' },
    )).toThrowError('c05_request_empty_selected')
  })
})
