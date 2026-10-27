# RDLens #602 第三批 PR-6（3E）验证证据目录

- **PR**：`feat/issue602-b3-pr6`（base `origin/main` `404c0e227ae34148b26f95a1471cebde8d52d112`，PR #77/PR-5b 合并点）
- **范围**：键盘/IME/焦点、compact/1024/1440 布局检查、14 locale、最终面板整合、真实接入矩阵
- **日期**：2026-10-27
- **证据纪律**（DESIGN §10.4）：组件/jsdom 证据一律标 `simulated`；真实接入逐腿标 `pass|pending|limited|excluded` + reason；**本目录不存在任何真实接入 pass**。
- **出口结论**：**第三批出口未满足**（真实接入矩阵因第二批 Gateway 不可用、flag off 无法执行；不勾选 #71、不宣称第三批完成）。

## 文件索引

| 文件 | 内容 |
|---|---|
| [`environment_snapshot.md`](environment_snapshot.md) | 环境快照（RDLens/fork SHA、部署镜像 digest、Gateway URL、flag、模型配置）与查询命令 |
| [`real_integration_matrix.md`](real_integration_matrix.md) | DESIGN §10.4 十腿矩阵：逐腿 `pending`/`excluded` + reason + 证据命令/输出 |
| [`locale_parity.md`](locale_parity.md) | 14 locale 新键清单、zh-CN/zh-TW 实质翻译、parity/interpolation/unused-key 结果 |
| [`keyboard_layout_checks.md`](keyboard_layout_checks.md) | 键盘/IME/焦点/布局结构与红检记录；视觉检查标 `limited` |
| [`baseline_verification.md`](baseline_verification.md) | 干净 `origin/main` 基线（locale/tsc/lint/宽范围测试）与改动后对照 |
| [`verification_commands.md`](verification_commands.md) | 最终验证命令与原始输出摘要 |
| [`raw/`](raw/) | 原始命令输出摘要（环境、Gateway 探针、干净 main 基线 provenance、lint 改动后、最终验证、宽范围测试） |

## 排除项（DESIGN §10.4 / cards/PR-6）

- 未部署、未重启生产/共享服务、未注入 `RDLENS_RESEARCH_SESSION_CONTRACT`。
- 未使用外部模型、未外发真实项目内容；未执行故障注入（无隔离 Gateway）。
- 未改第一批冻结 JSON、未新增后端接口、未改其他 PR 状态机核心/断言口径。
- 第四批 E01–E05（trimmed/blocked 强制构造、多标签真机等）不在本批。

## 剩余限制（不伪装为通过）

1. 真实接入 10 腿中 9 腿 `pending`、1 腿 `excluded`（见矩阵）；第三批出口保持未完成，需第二批启用后由 6b 或后续窗口补测。
2. compact/1024/1440 视觉检查未执行（jsdom 无布局计算，无浏览器截图/Playwright），标 `limited`；结构断言与既有 `ResearchLayout` 断点测试为 `pass`。
3. §4.2-1“运行中徽标”无数据源（列表投影无 running 字段、runtime 无项目级运行集合），本 PR 未实现，登记（`card D2`）。
4. source 新会话仍走 legacy 创建、历史 marker 批量查回、`sendSessionChat` consent 延迟统一 completion、真实 bootstrap transport 依赖 `hooks/`+`api.ts`+第二批可用 → 不在本 PR（`card D3`）。
5. K1 使用 `translateOrFallback` 兜底以保持 PR-2/PR-4 既有断言口径不变；未初始化 i18n 时回退英文常量（生产 i18n 正常初始化时返回译文）。占位符替换用 `split/join`，标题含 `$&`/`$1` 不被当作替换语法。
6. 证据纪律：`raw/` 原始日志已脱敏（不记录部署凭证/密钥；环境取证只输出白名单字段）；原始日志以 `.txt` 提交（`.log` 被 .gitignore 忽略）。
7. 安全事件（评审 P0，已处置）：首版提交曾把部署容器 env 中的两项凭证写入 `raw/`。已在修复轮脱敏并 amend + force-push 重写分支 head（`cfa7fe2 → 1d7c593 →` 当前 head）；**旧提交对象仍可能被 GitHub 保留**，需由 Lead 立即轮换 `RD_INTERNAL_SOURCE_ADAPTER_TOKEN` 与 `RD_AI_GATEWAY_API_KEY`（PR 评论已登记，报告不复述值）。
