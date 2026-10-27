# PR-6 验证命令与原始输出摘要（2026-10-27）

最终 head 与完整原始输出见 PR 正文/评论；本文件给出可复现命令与摘要。

## 1. 验收命令（cards/PR-6）

```bash
cd frontend
npx vitest run src/lib/locales/index.test.ts src/lib/locales/interpolation.test.ts src/lib/locales/translate-or-fallback.test.ts
npx tsc -b
npm run lint
```

结果：

```text
locale+helper：Test Files 3 passed (3) / Tests 38 passed (38)
tsc   ：TSC_EXIT:0
lint  ：62 problems (5 errors, 57 warnings), exit 1 —— 与干净 origin/main 基线 problem 集合完全一致（无新增）
```

## 2. 键盘/布局/面板定向套件

```bash
cd frontend
npx vitest run \
  src/components/research/ResearchSessionSwitcher.test.tsx \
  src/components/research/ResearchDraftComposer.test.tsx \
  src/components/research/ResearchChatPanel.test.tsx \
  src/components/research/ResearchSourceChatPanel.test.tsx \
  src/app/research/page.sessions.test.tsx \
  src/lib/research/reading-anchor.test.ts
# → Test Files 6 passed (6) / Tests 219 passed (219)

npx vitest run src/components/research/ResearchLayout.test.tsx \
  src/components/research/research-layout-utils.test.ts
# → Test Files 2 passed (2) / Tests 31 passed (31)
```

## 3. 宽范围套件（预存在失败区分）

```bash
npx vitest run src/lib/locales src/components/research src/lib/research src/lib/hooks src/app/research
# 本 PR：2 failed files (NotesPanel 11 + SourceListPanel 14 = 25) | 99 passed (101 files)；
#        25 failed | 1540 passed (1565 tests)，EXIT:1
# 干净 origin/main（.worktrees/pr6-baseline，见 raw/baseline_origin_main_provenance.txt）：
#        2 failed | 98 passed；25 failed | 1510 passed (1535 tests)，EXIT:1
# 两处失败文件与条数一致 → 预存在失败，非本 PR 回归
```

## 4. 红检（注入退化 → 用例变红 → 已还原）

```text
1) 移除 chat-messages min-h-0            → FAIL: 滚动容器 min-h-0 flex-1 overflow-y-auto；输入区 shrink-0
2) 移除 keyCode === 229 守卫              → FAIL: keyCode=229（Safari/旧 IME）不发送
3) 移除 focusRequestToken 的 focus()      → FAIL: focusRequestToken 变化才聚焦输入框；首次挂载不抢焦点
4) 移除列表 onKeyDown + 条目 tabIndex      → FAIL: roving tabindex：仅当前条目可 Tab，方向键/Home/End 移动焦点
5) 移除 onCloseAutoFocus 回焦             → FAIL: 抽屉内“新对话”…Escape 关闭回触发按钮
6) 删除 tr-TR.research.session.notFound   → FAIL: tr-TR should have the same keys as en-US (Missing keys)
7) 移除面板 document focusin 监听            → FAIL: 过期意图…不回焦输入框（P1）
8) 移除挂起回焦的消费 effect                → FAIL: 目标 editor 未就绪…就绪后才回焦输入框（P1）
9) 连续切换清空 pending                     → FAIL: 连续切换（B loading → C ready）沿用挂起请求（P1）
10) 移除 surface 隐藏时的挂起失效             → FAIL: surface 隐藏时挂起回焦失效（P1）
11) 移除 source 面板标题接管                  → FAIL: source 会话切换后焦点落到 source 面板标题
12) 回退为“向 i18n 传 values 再二次插值”      → FAIL: 真实 i18next 模板插值一次（标题含 {{name}}）
13) 移除文档 focusin 对 pending 的清理          → FAIL: 挂起回焦期间焦点被外部元素接管后失效（P1）
14) Source 回焦不校验 editor 身份/ready         → FAIL: source 切换 loading 期间不抢焦（P1）
15) 兜底 timer 移回动画前（handleSelect）        → FAIL: 选择当前会话/新建失败兜底（退出动画下焦点落 body）
```

## 5. 其他检查

```bash
git diff --check origin/main...e27b6e2   # 无输出（raw .txt 已去行尾空白/EOF 空行）
git status --short                    # 仅本 PR 文件（见 PR 正文“改动文件”）
```

## 6. 未执行（明确标注）

- 真实接入矩阵 10 腿：9 `pending` + 1 `excluded`（见 `real_integration_matrix.md`）；未部署/未注入 flag/未外发。
- compact/1024/1440 浏览器视觉检查：`limited`（无截图/Playwright；jsdom 不计算布局）。
