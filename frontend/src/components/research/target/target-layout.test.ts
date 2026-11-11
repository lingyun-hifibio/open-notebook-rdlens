import { describe, expect, it } from 'vitest'
import {
  TARGET_CENTER_MIN_WIDTH,
  TARGET_EDITOR_ASIDE_BREAKPOINT,
  TARGET_EDITOR_ASIDE_WIDTH,
  TARGET_EDITOR_BACK_BAR_HEIGHT,
  TARGET_EDITOR_BODY_MAX_WIDTH,
  TARGET_LEFT_PANE_WIDTH,
  TARGET_READER_ASIDE_BREAKPOINT,
  TARGET_READER_ASIDE_MAX_WIDTH,
  TARGET_READER_ASIDE_MIN_WIDTH,
  TARGET_READER_ASIDE_WIDTH,
  TARGET_READER_BACK_BAR_HEIGHT,
  TARGET_READER_BODY_MAX_WIDTH,
  TARGET_RIGHT_PANE_WIDTH,
  TARGET_THREE_COLUMN_VIEWPORT,
  resolveTargetEditorLayout,
  resolveTargetLayout,
  resolveTargetReaderLayout,
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

// ---------------------------------------------------------------------------
// W2 #1077：宽屏阅读器（focus view）布局（UI 规格 v1 §3.2/§5.7）。
// 1440：正文 830 + aside 340；1024：aside 默认折叠，展开时正文让宽；
// 任何组合都不产生整页横向滚动。
// ---------------------------------------------------------------------------

describe('reader 尺寸常量（§3.2/§5.7）', () => {
  it('返回条 65 / 正文最大 830 / aside 340（300–380 区间）', () => {
    expect(TARGET_READER_BACK_BAR_HEIGHT).toBe(65)
    expect(TARGET_READER_BODY_MAX_WIDTH).toBe(830)
    expect(TARGET_READER_ASIDE_WIDTH).toBe(340)
    expect(TARGET_READER_ASIDE_MIN_WIDTH).toBe(300)
    expect(TARGET_READER_ASIDE_MAX_WIDTH).toBe(380)
    expect(TARGET_READER_ASIDE_BREAKPOINT).toBe(1280)
    expect(TARGET_READER_ASIDE_WIDTH).toBeGreaterThanOrEqual(TARGET_READER_ASIDE_MIN_WIDTH)
    expect(TARGET_READER_ASIDE_WIDTH).toBeLessThanOrEqual(TARGET_READER_ASIDE_MAX_WIDTH)
  })
})

describe('resolveTargetReaderLayout（§5.7）', () => {
  it('1440：aside 恒显示 340，正文 830 居中（不横向滚动）', () => {
    for (const asideExpanded of [false, true]) {
      const layout = resolveTargetReaderLayout({ viewportWidth: 1440, asideExpanded })
      expect(layout.asideCollapsible).toBe(false)
      expect(layout.asideVisible).toBe(true)
      expect(layout.asideWidth).toBe(340)
      expect(layout.bodyMaxWidth).toBe(830)
      expect(layout.bodyColumnWidth).toBe(830)
      // 830 + 340 = 1170 ≤ 1440
      expect(layout.bodyColumnWidth + layout.asideWidth).toBeLessThanOrEqual(1440)
    }
  })

  it('1440 + 收缩 aside 请求：≥1280 仍恒显示（asideExpanded 不生效）', () => {
    expect(
      resolveTargetReaderLayout({ viewportWidth: 1440, asideExpanded: false }).asideVisible,
    ).toBe(true)
  })

  it('1024：aside 默认折叠（正文 830 占满可用宽度）', () => {
    const layout = resolveTargetReaderLayout({ viewportWidth: 1024, asideExpanded: false })
    expect(layout.asideCollapsible).toBe(true)
    expect(layout.asideVisible).toBe(false)
    expect(layout.asideWidth).toBe(340)
    // min(830, 1024) = 830
    expect(layout.bodyColumnWidth).toBe(830)
    expect(layout.bodyColumnWidth).toBeLessThanOrEqual(1024)
  })

  it('1024 + 展开 aside：正文让宽到 684（不覆盖正文、不横向滚动）', () => {
    const layout = resolveTargetReaderLayout({ viewportWidth: 1024, asideExpanded: true })
    expect(layout.asideCollapsible).toBe(true)
    expect(layout.asideVisible).toBe(true)
    expect(layout.asideWidth).toBe(340)
    // 1024 − 340 = 684
    expect(layout.bodyColumnWidth).toBe(684)
    expect(layout.bodyColumnWidth + layout.asideWidth).toBe(1024)
    expect(layout.bodyColumnWidth + layout.asideWidth).toBeLessThanOrEqual(1024)
  })

  it('断点边界：1279 可折叠，1280 恒显示', () => {
    expect(
      resolveTargetReaderLayout({ viewportWidth: 1279, asideExpanded: false }).asideCollapsible,
    ).toBe(true)
    expect(
      resolveTargetReaderLayout({ viewportWidth: 1279, asideExpanded: false }).asideVisible,
    ).toBe(false)
    const wide = resolveTargetReaderLayout({ viewportWidth: 1280, asideExpanded: false })
    expect(wide.asideCollapsible).toBe(false)
    expect(wide.asideVisible).toBe(true)
    // 1280 − 340 = 940 → 上限 830
    expect(wide.bodyColumnWidth).toBe(830)
  })

  it('任意视口组合：asideWidth 在 300–380 且列宽之和不超过视口（无整页横向滚动）', () => {
    for (const viewportWidth of [1024, 1100, 1200, 1279, 1280, 1366, 1440, 1600, 1920]) {
      for (const asideExpanded of [false, true]) {
        const layout = resolveTargetReaderLayout({ viewportWidth, asideExpanded })
        expect(layout.asideWidth).toBeGreaterThanOrEqual(TARGET_READER_ASIDE_MIN_WIDTH)
        expect(layout.asideWidth).toBeLessThanOrEqual(TARGET_READER_ASIDE_MAX_WIDTH)
        expect(layout.bodyColumnWidth).toBeLessThanOrEqual(TARGET_READER_BODY_MAX_WIDTH)
        const occupied =
          layout.bodyColumnWidth + (layout.asideVisible ? layout.asideWidth : 0)
        expect(occupied).toBeLessThanOrEqual(viewportWidth)
      }
    }
  })

  it('视口非法/缺失按 1024 处理', () => {
    for (const viewportWidth of [Number.NaN, Number.POSITIVE_INFINITY, 0, -100]) {
      const layout = resolveTargetReaderLayout({ viewportWidth, asideExpanded: false })
      expect(layout.asideCollapsible).toBe(true)
      expect(layout.asideVisible).toBe(false)
      expect(layout.bodyColumnWidth).toBe(830)
    }
  })
})

describe('resolveTargetEditorLayout（UI-19 §2.1.3 / UI 规格 v1 §3.2）', () => {
  it('常量：正文列 970、aside 330、返回条 65、aside 断点 1280', () => {
    expect(TARGET_EDITOR_BODY_MAX_WIDTH).toBe(970)
    expect(TARGET_EDITOR_ASIDE_WIDTH).toBe(330)
    expect(TARGET_EDITOR_BACK_BAR_HEIGHT).toBe(65)
    expect(TARGET_EDITOR_ASIDE_BREAKPOINT).toBe(1280)
  })

  it('1440：aside 恒显示 330，正文列 970（970 + 330 = 1300 ≤ 1440）', () => {
    for (const asideExpanded of [false, true]) {
      const layout = resolveTargetEditorLayout({ viewportWidth: 1440, asideExpanded })
      expect(layout.asideCollapsible).toBe(false)
      expect(layout.asideVisible).toBe(true)
      expect(layout.asideWidth).toBe(330)
      expect(layout.bodyMaxWidth).toBe(970)
      expect(layout.bodyColumnWidth).toBe(970)
      expect(layout.bodyColumnWidth + (layout.asideVisible ? layout.asideWidth : 0)).toBeLessThanOrEqual(
        1440,
      )
    }
  })

  it('1024：aside 默认折叠、正文占满可用宽度（min(970, 1024)）', () => {
    const layout = resolveTargetEditorLayout({ viewportWidth: 1024, asideExpanded: false })
    expect(layout.asideCollapsible).toBe(true)
    expect(layout.asideVisible).toBe(false)
    expect(layout.asideWidth).toBe(330)
    expect(layout.bodyColumnWidth).toBe(970)
    expect(layout.bodyColumnWidth).toBeLessThanOrEqual(1024)
  })

  it('1024 + 展开 aside：正文让宽到 694（不覆盖正文、不横向滚动）', () => {
    const layout = resolveTargetEditorLayout({ viewportWidth: 1024, asideExpanded: true })
    expect(layout.asideCollapsible).toBe(true)
    expect(layout.asideVisible).toBe(true)
    expect(layout.asideWidth).toBe(330)
    expect(layout.bodyColumnWidth).toBe(694)
    expect(layout.bodyColumnWidth + layout.asideWidth).toBe(1024)
  })

  it('断点边界：1279 可折叠默认收起，1280 恒显示', () => {
    const compact = resolveTargetEditorLayout({ viewportWidth: 1279, asideExpanded: false })
    expect(compact.asideCollapsible).toBe(true)
    expect(compact.asideVisible).toBe(false)
    const wide = resolveTargetEditorLayout({ viewportWidth: 1280, asideExpanded: false })
    expect(wide.asideCollapsible).toBe(false)
    expect(wide.asideVisible).toBe(true)
    // 1280 − 330 = 950 → 上限 970
    expect(wide.bodyColumnWidth).toBe(950)
  })

  it('任意视口组合：正文列 ≤970、列宽之和 ≤ 视口（无整页横向滚动）', () => {
    for (const viewportWidth of [1024, 1100, 1200, 1279, 1280, 1366, 1440, 1600, 1920]) {
      for (const asideExpanded of [false, true]) {
        const layout = resolveTargetEditorLayout({ viewportWidth, asideExpanded })
        expect(layout.bodyColumnWidth).toBeLessThanOrEqual(TARGET_EDITOR_BODY_MAX_WIDTH)
        const occupied = layout.bodyColumnWidth + (layout.asideVisible ? layout.asideWidth : 0)
        expect(occupied).toBeLessThanOrEqual(viewportWidth)
      }
    }
  })

  it('视口非法/缺失按 1024 处理', () => {
    for (const viewportWidth of [Number.NaN, Number.POSITIVE_INFINITY, 0, -100]) {
      const layout = resolveTargetEditorLayout({ viewportWidth, asideExpanded: false })
      expect(layout.asideCollapsible).toBe(true)
      expect(layout.asideVisible).toBe(false)
      expect(layout.bodyColumnWidth).toBe(970)
    }
  })
})
