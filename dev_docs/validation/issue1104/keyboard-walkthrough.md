# RDLens #1104 — After 键盘可达走查（[synthetic]）

> 真实 host 应用 + 真实 fork 目标壳（embedded）在合成 mock 网络上运行；**非 L2 部署验收**，synthetic 不单独关闭 L2。
> 生成时间：2026-11-06T19:15:47.156Z；浏览器：Playwright-core 1.62.1 / Chromium 151 (chromium-1243), headless, deviceScaleFactor=1；宿主：http://127.0.0.1:5175/

**总判定：PASS**（9 PASS / 0 FAIL）

| ID | 检查项 | 结果 | 细节 |
|-|-|-|-|
| KB-01 | Tab 顺序：宿主页头先于 iframe 工作台；页头内 返回→旧版切换→语言→退出 均可达 | **PASS** | hostSteps=Back to RDLens \| Legacy workspace (currently target workspace, activate to switch) \| Language \| Sign out firstChildStep=5 |
| KB-02 | 工作台内 Tab 顺序：skip link → 顶栏 → 左资料栏 → 对话 → composer（单调不倒退） | **PASS** | skip-link → topbar → topbar → topbar → sources → sources → sources → sources → sources → sources → sources → conversation → conversation → composer → composer → composer |
| KB-03 | 五类焦点区域均可达（skip link / 顶栏 / 资料栏 / 对话 / composer） | **PASS** | skip-link, topbar, sources, conversation, composer |
| KB-04 | skip link 指向 composer 且 Enter 后焦点进入 composer 区域 | **PASS** | href=#rdlens-target-composer focused=true \| afterEnter=composer/rdlens-target-composer |
| KB-05 | 焦点环可见（键盘聚焦控件 :focus-visible 且 ring/outline 非 none） | **PASS** | global-model-summary-trigger focusVisible=true shadow=rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklab(0.497701 -0.0845774 -0.00596708 / 0.496439) 0px 0px  outline=2px |
| KB-06 | 右栏打开时焦点进入面板；Esc 关闭后焦点返回触发控件 | **PASS** | openFocus=right-pane/rdlens-target-right-pane-close closed=true closedFocus=rdlens-target-outcomes-trigger |
| KB-07 | 1440 无横向页面滚动（默认两栏 + 右栏打开三栏） | **PASS** | default host=1440/1440 fork=1440/1440; open fork=1440/1440 |
| KB-08 | 1024 无横向页面滚动（默认两栏 + 右栏替代左栏；中央列 ≥640px） | **PASS** | default fork=1024/1024; open fork=1024/1024 main=669 |
| KB-09 | 1024 右栏打开时左栏临时收起、右栏 355px、composer 显示范围紧凑标签 | **PASS** | {"asideWidth":0,"asideHidden":true,"rightWidth":355,"mainWidth":669,"chipVisible":true} |

## Tab 顺序（1440×900，en-US，light）

| # | frame | 区域 | testid / aria-label | 文本 | 焦点环 |
|-|-|-|-|-|-|
| 1 | host | host-header | Back to RDLens |  |  |
| 2 | host | host-header | research-workspace-legacy-toggle | Legacy workspace |  |
| 3 | host | host-header | Language | 中文English |  |
| 4 | host | host-header |  | Sign out |  |
| 5 | child | other |  |  |   outline=3px |
| 6 | child | skip-link | rdlens-target-skip-link | Skip to the question input | :focus-visible  outline=2px |
| 7 | child | topbar | global-model-summary-trigger | Local Qwen (synthetic)· Local | :focus-visible box-shadow outline=2px |
| 8 | child | topbar | rdlens-target-tasks-trigger | Tasks | :focus-visible box-shadow outline=2px |
| 9 | child | topbar | rdlens-target-outcomes-trigger | Outcomes | :focus-visible box-shadow outline=2px |
| 10 | child | sources | rdlens-target-sources-add | Add sources | :focus-visible box-shadow outline=2px |
| 11 | child | sources | rdlens-target-sources-search |  | :focus-visible  outline=2px |
| 12 | child | sources | rdlens-target-scope-all |  | :focus-visible box-shadow outline=2px |
| 13 | child | sources | rdlens-target-source-select-src_1 |  | :focus-visible box-shadow outline=2px |
| 14 | child | sources | rdlens-target-source-open | doc_a | :focus-visible  outline=2px |
| 15 | child | sources | rdlens-target-source-select-src_2 |  | :focus-visible box-shadow outline=2px |
| 16 | child | sources | rdlens-target-source-open | doc_b | :focus-visible  outline=2px |
| 17 | child | conversation | rdlens-target-history-trigger | History | :focus-visible box-shadow outline=2px |
| 18 | child | conversation | rdlens-target-new-conversation | New conversation | :focus-visible box-shadow outline=2px |
| 19 | child | composer | chat-input |  | :focus-visible  outline=2px |
| 20 | child | composer | rdlens-target-secondary-search | Evidence search | :focus-visible box-shadow outline=2px |
| 21 | child | composer | rdlens-target-secondary-compare | Compare sources | :focus-visible box-shadow outline=2px |
| 22 | host | host-other |  | Legacy workspace中文Englishsynthetic-owner |  |
| 23 | host | host-header | Back to RDLens |  |  |

## 截图

- `screenshots/after_keyboard_focus_ring_1440x900_en-US.png`
- `screenshots/after_keyboard_right_pane_focus_1440x900_en-US.png`
- `screenshots/after_keyboard_1024_right_pane_1024x768_en-US.png`

## 限制

- 键盘走查在合成 mock 网络与真实应用渲染下完成，不是 L2 部署验收。
- Tab 顺序断言基于 headless Chromium 的浏览器默认 Tab 序；跨 iframe 焦点由浏览器处理。
- 屏幕阅读器人工走查（O-UI-04）不在本轮范围。
