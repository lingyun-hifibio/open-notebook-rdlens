/**
 * RWV2-12：共享 Scope 解析工具。
 *
 * PR5（Issue #601，C2）：`resolveScopeSelection` 已删除——`all` 语义改由
 * 服务端 C-05 范围解析承担（`source_scope.mode='all'`），前端**不得**再
 * 分页枚举展开（契约 `client_must_not_auto_downgrade`、D-11）。本文件仅
 * 保留语言检测。
 *
 * - `detectResponseLanguage`：RFC §4.2 检测规则——Transformation 无独立
 *   Run instruction，按模板单 Prompt 检测；与 RDLens `agent/prompts.py`
 *   `detect_lang` 同语义（CJK 计数 > ASCII 字母 → zh，否则 en）。
 */

/** RFC §4.2：CJK（U+4E00-U+9FFF）多于 ASCII 字母 → 'zh'，否则 'en'。 */
export function detectResponseLanguage(text: string): 'zh' | 'en' {
  let cjk = 0
  let asciiAlpha = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk += 1
    } else if (/[a-zA-Z]/.test(ch)) {
      asciiAlpha += 1
    }
  }
  return cjk > asciiAlpha ? 'zh' : 'en'
}
