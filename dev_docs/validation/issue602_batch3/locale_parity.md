# PR-6 14 locale 文案与 parity（DESIGN §8.5）

## 1. 新增键（每 locale 19 个）

`research.session.*`（13 个新增）：
`newConversation`、`restrictedConversation`、`unknownVisibility`、`unnamed`、`createNotReady`、`sourceRequired`、`unauthorized`、`sourceUnavailable`、`createFailed`、`creating`、`draft`、`notFound`、`contentNotReady`。

`research.a11y.*`（6 个新增）：
`sessionList`、`sessionItem`（`{{name}}`）、`currentSession`、`newConversation`、`loadMoreSessions`、`keyboardHint`。

- 前缀统一：`research.session.*` / `research.a11y.*`（§8.5）。
- 复用既有键（不重复新增）：`research.session.visibility.legacyBadge`（旧记录徽标）、`research.session.untitled`（面板头部未命名占位）、`research.editor.*`、`research.chatSend` 等。
- `research.session.contentNotReady` 仅用于 `src/app/research/page.tsx` 的两处历史半接线占位（保留门禁，仅本地化；见 `keyboard_layout_checks.md` §5）。

## 2. 翻译覆盖

| Locale | 处理 | 说明 |
|---|---|---|
| `en-US` | 英文原文（19 键） | 每个新键均被非测试源码引用（unused-key 测试通过） |
| `zh-CN` | **实质翻译**（19 键） | 例：新对话 / 受限会话 / 未命名会话 / 无法创建新对话 / 草稿 / 会话列表 / 打开会话 {{name}} / 使用上下方向键… |
| `zh-TW` | **实质翻译**（19 键） | 例：新對話 / 受限會話 / 未命名會話 / 無法建立新對話 / 草稿 / 會話清單 / 開啟會話 {{name}} / 使用上下方向鍵… |
| `pt-BR`、`ja-JP`、`it-IT`、`fr-FR`、`ru-RU`、`bn-IN`、`ca-ES`、`es-ES`、`de-DE`、`pl-PL`、`tr-TR`（11 个） | **英文兜底**（19 键，不得缺键） | DESIGN §8.5 允许首版英文兜底；本文件登记 |

## 3. 测试结果（真实执行）

```text
$ cd frontend && npx vitest run src/lib/locales/index.test.ts src/lib/locales/interpolation.test.ts src/lib/locales/translate-or-fallback.test.ts
 ✓ src/lib/locales/interpolation.test.ts (8 tests)
 ✓ src/lib/locales/index.test.ts (27 tests)          # 14 locale parity + placeholder parity + unused-key
 ✓ src/lib/locales/translate-or-fallback.test.ts (3) # 单次插值 / 真实 i18next / $& 字面量
 Test Files  3 passed (3)
      Tests  38 passed (38)
```

- **Parity**：14 locale 键集与 en-US 完全一致（无 missing / extra）。
- **占位符**：`{{name}}` 在 14 locale 一致；无单花括号漂移。
- **Unused-key**：en-US 19 个新键全部被非测试源码引用（`ResearchSessionSwitcher.tsx`、`ResearchDraftComposer.tsx`/`ResearchChatPanel.tsx`、`src/app/research/page.tsx`、`translate-or-fallback.ts` 调用点）。
- **红检**：删除 `tr-TR.research.session.notFound` → `tr-TR should have the same keys as en-US` FAIL（缺失键被捕获）；把 helper 回退为“向 i18n 传 values 再二次插值” → 真实 i18next 用例 FAIL（标题含 `{{name}}` 被重复替换）。均已还原。

## 4. i18n 与既有断言口径

`src/lib/locales/translate-or-fallback.ts`：真实 i18n 返回译文；未初始化/缺键（含既有测试的 `t(key)=key` mock）回退组件英文常量。这样 PR-2/PR-4 已通过断言（与组件导出常量比较）口径不变，同时 14 locale 键真实生效。
