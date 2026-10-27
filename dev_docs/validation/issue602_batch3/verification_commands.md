# PR-6 验证命令与原始输出摘要（2026-10-27，恢复轮 fix commit）

本文件验证于代码/测试 head `2cd727c64a61e437dfd38c504d1c3bc8e78bfa01`（该 SHA 实际跑出本文件的 27/226/1547 等数字）；后续 commit 仅修证据元数据，不改代码/测试。原始输出另见 PR 评论。
所有命令在 `frontend/` 下执行，secret-scan 在仓库根执行（`origin/main` = `404c0e2`）。

## 0. 证据 secret-scan 门禁（仓库根）

```bash
python3 scripts/validation/scan_evidence_secrets.py
# → SECRET-SCAN OK，exit 0（扫描 dev_docs/validation/ 全目录）
python3 scripts/validation/scan_evidence_secrets.py --root /tmp/<synthetic>   # 自检（预期 exit 1）
```

覆盖：64-hex（allowlist 之外拒绝）、`sk-`/`ghp_`/`github_pat_`/`AKIA`、`Bearer <token>`、PEM 私钥、
`(API_KEY|TOKEN|PASSWORD|SECRET)=值`、`docker inspect … Config.Env` dump、32+ hex 高熵串。
allowlist：`dev_docs/validation/secret-scan-allowlist.txt`（仅非凭证 digest）。
自检记录：[`raw/secret_scan_gate.txt`](raw/secret_scan_gate.txt)。

## 1. 验收命令（cards/PR-6）

```bash
cd frontend
npx vitest run src/lib/locales/index.test.ts src/lib/locales/interpolation.test.ts \
  src/lib/locales/translate-or-fallback.test.ts
npx tsc -b
npm run lint
```

结果：

```text
locale+helper：Test Files 3 passed (3) / Tests 38 passed (38)，EXIT:0
tsc          ：TSC_EXIT:0
lint         ：62 problems (5 errors, 57 warnings)，LINT_EXIT:1
               —— 与干净 origin/main（.worktrees/pr6-baseline）problem 集合 IDENTICAL：
                  raw/lint_setdiff_baseline_vs_pr.txt（仅行号位移，无新增）
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
# → Test Files 6 passed (6) / Tests 226 passed (226)，EXIT:0

npx vitest run src/components/research/ResearchLayout.test.tsx \
  src/components/research/research-layout-utils.test.ts
# → Test Files 2 passed (2) / Tests 31 passed (31)，EXIT:0
```

## 3. 宽范围套件（预存在失败区分）

```bash
cd frontend
npx vitest run src/lib/locales src/components/research src/lib/research src/lib/hooks src/app/research
```

- 本 PR（代码/测试 head `2cd727c64a61e437dfd38c504d1c3bc8e78bfa01`）：`Test Files 2 failed | 99 passed (101)`；`Tests 25 failed | 1547 passed (1572)`，EXIT:1；
  失败仅 `NotesPanel.test.tsx`(11) + `SourceListPanel.test.tsx`(14)。
- 干净 `origin/main`（`.worktrees/pr6-baseline`）：`2 failed | 98 passed (100)`；`25 failed | 1510 passed (1535)`，EXIT:1；
  同文件同条数 → **预存在失败，非本 PR 回归**；新增 37 条通过用例来自本 PR。
- 证据：[`raw/broad_test_after_pr6.txt`](raw/broad_test_after_pr6.txt)、[`raw/baseline_origin_main_provenance.txt`](raw/baseline_origin_main_provenance.txt)。

## 4. 红检（注入退化 → 用例变红 → 已还原）

```text
1) 移除 chat-messages min-h-0                → FAIL: 滚动容器 min-h-0 flex-1 overflow-y-auto
2) 移除 keyCode === 229 守卫                  → FAIL: keyCode=229（Safari/旧 IME）不发送
3) 移除 focusRequestToken 的 focus()          → FAIL: focusRequestToken 变化才聚焦输入框
4) 移除列表 onKeyDown + 条目 tabIndex          → FAIL: roving tabindex
5) 移除 onCloseAutoFocus 回焦                 → FAIL: Escape 关闭回触发按钮
6) 删除 tr-TR.research.session.notFound       → FAIL: 14 locale parity（Missing keys）
7) 移除 document focusin 监听                  → FAIL: 过期意图…不回焦输入框
8) 移除挂起回焦消费 effect                     → FAIL: 目标 editor 未就绪…就绪后才回焦
9) 连续切换清空 pending                        → FAIL: 连续切换（B loading → C ready）沿用挂起
10) 移除 surface 隐藏时的挂起失效              → FAIL: surface 隐藏时挂起回焦失效
11) 移除 source 面板标题接管                   → FAIL: source 会话切换后焦点落到标题
12) 回退为“向 i18n 传 values 再二次插值”        → FAIL: 真实 i18next 单次插值（标题含 {{name}}）
13) 移除旧 editor 快照身份守卫（Chat/Source）   → FAIL: 旧会话/旧 source 快照不回焦用例
14) blur 只清 intent 不清 pending              → FAIL: Chat/Source `blur relatedTarget=null` 用例
15) 移除 source 面板根 onBlurCapture          → FAIL: `source 面板：blur(relatedTarget=null) 清除挂起回焦`
16) 兜底 timer 移回 handleSelect（动画前）      → FAIL: `退出动画期间不提前兜底…`（Presence 动画结束时
                                                  activeElement 仍在条目上 → 旧 timer 跳过 → 最终落 body）
```

## 5. 其他检查

```bash
git diff --check origin/main...2cd727c64a61e437dfd38c504d1c3bc8e78bfa01   # 无输出（代码/测试 head）
python3 scripts/validation/scan_evidence_secrets.py   # SECRET-SCAN OK
```

## 6. 未执行（明确标注）

- 真实接入矩阵 10 腿：9 `pending` + 1 `excluded`（见 `real_integration_matrix.md`）；未部署/未注入 flag/未外发。
- compact/1024/1440 浏览器视觉检查：`limited`（无截图/Playwright；jsdom 不计算布局）。
- 真实浏览器下 200ms 退出动画：用例以 `getComputedStyle.animationName` + 手工 `animationend` 模拟
  Radix Presence 时序（jsdom 无法执行真实动画）；真实浏览器时序未单独重测。
