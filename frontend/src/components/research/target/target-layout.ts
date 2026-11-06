/**
 * 目标工作台布局纯函数（W1 #1104；UI 规格 v1 §3 尺寸/断点/布局）。
 *
 * 断点判定与布局推导全部是纯函数：不读 window/媒体查询，便于单测与
 * 验收时按视口宽度断言。组件层用 `useMediaQuery('(min-width: 1280px)')`
 * 判定断点后调用 `resolveTargetLayout`。
 *
 * 规格依据：
 * - §3.1：<1024 不设计；1024–1279 两栏＋右栏打开时**替换左栏**；
 *   ≥1280 三栏；≥1600 固定侧栏、正文列限宽居中。
 * - §3.3：中央列宽 = 视口宽 − 左栏（若显示）− 右栏（若打开）；中央列最小
 *   可读宽度 640px；三栏阈值 = 282 + 640 + 355 = 1277 → 1280。
 */

/** §3.2 左资料栏宽度（UI-04，固定）。 */
export const TARGET_LEFT_PANE_WIDTH = 282
/** §3.2 右栏宽度（UI-12，固定）。 */
export const TARGET_RIGHT_PANE_WIDTH = 355
/** §3.3 中央列最小可读宽度。 */
export const TARGET_CENTER_MIN_WIDTH = 640
/** §3.1/§3.3 三栏断点：282 + 640 + 355 = 1277，向上取 1280。 */
export const TARGET_THREE_COLUMN_VIEWPORT = 1280
/** §3.1 目标壳最低设计宽度（<1024 不设计）。 */
export const TARGET_MIN_VIEWPORT = 1024

/** 断点：compact = 1024–1279（右栏打开时左栏临时收起）；wide = ≥1280（三栏）。 */
export type TargetBreakpoint = 'compact' | 'wide'

export interface TargetLayoutInput {
  breakpoint: TargetBreakpoint
  /** 右栏是否打开（UI-12 一次一项；默认收起） */
  rightPaneOpen: boolean
  /**
   * 实际视口宽度（CSS px）。缺省时按断点最小视口（1024 / 1280）推导，
   * 供纯函数测试与 SSR 首帧使用；组件传入真实 `window.innerWidth` 以在
   * 1440 等宽视口得到正确的中央列宽度（F19）。
   */
  viewportWidth?: number
}

export interface TargetLayout {
  breakpoint: TargetBreakpoint
  /** 左资料栏是否显示（compact + 右栏打开 → 临时收起，状态保留） */
  leftPaneVisible: boolean
  /** 左栏是否因右栏打开被临时收起（关闭右栏后恢复，§5.6） */
  leftPaneTemporarilyCollapsed: boolean
  /** 右栏是否显示 */
  rightPaneVisible: boolean
  /** 由规格推导的中央列可用宽度（含中央列最小宽兜底） */
  centerColumnWidth: number
  /** 中央列是否达到最小可读宽度（未达时不做三栏/不裁切正文） */
  centerColumnMinMet: boolean
  /**
   * §3.3：compact 且右栏打开时，composer 显示当前范围紧凑标签
   * （点击关闭右栏并聚焦左栏）。
   */
  composerShowsCompactScope: boolean
}

/** 视口宽度 → 断点；<1280 一律 compact（<1024 不在本轮设计范围）。 */
export function targetBreakpointForWidth(viewportWidth: number): TargetBreakpoint {
  return viewportWidth >= TARGET_THREE_COLUMN_VIEWPORT ? 'wide' : 'compact'
}

/**
 * 布局推导。
 *
 * - compact + 右栏打开：左栏收起（不占宽度），右栏 355，中央自适应；
 * - compact + 右栏关闭 / wide 任意：左栏显示（wide 右栏打开时三栏并排）。
 */
export function resolveTargetLayout(input: TargetLayoutInput): TargetLayout {
  const { breakpoint, rightPaneOpen } = input
  const leftPaneTemporarilyCollapsed = breakpoint === 'compact' && rightPaneOpen
  const leftPaneVisible = !leftPaneTemporarilyCollapsed
  const rightPaneVisible = rightPaneOpen
  const viewport =
    input.viewportWidth !== undefined && Number.isFinite(input.viewportWidth) && input.viewportWidth > 0
      ? input.viewportWidth
      : breakpoint === 'wide'
        ? TARGET_THREE_COLUMN_VIEWPORT
        : TARGET_MIN_VIEWPORT
  const available =
    viewport -
    (leftPaneVisible ? TARGET_LEFT_PANE_WIDTH : 0) -
    (rightPaneVisible ? TARGET_RIGHT_PANE_WIDTH : 0)
  const centerColumnWidth = Math.max(available, TARGET_CENTER_MIN_WIDTH)
  return {
    breakpoint,
    leftPaneVisible,
    leftPaneTemporarilyCollapsed,
    rightPaneVisible,
    centerColumnWidth,
    centerColumnMinMet: available >= TARGET_CENTER_MIN_WIDTH,
    composerShowsCompactScope: breakpoint === 'compact' && rightPaneOpen,
  }
}
