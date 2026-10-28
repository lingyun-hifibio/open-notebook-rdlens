# 键盘 / 焦点 / IME / 1024/1440/compact 视觉检查（#602 第三批 6b）

- **日期**：2026-10-28（11:14–11:47 +08:00）
- **任务**：task-16（PR-6 卡「必须证明」的键盘/焦点/IME/布局人工检查记录）
- **性质**：隔离环境真实浏览器走查（**不是生产部署**）；合成内容；未改产品代码
- **证据级别**：`real integration`（隔离环境 + 真实 Chromium）中的**人工/自动化走查**；错误态为 route 注入，标 `simulated`；IME 未完成真实组合验证，标 `limited`

> **状态更新（task-19，2026-10-28 11:47–11:58）**：本文上半部分（task-16）因从 source 详情面板状态开始，compact/tab/Enter/IME 只能标 `limited`。**下半部分「稳定全局 Chat 补测」已在全局 chat 状态全部补齐为 `pass`（错误态仍为 simulated）**；两项冲突时以下半部分为准。

## 环境与版本

| 项 | 值 |
|---|---|
| 前端 | `http://127.0.0.1:8503/research`（embedded），由 worktree `batch3-pr12/frontend` 提供服务，HEAD `92be0401d5357b17171f07158f008bb5ed61bfbf` |
| Host 页 | `http://127.0.0.1:8504`（iframe `#app` 默认 1440×900，下发 Research JWT） |
| Gateway | `http://127.0.0.1:7896`（隔离，`RESEARCH_ENABLED=true`） |
| 证据工作树 | `batch3-evidence-remaining` HEAD `8226f12564569c91df1afca82e3cb79f4bea0e50`（main） |
| 浏览器 | Chromium 153.0.8010.12（`/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`，headless） |
| 驱动 | Playwright-core 1.64.1（`/tmp/pwtest/node_modules/playwright-core`） |
| 原始结果 | `/tmp/kbwork/results.json`（临时，不随证据提交） |

会话来源：隔离库既有 global 会话（`sess_*`），合成问题文本；未外发真实项目内容。**未重启任何共享服务**（7896/8503/8504 保持运行）。

## 逐项结论

| # | 检查项 | 结论 | 操作 / 断言 | 截图 |
|---|---|---|---|---|
| 1 | 1440 布局 | **pass** | iframe 置 1440×900；`documentElement.scrollWidth == window.innerWidth == 1440`；composer 可见（rect 824.6,822,521.7×36）且 send 按钮存在 | `screenshots/kb_1440.png` |
| 2 | 1024 布局 | **pass** | iframe 置 1024×768；`scrollWidth == innerWidth == 1024`；composer 可见（595.8,690,334.5×36）且 send 存在 | `screenshots/kb_1024.png` |
| 3 | compact 820×900 | **limited** | `scrollWidth == innerWidth == 820`（**无横向溢出**）；但该会话状态下打开的是 **source 详情面板**（“S3 Acceptance Doc / Back to sources”，底部 `Content / Chat` 子 tab），chat composer 未渲染（rect 0×0），无法在本状态验证 composer 可见/可输入 | `screenshots/kb_compact_820.png` |
| 4 | Chat / Evidence Search tab | **limited** | 初始页 tab 行可见（`Research Chat` 按钮 rect 约 658,105,103×36）；打开会话后 workbench tab 触发器的 rect 变为 0×0，JS click 后未见 `search-input` 出现、chat 面板状态无变化；无法完成可视化 tab 切换验证 | —（过程数据见原始 JSON） |
| 5 | Shift+Enter 换行 | **pass** | 聚焦 composer，输入 `kb keyboard line`，按 `Shift+Enter`：textarea 值变为 `"kb keyboard line\n"`，消息列表为空（未误发送） | `screenshots/kb_shift_enter.png` |
| 6 | Tab 顺序 / 焦点环 | **limited** | 从 textarea 连按 4 次 Tab，实际焦点序列：`Expand source chat` 按钮 → `BODY` → `BODY` → `NEXTJS-PORTAL`；首个目标有可见焦点环（`outline: auto 1px`）；未在 4 步内到达 `chat-send` | `screenshots/kb_focus_tab.png` |
| 7 | composer 未被 gate/inert | **pass** | textarea `disabled=false`、`aria-disabled=null`、`readOnly=false`、无 `[inert]` 祖先；门禁提示存在但仅为 `aria-describedby` 文案（`Select a source or note to use a selected scope.`），不阻塞输入 | — |
| 8 | Enter 发送 | **limited** | 输入后按 Enter，等待 2.5s：`chat-messages` 仍为空、页面无该文本；同状态存在 scope 门禁提示。无法确认是门禁拦截还是发送未触发，标 limited，不作为缺陷定论 | `screenshots/kb_send_enter.png` |
| 9 | Escape / 弹层焦点返回 | **pass** | 点击 `session-switcher-trigger` 打开会话列表 → 按 Escape：`document.activeElement` 回到 `data-testid="session-switcher-trigger"` | `screenshots/kb_escape_focus.png` |
| 10 | IME 组合输入 | **limited** | 计划用 CDP `Input.imeSetComposition`（`zhongwen` → `insertText` 中文 → Enter）验证“组合中不误发/上屏后 Enter 发送”；实际在新会话中 composer 面板未能稳定重新打开（pane 状态问题），CDP 组合未执行完成，无 composition 事件与截图证据。**原因**：会话/面板状态切换不稳定 + 时间窗限制 | —（无截图） |
| 11 | 错误态 + Retry | **limited（simulated）** | route 注入：abort `**/chat/sessions**` → UI 优雅降级显示 “New conversations are not available yet”，**未出现错误条/Retry**；abort 全部 `127.0.0.1:7896/**` 的尝试未在时间窗内完成。既有他人证据 `screenshots/final_gateway_down.png` 显示停 Gateway 时错误条 + Retry（真实），本轮未复现该路径 | `screenshots/kb_error_retry.png`（降级态） |

## 观察项（未改代码，供另开 PR / 后续复核）

1. **compact 宽度下 chat composer 不可见（状态相关）**：820×900 且当前为 source 详情会话时，工作区展示 source 详情（`Content/Chat` 子 tab），全局 composer 不在 DOM 可见区。无法确认是否为窄屏预期响应式行为，也无法定位到具体代码行（本轮未读源码）；复现：8504 → 打开 source 会话 → iframe 宽 820。影响：窄屏下“composer 可见可输入”无法从该状态成立。建议：另开小 PR 验证 `ResearchWorkspace` 在窄屏的 pane 策略，或在 PR-6 卡标注为响应式限制。
2. **Tab 顺序从 composer 先到 “Expand source chat” 再到 body/portal**：4 次 Tab 未到发送按钮；若 composer 与 send 应相邻，属键盘可达性观察项（可能受当前 source-detail pane 影响）。建议：在全局 chat pane 稳定状态复测后再决定是否开 PR。
3. **Enter 未发送且无明确门禁提示定位**：输入后 Enter 无消息、无错误；同屏有 scope 门禁描述文案。建议：在全局会话 + 合法 scope 下复测，确认是否真缺陷；本轮按 limited 记录，不下结论。

## 已知限制

- 证据为隔离环境走查；不是生产验收。
- 错误态为 route 注入（simulated），且只复现了 graceful degradation，未复现错误条/Retry；真实停 Gateway 证据引用他人截图 `final_gateway_down.png`。
- IME 未完成真实组合验证（CDP 组合未执行 + 面板状态不稳定），标 limited；如需通过，需在稳定全局 chat pane 上用 CDP `Input.imeSetComposition` 重跑并截图。
- tab 切换与 compact composer 验证受当前“source 详情会话”状态影响，未覆盖全局 chat pane 的窄屏表现。
- 截图均由 headless Chromium 在 host 页 1460×960 视口截取，含 iframe 调整后的尺寸。

## 文件与复现

- 本文件：`dev_docs/validation/issue602_batch3/real_integration/keyboard_ime_visual.md`
- 截图：`dev_docs/validation/issue602_batch3/real_integration/screenshots/kb_*.png`
- 复现脚本（临时，不入库）：`/tmp/kbwork/kb_main.js`、`/tmp/kbwork/probe6.js`
- 未修改任何产品代码；未 commit/push（证据由 Lead 统一提交）。

---

# 稳定全局 Chat 补测（task-19）

- **时间**：2026-10-28 11:47–11:58 +08:00
- **为什么补测**：上一轮（task-16）从「source 详情会话」状态开始，导致 compact/tab/Enter/IME 均只能标 limited。本轮**严格从 host 页 → Research Chat → 新建会话**，确认**全局 chat composer**（`[data-testid="chat-input"]`）出现且 `document.body.innerText` 不含 `Back to sources`（即未打开 source 详情）后再测量。
- **环境**：同上一节（8503 = `batch3-pr12` HEAD `92be040`；8504 host；7896 gateway；Chromium 153.0.8010.12 + Playwright-core 1.64.1）。**未重启任何服务**。
- **原始结果**：`/tmp/kbwork/results2.json`、`results3.json`、`results4.json`、`results5.json`、`results8.json`（临时，不入库）。
- **截图**：`screenshots/kb2_*.png`（9 张）

## 前置状态断言（每项测量前均成立）

```text
点 Research Chat（tab 可见，rect ≈ 103×36）→ 点 New session
→ [data-testid="chat-input"] 存在
→ body.innerText 不含 "Back to sources"（非 source 详情）
→ [data-testid="research-session-scope-bar"] 存在（会话级范围条）
→ POST /v1/research/.../chat/sessions 201/200 创建会话
```

## 逐项结论（稳定全局 Chat）

| # | 检查项 | 结论 | 操作 / 断言 | 截图 |
|---|---|---|---|---|
| 1 | 1440 布局（全局 chat） | **pass** | iframe 1440×900；`scrollWidth == innerWidth == 1440`；composer rect `(538.2, 844, 808.1×36)` 可见且在视口内；输入 `kb2 type check` 成功（`ta.value === 输入值`）、`disabled=false`；`sourceDetailVisible=false` | `kb2_1440.png` |
| 2 | 1024 布局（全局 chat） | **pass** | iframe 1024×768；`scrollWidth == innerWidth == 1024`；composer `(392.6, 712, 537.7×36)` 可见；可输入、未禁用 | `kb2_1024.png` |
| 3 | compact 820×900（全局 chat，**非 source 详情**） | **pass** | iframe 820×900；`scrollWidth == innerWidth == 820`（无横向溢出）；composer `(28, 844, 698.3×36)` 可见；可输入 `kb2 type check`；`sourceDetailVisible=false` | `kb2_compact_820.png` |
| 4 | Tab 到 chat-send 的步数 / 焦点环 | **pass** | 草稿非空（send enabled）时，从 textarea 按 **1 次 Tab** 即到 `[data-testid="chat-send"]`（`aria-label="Send"`，`:focus-visible=true`，`box-shadow ... 0 0 0 3px ring` 可见焦点环）。send 禁用时同一 Tab 跳过 send、落 `Expand workspace`（禁用控件不接收焦点，符合预期） | `kb2_focus_tab.png` |
| 5 | Enter 发送（真实 7896） | **pass** | 输入 `kb2 enter question` → Enter：`POST /chat` **202** + 随后 **200**（SSE attach），消息列表出现用户消息、draft 清空、send 置 disabled（turn 进行中）。响应含证据一致性闸门拦截文案（本地模型 degraded，属既有已知行为） | `kb2_send_enter.png` |
| 6 | Shift+Enter 换行 | **pass** | `kb2 shift line` + `Shift+Enter` → textarea 值 `"kb2 shift line\n"`，未触发发送 | `kb2_shift_enter.png` |
| 7 | IME 组合输入（CDP） | **pass** | `Input.imeSetComposition({text:'测试'})` → textarea 显示 `测试`，捕获 `compositionstart` + `compositionupdate`，**组合中 POST 数不变**（1→1，无发送）；`Input.insertText('测试问题')` → `compositionupdate`+`compositionend`，值为 `测试问题`、send enabled、save state `All changes saved`；Enter 后 POST 1→3 且消息列表出现 `测试问题`（发送成功） | `kb2_ime_composition.png`、`kb2_ime_sent.png` |
| 8 | 错误态 + Retry（route 注入，**simulated**） | **pass（simulated）** | abort 全部 `http://127.0.0.1:7896/**`（24 个请求被拦）→ UI 显示 `Failed to load workspace data` + `Retry` 按钮（`data-testid="workspace-resources-error"` / `workspace-resources-retry`，页面共 3 处 Retry 文案）、`Select a research model before generating.` 提示；无崩溃 | `kb2_error_retry.png` |

## 与上一轮的差异（limited → pass 的原因）

| 项 | 上一轮 limited 原因 | 本轮修正 |
|---|---|---|
| compact composer | 会话打开的是 **source 详情面板**（“Back to sources”），chat composer 不在该 pane | 改为先点 **New session** 进入全局 chat，再调 iframe 尺寸 → composer 可见可输入 |
| Tab 顺序 | 从 textarea Tab 进入 header 控件链（Expand workspace → BODY/portal → scope/model/activity/export/session switcher），10 步未到 send | 草稿为空时 send 为 `disabled`（`disabled:pointer-events-none` 且不可聚焦），焦点自然落到 header；**草稿非空时 1 步即到 send**。上一轮结论属“空草稿下 send 不可聚焦”的正常行为，非缺陷 |
| Enter 发送 | 上一轮同屏有 scope 门禁描述、未见消息 | 本轮草稿保存完成后 Enter → `POST /chat` 202→200 且消息出现，确认发送正常 |
| IME | composer 面板未能稳定重开，CDP 组合未执行 | 每步之间等 `All changes saved`，CDP 组合 + 上屏 + Enter 全链路完成 |

## 仍标 limited / 记录

- **错误态**为 route 注入（simulated），非真实停 Gateway；真实停 Gateway 的既有证据见 `screenshots/final_gateway_down.png`（他人产出）。
- **发送按钮焦点环**实测为 `box-shadow` ring（`0 0 0 3px` @ ring/50），`outline` 为 `none`；在浅色背景上对比度可接受但偏淡，作为视觉观察项记录（未定位 file:line，未改代码；如需改进建议另开 UI 打磨 PR）。
- 本地模型答案被证据一致性闸门拦截（`degraded`），属隔离模型既有行为，与键盘/IME/布局无关。
- 未验证真实 macOS/Windows 输入法的候选窗行为（CDP 组合只覆盖 DOM 组合事件与提交时序，不代表候选窗 UI）。

## 观察项（未改代码）

1. **空草稿时 send 不可聚焦**：`disabled` 按钮被跳过是浏览器默认行为；若产品希望“空草稿也保持焦点顺序可达”，需显式 `aria-disabled`/可聚焦容器，属可选 a11y 打磨（非缺陷）。
2. **发送按钮焦点环偏淡**：`ring-ring/50` 在浅色底上对比度一般，建议后续视觉打磨时评估。
3. **source 详情态下 compact 不呈现 composer**（上一轮记录）：本轮确认全局 chat 态正常；source 详情 pane 的窄屏策略仍建议另开 PR 复核。
