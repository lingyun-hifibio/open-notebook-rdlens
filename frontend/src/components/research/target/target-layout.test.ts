import { describe, expect, it } from 'vitest'
import {
  TARGET_CENTER_MIN_WIDTH,
  TARGET_LEFT_PANE_WIDTH,
  TARGET_RIGHT_PANE_WIDTH,
  TARGET_THREE_COLUMN_VIEWPORT,
  resolveTargetLayout,
  targetBreakpointForWidth,
} from './target-layout'

// W1 #1104（UI 规格 v1 §3）：断点/布局纯函数。
// 1024–1279 右栏打开时左栏临时收起；≥1280 三栏；中央列最小 640px。

describe('targetBreakpointForWidth（§3.1/§3.3）', () => {
  it('≥1280 → wide（三栏）；1024–1279 → compact（右栏替换左栏）', () => {
    expect(targetBreakpointForWidth(1440)).toBe('wide')
    expect(targetBreakpointForWidth(TARGET_THREE_COLUMN_VIEWPORT)).toBe('wide')
    expect(targetBreakpointForWidth(1279)).toBe('compact')
    expect(targetBreakpointForWidth(1024)).toBe('compact')
  })

  it('三栏阈值由 282+640+355=1277 向上取 1280 推导', () => {
    expect(
      TARGET_LEFT_PANE_WIDTH + TARGET_CENTER_MIN_WIDTH + TARGET_RIGHT_PANE_WIDTH,
    ).toBe(1277)
    expect(TARGET_THREE_COLUMN_VIEWPORT).toBe(1280)
  })
})

describe('resolveTargetLayout（§3.3）', () => {
  it('compact + 右栏收起：两栏，左栏显示，中央 ≥640', () => {
    const layout = resolveTargetLayout({ breakpoint: 'compact', rightPaneOpen: false })
    expect(layout.leftPaneVisible).toBe(true)
    expect(layout.leftPaneTemporarilyCollapsed).toBe(false)
    expect(layout.rightPaneVisible).toBe(false)
    // 1024 − 282 = 742
    expect(layout.centerColumnWidth).toBe(742)
    expect(layout.centerColumnMinMet).toBe(true)
    expect(layout.composerShowsCompactScope).toBe(false)
  })

  it('compact + 右栏打开：左栏临时收起（不占宽度），中央自适应 ≥640', () => {
    const layout = resolveTargetLayout({ breakpoint: 'compact', rightPaneOpen: true })
    expect(layout.leftPaneVisible).toBe(false)
    expect(layout.leftPaneTemporarilyCollapsed).toBe(true)
    expect(layout.rightPaneVisible).toBe(true)
    // 1024 − 355 = 669
    expect(layout.centerColumnWidth).toBe(669)
    expect(layout.centerColumnMinMet).toBe(true)
    // §3.3：compact 右栏打开时 composer 显示范围紧凑标签
    expect(layout.composerShowsCompactScope).toBe(true)
  })

  it('wide + 右栏打开：三栏并排，左栏不收起，中央 ≥640', () => {
    const layout = resolveTargetLayout({ breakpoint: 'wide', rightPaneOpen: true })
    expect(layout.leftPaneVisible).toBe(true)
    expect(layout.leftPaneTemporarilyCollapsed).toBe(false)
    expect(layout.rightPaneVisible).toBe(true)
    // 1280 − 282 − 355 = 643
    expect(layout.centerColumnWidth).toBe(643)
    expect(layout.centerColumnMinMet).toBe(true)
    expect(layout.composerShowsCompactScope).toBe(false)
  })

  it('wide + 右栏收起：两栏且中央 ≥640', () => {
    const layout = resolveTargetLayout({ breakpoint: 'wide', rightPaneOpen: false })
    expect(layout.leftPaneVisible).toBe(true)
    expect(layout.rightPaneVisible).toBe(false)
    expect(layout.centerColumnWidth).toBe(998)
  })
})

describe('真实视口宽度推导中央列（F19）', () => {
  it('1440 + 右栏打开 + wide：center=1440−282−355=803（≥720）', () => {
    const layout = resolveTargetLayout({ breakpoint: 'wide', rightPaneOpen: true, viewportWidth: 1440 })
    expect(layout.centerColumnWidth).toBe(803)
    expect(layout.centerColumnMinMet).toBe(true)
  })

  it('1024 + 右栏打开 + compact：左栏收起，center=1024−355=669', () => {
    const layout = resolveTargetLayout({ breakpoint: 'compact', rightPaneOpen: true, viewportWidth: 1024 })
    expect(layout.centerColumnWidth).toBe(669)
  })

  it('缺省 viewportWidth 时按断点最小视口推导（SSR/纯函数测试稳定）', () => {
    expect(
      resolveTargetLayout({ breakpoint: 'wide', rightPaneOpen: true }).centerColumnWidth,
    ).toBe(643)
    expect(
      resolveTargetLayout({ breakpoint: 'compact', rightPaneOpen: false }).centerColumnWidth,
    ).toBe(742)
  })
})
