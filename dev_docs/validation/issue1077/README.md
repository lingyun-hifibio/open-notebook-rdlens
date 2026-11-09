# Issue #1077（W2）fork 宽屏阅读/对照视图 — L2 证据（公开安全子集）

- 关联 PR：fork 仓 `feat(#1077): fork 宽屏阅读/对照视图（目标壳 reader）`（head `da8a811`；产品代码 = L2 构建 `acd24c5`，见下）
- 关联计划：RDLens `dev_docs/plans/issue1077_widescreen_reader_plan_20261109.md`（NORMATIVE 定稿 `1076c071c`）§4.3/§5.2
- 本目录是**公开安全子集**：仅受控 synthetic UI-demo 项目的 Before/After 截图与说明；真实 10 篇材料/私有 demo 的完整断言 JSON 只在私有证据包中（哈希见 §6），不进入本仓。
- 不宣称：「宽屏阅读已支持」「PDF inline 已支持」「W2/M2 通过」；M2 签字与 #1077 关闭由 owner 决定。

## 1. 构建坐标

| 项 | Before（部署树重放） | After（本 PR head 候选） |
|---|---|---|
| fork | `fb4f5f6ff02e190a69b2526394279ab8a957aacf` / tree `1943335d12f6c4c02abc1f1703d180274d97bb7a`（= 生产 `.42` 镜像 tree） | `acd24c5461e86d1d37400493c0ab594b73c0c149` / tree `e6ed66f51538ab92e02b2d6ca971b9128de8ce1e`（PR 产品代码；后续仅测试文件提交） |
| fork 构建 | Next standalone（candidate env harness；BUILD_ID `e8joFAji1TxFXDCHrUdoI586M`） | Next standalone，BUILD_ID `FwxGVlzqPtSvkToHneXRz`；builder=`turbopack-fallback-from-webpack`（本环境 webpack 于 base/head 同样报 Next 16.2.6 page-data `Class constructor URL` 错误；turbopack 为 plain `next build` 且在本环境可复现通过，属 harness-only 构建方式差异） |
| host | RDLens main `a377713e4`（`src/frontend` 与部署 `fe5fb04b` 逐文件一致）；dist sha256 `17b6bf8332aa79232e94884dd29c226acc58068e817204a488ba672efa62e005`；`VITE_RESEARCH_WORKSPACE_URL=http://127.0.0.1:5192/research` | 同 host 树；dist sha256 `790b8d4ecaa91814ad42638fc7e1a810fadffb2709661492de9c4547f02694fb`；`VITE_RESEARCH_WORKSPACE_URL=http://127.0.0.1:5194/research` |
| 后端 | 隔离候选 RDLens（PG 5437/Surreal 18065/Redis DB14），D1-E roundtrip flag **off**（与 `.42` 生产 flag 不同——Before 只用于观察「打开原文」W1 禁用态，不用于媒体读） | 同一隔离候选栈，`RESEARCH_D1E_ROUNDTRIP_ENABLED=true`；能力契约 `d1e-roundtrip-v1` enabled；成对 source detail 返回 `source_type`/`file_available`；页图 200；错误版本 422。证明与 11/11 checks：私有 `evidence/env/d1e-proof.json`（sha256 见 §6） |
| 浏览器 | Chromium 1243（Google Chrome for Testing 153.0.8010.12）、Playwright-core 1.64.1、headless、deviceScaleFactor=1、light theme、zh-CN/en-US × 1440×900/1024×768 | 同左 |

**Before 的性质（如实登记）**：Before 是**部署树（`.42` tree / host `fe5fb04b` 等价源码）在隔离候选环境中的真实应用重放截图**，不是生产线上只读观测——本环境没有生产用户凭据，生产 live 观测 **NOT RUN**。Before 不是 mockup；它显示同一部署树在「打开原文」处禁用 + W1 诚实原因、宽屏阅读 NOT RUN。

## 2. 公开截图（30 张，synthetic UI-demo 项目 `usr_24_1125uidemo`）

- Before（12）：`screenshots/before/before-public-*`；zh-CN/en-US × 1440×900/1024×768；target shell、source preview（「打开原文」禁用 + W1 原因）、citation preview（同）。
- After（18）：`screenshots/after/after-public-*`；A1 zh/en × 1440/1024（citation preview 入口启用、reader 打开、page nav N→N+1）、A8 zh/en 1024（aside 默认折叠、展开正文让宽、语言切换保留 reader 状态）。
- 该 demo 源无原文件/页图 → After 截图如实显示「页图不可用 / 下载不可用」诚实态；真实 PDF 页图/下载证据在私有 10 篇材料证据包（A1 8/8 PASS）。
- 逐图 caption：见 [`PUBLIC_SCREENSHOTS.md`](PUBLIC_SCREENSHOTS.md) / [`public-screenshots.json`](public-screenshots.json)。

## 3. L2 结果矩阵（完整证据包，32 runs）

| # | 场景 | 结果 |
|---|---|---|
| A1 | 引用→右栏预览→打开原文→reader（页图/定位/aside/inert） | **PASS**（private 10-paper 4/4 含真实 PDF 页图 1654×2339、成对 ref、page N→N+1、aside；public demo 4/4） |
| A2 | reader→返回工作台→原回答位置 / 返回原回答 | **PASS+NOT RUN**（4/4：return 关闭 reader、无导航、cited answer turn 对齐 message viewport；turn 高约 1300px，只能对齐起始位置，符合 §2.6；`position_unavailable` 分支 NOT RUN——候选 fixture 恒有 durable target，无法在不改 DB 的情况下构造不可用目标） |
| A3 | 选段→讨论→composer chip→发送 `selection_context`→同位置 | **PASS**（4/4 矩阵；真实鼠标拖选→浮层「讨论选段」点击→reader 关闭+chip 显示来源/页码/偏移/引文→POST /chat 202→200，请求含 11 键 `selection_context`，scope `mode=all`/`note_ids=[]` 不变） |
| A4 | 只问此来源→取消；新对话不继承 | **PASS**（1440 zh 最小单点） |
| A5 | 撤权/删除后打开原文 | **NOT RUN**：候选环境无独立撤权机制/fault injection；L1 覆盖 410/restricted 分支，语义引用 #1011/#1013 既有证据 |
| A6 | PDF inline 新标签页能力/入口检查 | **PASS**：无 `window.open`/`target=_blank`/popup/内嵌 PDF 视图；下载入口可用且走页内 `/file` fetch；判定 **NOT SUPPORTED** |
| A7 | XLSX/CSV 规范化正文 + 限制标注；PPT slide 页图 | **PASS**（xlsx 2/2、csv 2/2、PPT slide 1/1，候选「closest real source」demo 项目；DOCX **NOT RUN**：候选无 DOCX 源） |
| A8 | 1024 aside 折叠/展开、无整页横向滚动；语言切换保留 reader 状态 | **PASS**（zh/en 4/4） |
| A9 | 陈旧/缺版本 citation：入口禁用原因/版本不可核对/422 | **NOT RUN**：候选 fixtures 无陈旧/缺版本 citation；构造需改候选 DB；入口禁用/版本不可核对/422 分支由 L1（use-source-media/TargetShell）覆盖，#1011 既有证据引用 |

总计：32 runs → 23 PASS、4 PASS+NOT RUN、**0 FAIL**、5 NOT RUN、79 screenshots（含 private）。

**L2 缺陷与修复（真实浏览器发现，已验证修复）**
- L2-F1（HIGH）：浮层「讨论选段」在 mousedown 时因选区被折叠而卸载，真实用户无法点击 → 修复：chunk markdown memo 化（局部状态重渲染不再重建 DOM/清空 Selection）+ 浮层 `onMouseDown preventDefault`；最终 head A3 4/4 PASS（superseded 0549da1 的诊断图/JSON 保留在私有证据包）。
- L2-F2（MEDIUM）：返回原回答时右栏「焦点回 citation 触发控件」把 1024 会话滚动拉离目标回答 → 修复：`closeRightPane({restoreFocus:false})` + 阅读器关闭焦点回输入区（preventScroll）；最终 head A2 4/4 PASS。
- L2-F3（INFO）：`next build --webpack` 在本环境于 base/head 同样失败（Next 16.2.6 page-data `Class constructor URL`）；plain `next build`（turbopack）通过；属 harness-only 环境差异，与 reader 代码无关。
- L2-F4（INFO）：候选可见 MinIO 缺 user-24 项目对象（page image/file 读路径 S3Error）；私有 page-image 证据使用 harness-only page cache（从 `documents.source_path` 的字节一致 ingest 源播种），不改候选 DB/MinIO/state。
- L2-F5（INFO）：先前 head 的首次 A3 发送遇到 503 temporary_unavailable（候选受理瞬时失败）并重试；最终 head 首次尝试即 202/200。

## 4. 安全边界（#1077 OC-1 已确认）

- 不放宽 iframe sandbox、不新增 parentSession 父子通道、无 host 代码/路由/i18n 改动；host diff = 0。
- **PDF inline 新标签页 NOT SUPPORTED**：无 `window.open`/`target=_blank`/假入口；原文件一律 blob + `<a download>`。
- token 只经 `apiClient` Authorization 头，不入 URL/查询串/localStorage/日志；blob URL 切页/卸载释放；页面内容用既有 MarkdownRenderer（无 `dangerouslySetInnerHTML` 渲染未净化内容）。
- 证据包 token/JWT/secret 模式扫描 clean；本目录只含 synthetic demo 截图与说明。

## 5. NOT RUN / 不宣称（原样带出）

- A5、A9、DOCX、`position_unavailable` 分支 = NOT RUN（原因见 §3）；PDF inline live 复测 NOT RUN（判定 NOT SUPPORTED）；生产线上 Before 只读观测 NOT RUN（无凭据，使用部署树重放，见 §1）。
- 不宣称：完整原文件阅读 / 双来源对照 / 完整页码映射 / XLSX 单元格级（#1075）/ 声明外格式页图（#1076）/ 图表执行级（#1074）/ reader 位置跨刷新恢复 / 嵌入跨域下载文件名（#1080 OPEN）/ `page_idx=0` 兜底位置（#1031 OPEN）/ W2 或 M2 通过。
- 本证据不部署、不启用、不外发、不建发布镜像；发布镜像/pin 锁步/RDLens 证据 PR 按计划 §4.4/§4.5 在 fork PR 合并后执行（发布镜像嵌入态验证只在合并后生产部署观测）。

## 6. 私有完整证据包

完整 32-run manifest/断言 JSON/私有截图与 D1-E 证明保留在私有工作区（不入库）。供复核的哈希（sha256）：

```text
add9c478b81ef449104b5b276b492aab84a610ac1d0c5e0f6d71332f711a8e96  evidence/after/manifest.json
56c18c404cdecf41edda84a7d9a1721306e6207beb874859f75aea0898e7cdbf  evidence/before/manifest.json
9a3fa49d6c8682784063b91ae7098853b7d16fde268d1d6a5b462c0d51e2f1fa  evidence/after/findings.json
0f839553d4863893f677c7fb3f6da109231d2b574c4c765625f5df566456d9e1  evidence/env/env.json
```
