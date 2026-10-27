# PR-6 基线验证与对照（干净 origin/main vs 本 PR）

- **基线**：`origin/main` = `404c0e227ae34148b26f95a1471cebde8d52d112`（专用干净 worktree `.worktrees/pr6-baseline`，`npm ci` 后实测；cwd/SHA/命令/退出码见 `raw/baseline_origin_main_provenance.txt`）
- **本 PR**：`feat/issue602-b3-pr6` 同 base，改动仅本 PR 文件
- 原始输出：[`raw/baseline_origin_main_provenance.txt`](raw/baseline_origin_main_provenance.txt)、[`raw/lint_after_pr6.txt`](raw/lint_after_pr6.txt)、[`raw/final_verify_after_pr6.txt`](raw/final_verify_after_pr6.txt)、[`raw/broad_test_after_pr6.txt`](raw/broad_test_after_pr6.txt)

## 1. locale / tsc（干净基线）

```text
$ npx vitest run src/lib/locales/index.test.ts src/lib/locales/interpolation.test.ts
 Test Files  2 passed (2)
      Tests  35 passed (35)          # VITEST_EXIT:0
$ npx tsc -b
TSC_EXIT:0
```

## 2. lint（基线 62 problems，本 PR 无新增）

```text
干净 origin/main（.worktrees/pr6-baseline）：npm run lint → 62 problems (5 errors, 57 warnings)，exit 1
本 PR：                                      npm run lint → 62 problems (5 errors, 57 warnings)，exit 1
problem 集合 diff：LINT_PROBLEM_SET_IDENTICAL（逐条 error/warning 文本一致）
```

既有 5 errors（**非本 PR 引入**）：
- `src/components/research/ResearchSearchPanel.c05.test.tsx:71` `react/display-name`
- `src/components/research/SourceListPanel.c05.test.tsx:37` `react/display-name`
- `src/lib/research/editor-machine.ts:994` `prefer-const`（`loading`）
- `src/lib/research/session-idempotency.ts:224` `prefer-const`（`point`）
- `src/lib/research/session-runtime.ts:436` `prefer-const`（`transport`）

## 3. 宽范围测试（本 PR 改动后）

```text
$ npx vitest run src/lib/locales src/components/research src/lib/research src/lib/hooks src/app/research
 Test Files  2 failed | 99 passed (101)
      Tests  25 failed | 1540 passed (1565)
```

失败仅 `NotesPanel.test.tsx`（11）与 `SourceListPanel.test.tsx`（14）——**预存在失败**，在干净 `origin/main`（`.worktrees/pr6-baseline`）复跑：

```text
$ npx vitest run src/components/research/NotesPanel.test.tsx src/components/research/SourceListPanel.test.tsx
 Test Files  2 failed (2)
      Tests  25 failed | 2 passed (27)      # EXIT:1
```

干净基线与本 PR 的宽范围结果：`25 failed | 1510 passed (1535)` vs `25 failed | 1540 passed (1565)`；失败文件与条数一致（**非本 PR 回归**），新增 30 条通过用例来自本 PR 键盘/焦点/i18n 测试。

## 4. 本 PR 定向套件（最终 head 见 PR）

```text
$ npx vitest run src/lib/locales/index.test.ts src/lib/locales/interpolation.test.ts \
    src/lib/locales/translate-or-fallback.test.ts
 Test Files  3 passed (3) / Tests 38 passed (38)

$ npx vitest run \
    src/components/research/ResearchSessionSwitcher.test.tsx \
    src/components/research/ResearchDraftComposer.test.tsx \
    src/components/research/ResearchChatPanel.test.tsx \
    src/components/research/ResearchSourceChatPanel.test.tsx \
    src/app/research/page.sessions.test.tsx \
    src/lib/research/reading-anchor.test.ts
 Test Files  6 passed (6) / Tests 219 passed (219)
```

## 5. 原始日志（已脱敏、去行尾空白、`.txt` 提交）

[`raw/baseline_origin_main_provenance.txt`](raw/baseline_origin_main_provenance.txt)（cwd/SHA/命令/退出码）、
[`raw/lint_after_pr6.txt`](raw/lint_after_pr6.txt)、[`raw/broad_test_after_pr6.txt`](raw/broad_test_after_pr6.txt)、
[`raw/final_verify_after_pr6.txt`](raw/final_verify_after_pr6.txt)。
