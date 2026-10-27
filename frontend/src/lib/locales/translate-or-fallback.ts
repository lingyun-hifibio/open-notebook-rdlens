/**
 * i18n 兜底解析（RDLens #602 第三批 PR-6，DESIGN §8.5）。
 *
 * 背景：既有组件测试把 `useTranslation` mock 成 `t(key) => key`（见
 * `src/test/setup.ts`）。若直接把 PR-2/PR-4 的英文占位常量替换成 `t()`，
 * 同批已合并 PR 的断言（对比组件导出的英文常量）会因“渲染出键名”而变红，
 * 而任务卡禁止改其他 PR 的断言口径。
 *
 * 本纯函数把两种情况统一掉：
 * - 真实 i18n：返回译文（en-US / zh-CN / zh-TW / 其余英文兜底）；
 * - 未初始化/缺键（`t` 原样返回 key，含测试 mock）：返回调用方英文常量，
 *   并把 `{{name}}` 占位符按 `values` 做字面替换。
 *
 * 因此 en-US 新键必须仍被源码引用（unused-key 测试），但渲染回退保持稳定。
 */

export type TranslateLike = (
  key: string,
  values?: Record<string, string>,
) => unknown

function interpolateLiteral(template: string, values?: Record<string, string>): string {
  if (values === undefined) return template
  return Object.entries(values).reduce(
    (text, [name, value]) => text.split(`{{${name}}}`).join(value),
    template,
  )
}

export function translateOrFallback(
  t: TranslateLike,
  key: string,
  fallback: string,
  values?: Record<string, string>,
): string {
  // 只向 i18n 取模板（不传 values），插值在本函数内做且只做一次：
  // 避免真实 i18next 已插入的值被二次扫描（标题本身含 `{{name}}` 时会被破坏）。
  const resolved = t(key)
  if (typeof resolved === 'string' && resolved.length > 0 && resolved !== key) {
    // 用 split/join 而不是 String.replace，避免 `$&`/`$1` 被当成替换语法。
    return values === undefined ? resolved : interpolateLiteral(resolved, values)
  }
  return interpolateLiteral(fallback, values)
}
