# Issue #1191（W3 接线）实现 PR 视觉证据（合成 harness）

本目录是 **Issue #1191 两个 fork 实施 PR 的 PR 级 Before/After 视觉证据**，由合成
harness 采集（真实 fork Next.js 应用 + 合成 host iframe + 路由 mock 的 Research
Gateway）。**不是** #1150 的 L2 验收证据：S12b / S10 的 PASS 仍只由 P-E 在
`dev_docs/validation/issue1150/**` 用真实 host+DB+Chromium 候选栈给出（计划 §5.2）。

- 采集时间：2026-11-11 15:47–15:52（+0800）；采集者：`lingyun-hifibio`（自动化 agent）。
- 全部 fixture 均为 `[synthetic]` 合成文本；无真实 RDLens host / PostgreSQL /
  SurrealDB / 文件 / 模型调用 / 私有数据 / 凭据。
- 本目录只存在于 fork 仓证据分支 `evidence/issue1191-w3-wiring-20261111`，
  **不在 PR-A/PR-B 的 diff 内**（两个 PR 的 diff 只含计划 §3.2/§3.3 白名单文件）。

## 坐标

| 侧 | fork 仓 head | 说明 |
|---|---|---|
| Before | `d959635eb`（fork `main`，含 #131） | W3 已交付但仅 legacy 壳可达；目标壳右栏成果目录只读 |
| After（PR-A，截图采集 head） | `dd7dfee67` | 目标壳接入 W3 目录/编辑器/写作入口（无导出按钮） |
| After（PR-A + PR-B，截图采集 head） | `a7987c5e5`（stacked on PR-A） | 追加宽屏编辑器动作区「Export Markdown」入口 |

> 最终 review head：PR-A `23a608602`、PR-B `6855fc34c`（PR-B rebase 到 PR-A 最终
> head）。相对截图采集 head，最终 head 只多一个 **Tab 焦点陷阱修复**（嵌套模态
> 打开时暂停；`TargetEditorFocus.tsx` + 其测试，2 文件 18 行），不改变本目录
> 任何已截取视觉状态；截图无需重采。

PR-A 的 Before/After = `d959635eb` → `dd7dfee67`；PR-B 的 Before/After =
`d959635eb` → `a7987c5e5`（PR-B 分支含 PR-A，符合计划 stacked 关系）。

## 采集方式（可复现）

1. 两个临时 worktree 的 `frontend/src/lib/embedded/config.ts` 在采集期间把三处
   `process.env[CONST]` 动态访问临时改为静态成员访问（Next 16 dev 只内联静态
   `NEXT_PUBLIC_*`；与 #1046/#1047 证据同先例）。**采集后已还原**，文件 sha256
   `2192fb227c1dc58c95b5a89c724fa5b8e8d2ad9e8ab7652ab9479556cde42fb6`。
2. 服务：
   - `node harness/gateway_mock.js 8841`（路由 mock；含 d2-v1 notes API 与
     #1050 单份导出 POST/GET 替身、能力投影、失败模式文件）；
   - `node harness/host_server.js <hostPort> http://127.0.0.1:<appPort>/research`
     （合成 host：research-v0 ready→token 握手 + 全屏 iframe）；
   - app（before/after 各一）：`NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1
     NEXT_PUBLIC_RD_EMBEDDED_MODE=1 NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:8841
     NEXT_PUBLIC_RD_PARENT_ORIGIN=http://127.0.0.1:<hostPort>
     node_modules/.bin/next dev --webpack -p <appPort>`。
3. 采集：`node harness/capture-w3.js --phase=after --host=http://127.0.0.1:<hostPort>/
   --head=<sha> [--scenes=s12b]`；`--phase=before` 同构。
4. 模式：`export_on`（`markdown_export.available=true`，`note_editor`/`writing_local`
   开启）；导出模式 `success`。每次运行前 `/__reset`。

## 结果（检查项原始值见 `results/*.json`、`logs/capture-*.log`）

### S12b — 默认目标壳 W3 接入

| 检查项 | Before `d959635eb` | After `dd7dfee67`（PR-A） |
|---|---|---|
| 默认 `/research` 渲染目标壳 | ✅ | ✅ |
| 右栏成果目录出现 W3 `note-catalog` | ❌（0） | ✅ |
| 目录行可打开编辑器 overlay | ❌（无 W3 编辑器） | ✅ `note-editor` |
| 编辑器标题 / revision / 保存状态 | — | `[synthetic] Citation round-trip note` / `Revision 2` / `saved` |
| 写作入口（全文/选段）可达 | ❌ | ✅ |
| 删除入口 / 返回（离开保护载体） | ❌ | ✅ |
| 关闭后回到目录（工作台保活） | — | ✅ |
| 旧只读文案 "not available until W3" | ✅（预期缺口） | 已删除 |

Before 侧为 `expected_gap`（目标壳无 W3 入口），**不折算 PASS**。

### S10 — 单份 Markdown 导出 UI 入口

| 检查项 | Before `d959635eb` | After `a7987c5e5`（PR-A+PR-B） |
|---|---|---|
| 目标壳编辑器动作区导出入口 | ❌（无 W3 编辑器，expected_gap） | ✅ `note-export-markdown` |
| 浏览器真实下载文件名 | — | `[synthetic] Citation round-trip note.md` |
| 文件字节（UTF-8 无 BOM、非 JSON、`# ` 标题、正文、版本锚） | — | ✅ 644B，`revision=2 snapshot_hash=b5223e5f…` |
| 状态播报 | — | `Markdown exported`（`role=status`） |
| 服务端请求头 `X-Research-Note-Contract` | — | `d2-v1` |
| `Idempotency-Key` 存在 | — | ✅ |
| 请求体恰三键 | — | `format`, `revision`, `snapshot_hash` |
| 下载 GET `download_url` | — | ✅（1 次/宽度；响应 URL 原样使用） |

Before 侧为 `expected_gap`（目标壳无导出 UI 入口；旧整包 JSON 导出未被本单改动）。
来源/定位附录分支（`citation_bindings`）的真实 host 证据归 #1189 修复后复跑，本
合成 harness 的 mock 文件含有 `## Citations` 附录但不作为 #1189 PASS 证据。

## 截图索引

（相对本目录；`before/` = fork main；`after-pr-a/` = `dd7dfee67`；
`after-pr-b/` = `a7987c5e5`；全部 light 主题、1440×900 与 1024×768。）

| 场景 | Before | After（PR-A / PR-B） |
|---|---|---|
| S12b 目标壳 | `screenshots/before/before__s12b_01-target-shell__{1440x900,1024x768}.png` | `screenshots/after-pr-a/after__s12b_01-target-shell__*.png` |
| S12b 成果目录 | `before__s12b_02-outcomes-panel__*`（只读） | `after-pr-a/…_02-outcomes-panel__*`（W3 目录） |
| S12b 宽屏编辑器 overlay | —（无） | `after-pr-a/…_03-editor-overlay__*`；`after-pr-b/…_03-…`（含导出按钮） |
| S12b 关闭回到目录 | — | `after-pr-a/…_04-closed-back-to-catalog__*` |
| S10 导出入口 | `before__s10_01-no-w3-export-entry__*` | `after-pr-b/after__s10_01-editor-export-entry__*` |
| S10 导出成功 | — | `after-pr-b/after__s10_02-exported__*` |

校验：`sha256sum -c screenshots.sha256`。

## 已知限制（如实登记，不宣称 L2/L3）

1. **合成 harness，不是真实 host+DB**：所有 API 为路由 mock；S12b/S10 的 L2 PASS
   归 P-E（计划 §2.5-16/§5.2）。
2. **语言**：嵌入式构建按 RWV2-42 固定 en-US（`lib/embedded/language.ts`），
   因此 fork UI 的 zh-CN 渲染在本 harness 不可得；计划要求的 zh/en × 1024/1440
   L2 变体由 P-E 在真实候选栈采集。本目录只提供 en-US 截图。
3. **主题**：仅 light；dark 仍 NOT RUN。
4. **写入/失败态**：截图覆盖打开→保存状态 saved→关闭；冲突/离开保护/撤权/503
   等失败呈现由 L1 组件用例与 P-E 的 S3/S4/S11 复跑覆盖，不在本截图集宣称。
5. 导出为 mock 后端生成的合成 Markdown；真实 #1050 服务端字节/权限/撤权语义
   由 P-E 的 S10（真实 host）验证。
