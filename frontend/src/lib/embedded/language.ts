/**
 * RWV2-42（Fork #45）：Research 语言钉定辅助。
 *
 * 纯函数：不触碰 i18n 单例、无 import 副作用，便于单测与静态接线。
 * 语义：嵌入式构建（RD_EMBEDDED_MODE=1）由宿主产品消费，宿主 UI 固定
 * 英文（RFC：UI 固定英文，不增加父子 locale 协议）——因此嵌入式 /research
 * 及其所在 origin 固定使用 en-US，不跟随浏览器/本地存储语言；非嵌入式
 * standalone 构建保持原有多语言（LanguageDetector 生效）。
 */
export function resolveInitialLanguage(embedded: boolean): string | undefined {
  return embedded ? 'en-US' : undefined
}
