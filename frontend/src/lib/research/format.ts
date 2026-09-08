/**
 * Research 域展示格式化纯函数（RWV2-43 / fork #47）。
 *
 * - 时间：research 工作台 UI 固定 en-US（embedded language.ts
 *   resolveInitialLanguage → 'en-US'），服务端时间字段为 ISO-8601；展示用
 *   绝对时间（dateStyle medium + timeStyle short），缺失 → null（调用方
 *   决定占位「—」或省略整段），非法值 → 原串（宁可原样，不伪造）。
 * - 语言：transformation result 的 response_language 只可能 en/zh
 *   （RWV2-31 前恒 null / legacy）；未知非 null 码回退原码展示，不丢失
 *   信息——与 `jobTypeLabelKey`（jobs.ts）「未知类型回退 raw」先例一致。
 *
 * 本模块只服务 research 域，不服务 standalone 全局界面（评审 F14）。
 * `t()` 由调用方在组件层调用；本模块保持纯函数（不依赖 react-i18next）。
 */

const RESEARCH_LANGUAGE_LABEL_KEYS: Record<string, string> = {
  en: 'research.transformations.variantEn',
  zh: 'research.transformations.variantZh',
}

/**
 * ISO-8601 时间 → 可读绝对时间。
 *
 * - null / 空串 → null（调用方决定占位「—」或省略整段）；
 * - 非法日期或 Intl 构造失败（非法 lang/timeZone 抛 RangeError）→ 返回
 *   原串（R3-4 兜底：宁可原样，不伪造）；
 * - 否则 `Intl.DateTimeFormat(lang ?? 'en-US', { dateStyle: 'medium',
 *   timeStyle: 'short', timeZone? })`。
 */
export function formatResearchTimestamp(
  iso: string | null,
  opts?: { lang?: string; timeZone?: string },
): string | null {
  if (iso === null || iso === '') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const lang = opts?.lang ?? 'en-US'
  try {
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
    }).format(date)
  } catch {
    return iso
  }
}

/**
 * response_language → i18n label key 或原码。
 *
 * - null / 空串 → null（展示「—」）；
 * - 'en' / 'zh' → `research.transformations.variantEn` / `variantZh`
 *   （英文标签，RWV2-43 可读性）；
 * - 未知非 null → 返回原码（C-M1：不丢失信息）。
 *
 * 调用方模式（与 ResearchJobList 对 jobTypeLabelKey 的处理一致）：
 * ```ts
 * const key = researchLanguageLabelKey(code)
 * const text = key === null
 *   ? '—'
 *   : key.startsWith('research.transformations.') ? t(key) : key
 * ```
 */
export function researchLanguageLabelKey(code: string | null): string | null {
  if (code === null || code === '') return null
  return RESEARCH_LANGUAGE_LABEL_KEYS[code] ?? code
}
