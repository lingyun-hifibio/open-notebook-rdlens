/**
 * RWV2-42（Fork #45）：Research 语言钉定辅助。
 *
 * 纯函数：不触碰 i18n 单例、无 import 副作用，便于单测与静态接线。
 * 语义：嵌入式构建（RD_EMBEDDED_MODE=1）由宿主产品消费，宿主 UI 固定
 * 英文（RFC：UI 固定英文，不增加父子 locale 协议）——因此嵌入式 /research
 * 及其所在 origin 固定使用 en-US，不跟随浏览器/本地存储语言；非嵌入式
 * standalone 构建保持原有多语言（LanguageDetector 生效）。
 */
import type { HostLanguage } from './messages'

export function resolveInitialLanguage(embedded: boolean): string | undefined {
  return embedded ? 'en-US' : undefined
}

/**
 * W1 契约 v1（D-UI-02）：宿主语言消息落地后的生效语言。
 *
 * - 收到可应用的 language 消息（authenticated 后）→ 以宿主值为准；
 * - 未收到 → 嵌入式构建保持既有默认 en-US（`resolveInitialLanguage`），
 *   standalone 构建返回 `null` 表示不覆盖 LanguageDetector。
 *
 * 纯函数：不触碰 i18n 单例，shell 与单测共用同一判定。
 */
export function resolveAppliedLanguage(
  embedded: boolean,
  hostLanguage: HostLanguage | null | undefined,
): HostLanguage | null {
  if (hostLanguage === 'zh-CN' || hostLanguage === 'en-US') return hostLanguage
  return embedded ? 'en-US' : null
}
