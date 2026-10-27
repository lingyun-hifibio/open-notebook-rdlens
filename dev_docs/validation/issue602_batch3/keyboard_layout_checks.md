# PR-6 键盘 / IME / 焦点 / 布局检查（DESIGN §8.1–§8.6、§10.3）

- **级别**：结构断言与真实事件断言 = `simulated`（jsdom/组件测试，**pass**）；视觉/布局人工检查 = **`limited`**（未执行浏览器截图/Playwright，jsdom 不能计算布局；不写“布局验收通过”）。
- **执行**：2026-10-27，`frontend`（head 见 PR）。

## 1. 会话抽屉键盘与焦点（§8.1）— pass（simulated）

实现位置：`src/components/research/ResearchSessionSwitcher.tsx`。

| 检查项 | 实现 | 断言用例 |
|---|---|---|
| 触发按钮 `aria-haspopup="dialog"`、`aria-expanded`、`aria-controls` | 新增 `aria-controls="research-session-drawer-<surface>"`（抽屉同 id） | PR-6 用例：`aria-controls` 指向抽屉 |
| 打开后焦点进入抽屉 | 打开 effect 将焦点落到当前会话条目（无当前则首条） | 既有 PR-2 Escape/标题用例 + roving 用例 |
| `role=dialog` + 当前语言标签 | Radix `DialogContent` + `DialogTitle`（`chat.sessionsTitle`）；列表 `aria-label`（`research.a11y.sessionList`） | dialog/heading/列表 aria-label 断言 |
| Escape 关闭并返回触发按钮 | 受控 open 下 Radix 不回焦 → 普通关闭在 `onCloseAutoFocus` 回焦触发按钮 | `Escape 关闭回触发按钮`（`waitFor(trigger).toHaveFocus()`） |
| 激活条目/新建后焦点交接（§8.1） | 激活关闭时不回焦触发按钮；面板在 `sessionRef` 变化时接管：此前焦点在输入框 → 回输入框（editor 就绪后），否则焦点落到面板标题（`tabIndex=-1`） | `激活条目后不把焦点拉回触发按钮`；面板 `切换…焦点落到面板标题` / `…回到输入框` / `editor 未就绪…就绪后才回焦` |
| 焦点意图失效（P1） | 面板 `onBlurCapture` + document `focusin` 监听：焦点移到面板外普通元素/面板内非输入控件 → 清除意图；只有面板内与真实会话导航入口（触发按钮/`research-session-drawer-*`）保留 | `焦点从输入框移到面板外普通元素后切换` / `过期意图：输入框→入口→外部控件→入口→切换不回焦输入框` |
| 连续切换与隐藏（P1） | 挂起回焦按“当前会话身份 + editor 就绪”消费；连续 A→B loading→C ready 沿用同一挂起请求；`surfaceActive=false` 使挂起失效，重新显示不执行旧请求 | `连续切换（B loading → C ready）沿用挂起回焦请求` / `surface 隐藏时挂起回焦失效` |
| 无面板接管兜底（P1） | 兜底放在**实际卸载**的 `onCloseAutoFocus` 后（退出动画期间 activeElement 仍在条目上，过早 timer 会漏判；选择当前会话/新建失败不再落 body）；顶栏新建不遗留激活标记 | `激活条目后不立即回焦…无面板接管时兜底回焦` / `选择当前会话后焦点兜底回触发按钮` / `顶栏新建…Escape 仍回焦触发按钮` |
| Source 面板会话切换焦点（P1） | source 面板按 `active('source')` 身份变化接管：此前在 source composer → **等目标 source editor 就绪**（身份匹配 + phase ready 且非 loading）后再回 composer，否则焦点到 source 面板标题；旧快照/loading 不抢焦 | `source 会话切换后焦点落到 source 面板标题` / `source 切换 loading 期间不抢焦，就绪后才回焦 composer` |
| 挂起请求失效（P1） | document `focusin` 与面板 blur 在 **intent 或 pending 任一存在**时都追踪；离开允许区域（含 relatedTarget=null/iframe）同时清除两者 | `挂起回焦期间焦点被外部元素接管后失效` |
| 方向键 roving tabindex / Home / End / Enter·Space 激活 | 列表 `onKeyDown`：↑↓循环、Home/End 首尾；条目 `tabIndex` 仅当前为 0，其余 -1；激活用原生 `button` | `roving tabindex：…`（focus/tabIndex 断言） |
| `aria-current="true"` 当前条目 | 保留 PR-2 行为 | 既有 PR-2 用例 |
| “新对话”按钮在列表首位 | 抽屉内新增 `session-list-new`（列表项之前，`compareDocumentPosition` 断言）；头部既有按钮保留（避免改 PR-2 testid 口径） | `新对话位于列表首位…` |
| 创建中 `aria-busy` | 头部按钮与抽屉内按钮均 `aria-busy={creating}` | `aria-busy=true` + disabled 断言 |
| 创建失败 `role="alert"` | `session-create-error` 由 `role=status` 改为 `role=alert` | `role=alert` 断言 |
| 长标题不截断可访问名称 | 触发按钮 `title` + `aria-label="Current conversation: <full>"`；条目 `title` + `aria-label="Open conversation <full>"` | 长标题 title/aria-label 断言 |
| 未保存/草稿徽标非仅颜色 | `Draft` 文本 + 徽标（既有） | 既有 PR-2 用例 |
| 抽屉高度受视口限制、列表内部滚动 | `max-h-[80vh]` + 列表滚动容器 `min-h-0 flex-1 overflow-y-auto` | 结构断言 |

### 1.1 Source 快捷列表（§8.1 末：复用同一键盘模式）

- `ResearchSourceChatPanel` 的会话快捷列表补齐 roving tabindex（仅活动会话 `tabIndex=0`）、↑/↓ 循环、
  Home/End、列表 `aria-label`（复用 `research.a11y.sessionList`）与条目标题 `title` 全称。
- 用例：`roving tabindex：仅活动会话可 Tab，方向键/Home/End 移动焦点`（`ResearchSourceChatPanel.test.tsx`）。

## 2. 输入与输入法（§8.2）— pass（simulated）

实现位置：`src/components/research/ResearchDraftComposer.tsx`。

| 检查项 | 实现/断言 |
|---|---|
| Enter 发送（非 composing、非 Shift） | 既有用例 C2 + PR-6 Shift+Enter 不发送且不 `preventDefault` |
| IME：`isComposing === true` 或 `keyCode === 229` 不发送；compositionend 后下一次 Enter 才发送 | 既有 C2 + 新增 `keyCode=229`（Safari/旧 IME）用例 |
| 发送禁用原因 `aria-describedby`、保存状态 `role=status`、错误 `role=alert` | 既有 C5/N4 + 门禁原因 visible |
| 切换会话后焦点回输入框（仅此前焦点在 textarea） | `focusRequestToken`；面板维护“此前在输入框”意图（导航入口转移保留、其它转移清除），并且**等目标 editor 就绪后**才消费；否则焦点落到面板标题（§8.1） |
| 自动增高上限后内部滚动、输入区 `shrink-0` | 既有自动增高 + 结构断言 `research-draft-composer` 含 `shrink-0` |

## 3. 锚点不抢焦点（§8.3）— pass（simulated）

- `reading-anchor` 恢复只计算并写 `scrollTop`（`restoreScrollTop` 为纯函数，不接触 DOM 焦点）。
- 面板用例：锚点恢复后 `document.activeElement === document.body`（未被 `focus()`/`scrollIntoView()` 抢走），`scrollTop` 按公式恢复（`0 + 100 - 20 = 80`）。
- Citation `focusRequestId` 语义未改（未触达该路径）。

## 4. 布局结构（§8.4）— pass（结构）/ `limited`（视觉）

| 检查项 | 结构证据 |
|---|---|
| 聊天滚动容器 `min-h-0 flex-1 overflow-y-auto` | `ResearchChatPanel` `chat-messages` 与 `ResearchSourceChatPanel` 消息区均已补 `min-h-0`；PR-6 用例断言 `chat-messages` class |
| 输入区 `shrink-0`（始终在可视区底部） | `research-draft-composer` class 断言 |
| 长标题/长文本不横向溢出 | 头部标题 `min-w-0 truncate` + `title` 全称；切换器触发/条目 `truncate` + `title`；来源快捷列表 `min-w-0 truncate`；头部/范围条 `flex-wrap min-w-0` |
| 抽屉为 overlay 不挤占聊天高度 | Radix Dialog（portal overlay）；抽屉 `max-h-[80vh]`、列表内部滚动 |
| 不新增第三个常驻栏、不改 `ResearchLayout` 拖拽/最大化 | 未改 `ResearchLayout.tsx`/`research-layout-utils.ts`；未新增常驻栏 |
| compact / 1024 / 1440 断点 | `useIsDesktop() = (min-width:1024px)`；`page.tsx` 以 `compact={!isDesktop}` 传给 `ResearchLayout`；1024/1440 同为非 compact（无 1440 断点，宽屏只增可用宽度）；`ResearchLayout.test.tsx` + `research-layout-utils.test.ts` 31 tests 全绿 |

**视觉检查 `limited`**：未在真实浏览器对 1024/1440/compact 做打开历史抽屉、切换两会话、长标题、长草稿、保存失败、容量报告、受限消息的肉眼/截图核对（无 Playwright/浏览器截图流程；jsdom 不计算布局）。建议后续窗口按 §8.6 清单补做并附截图路径；在此之前不得宣称“布局验收通过”。

## 5. 最终面板整合（K7）— pass（simulated）+ 登记

- `ResearchChatPanel`/`ResearchSourceChatPanel`/`ResearchSessionSwitcher` 已由 PR-4/5b/2 接线；本 PR 仅补键盘/布局行。
- `src/app/research/page.tsx` 两处历史占位（D1 批准、±13 行）：`sourceRequired` 与 `contentNotReady` 改为 `translateOrFallback(...)`。
  - `contentNotReady` 门禁**保留**（未删），仅本地化；`page.sessions.test.tsx` 两条用例仍通过（mock `t` 回退英文常量，断言口径不变）。
  - gate 可达性结论：`globalChatGated/sourceChatGated` 仍由页面既有判断产生；本 PR 不改门禁行为，只改文案来源。
- 红检覆盖：`min-h-0` 移除、`keyCode=229` 守卫移除、`focusRequestToken` 回焦移除、roving tabindex/方向键移除、关闭回焦移除、单 locale 缺键 → 对应用例均变红后还原（见 `verification_commands.md` §4）。

## 6. 红检记录

| 注入的退化 | 结果 |
|---|---|
| 移除 `chat-messages` 的 `min-h-0` | FAIL：滚动容器结构用例 |
| 移除 IME `keyCode === 229` 守卫 | FAIL：`keyCode=229` 用例 |
| 移除 `focusRequestToken` 的 `textarea.focus()` | FAIL：切换后回焦用例 |
| 移除列表 `onKeyDown` + 条目 `tabIndex` | FAIL：roving tabindex 用例 |
| 移除 `onCloseAutoFocus` 回焦 | FAIL：Escape 关闭回触发按钮用例 |
| 移除 `activatedRef`（激活也回焦触发按钮） | FAIL：`激活条目后不把焦点拉回触发按钮` + 面板标题焦点用例 |
| 移除 `onBlurCapture` 意图清理 | FAIL：`焦点从输入框移到面板外普通元素后切换：不抢回输入框` |
| 把回焦改为“身份变化立即聚焦” | FAIL：`目标 editor 未就绪时不提前抢焦，就绪后才回焦输入框` |
| 移除 Source 列表 `onKeyDown`/`tabIndex` | FAIL：`roving tabindex：仅活动会话可 Tab…` |
| 移除面板 document `focusin` 监听 | FAIL：`过期意图…不回焦输入框` |
| 移除挂起回焦消费 effect | FAIL：`目标 editor 未就绪…就绪后才回焦输入框` |
| 连续切换清空 pending | FAIL：`连续切换（B loading → C ready）…` |
| 移除 surface 隐藏时的挂起失效 | FAIL：`surface 隐藏时挂起回焦失效…` |
| 移除 source 面板标题接管 | FAIL：`source 会话切换后焦点落到 source 面板标题` |
| 回退为“激活时立即排 timer”（动画前） | FAIL：选择当前会话/新建失败兜底用例（退出动画下焦点落 body） |
| document focusin 只在 intent 为真时清理 | FAIL：`挂起回焦期间焦点被外部元素接管后失效` |
| Source 回焦不校验 editor 身份/ready | FAIL：`source 切换 loading 期间不抢焦…` |
| 删除 `tr-TR.research.session.notFound` | FAIL：`tr-TR should have the same keys as en-US` |
