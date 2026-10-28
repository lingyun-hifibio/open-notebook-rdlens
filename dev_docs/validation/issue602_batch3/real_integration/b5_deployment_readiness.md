# B5 生产部署就绪与预演（Issue #602 第三批 / 6b 缺口 2）

- **日期**：2026-10-28（14:13–15:30 CST）
- **性质**：**只读生产 + 隔离/staging 预演**。本任务未改动生产 flag、未启停 `rdlens.service`、未写生产数据、未重启 7896/8503/8504。
- **结论**：**`READY-WITH-GAPS / BLOCKED-ON-WINDOW`** —— 构建与同版本预演通过（前端生产构建 + 生产候选后端在隔离 PG/Surreal 上 10/10 API + 8/8 UI），但生产切换被三件事挡住：① 生产正处于**其他会话反复启停**的状态（本任务窗口内 14:54 起、15:08 重启、15:19 又 stop），无法取得稳定窗口；② 生产代码已**未经 B5 记录地漂移** 94 个提交（部署基线 `622a43e2` → 当前 `45de492e`）；③ 新前端镜像 `rdlens.30` 尚未构建/锁 digest，而生产镜像 `rdlens.29` 比第三批代码落后 101 个提交。
- **不得据此宣称生产 B5 完成**；第三批功能在生产为 **未上线（flag 未开）**。
- **发布顺序硬约束（G2/D1）**：`RDLENS_RESEARCH_SESSION_CONTRACT` **必须在换前端镜像之前、或与换镜像同一窗口内开启**。否则第三批 UI 上线后 `capabilities.sessions=false`，新协议会话一律 404/只读禁发（DESIGN §2.6 发布顺序）。当前实测该 flag 三来源（`.env` / `research-preview.env` / unit+drop-in）全部 **0 命中 = off**。

---

## 1. 版本与 SHA

| 组件 | 版本 / SHA | 取证 |
|---|---|---|
| fork 交付基线（本任务 base） | **`2eb1afc95fdc2b85f224d00bb46817f0f0d460a9`**（`origin/main`，含 PR-1…PR-13 + 证据 PR #85/#87） | `git -C .worktrees/batch3-b5-readiness rev-parse HEAD` |
| 本任务分支 | `feat/issue602-b3-b5-readiness` @ `2eb1afc`（worktree `.worktrees/batch3-b5-readiness`） | 同上 |
| RDLens 生产宿主 checkout | **`45de492e526792fb3c502cefcd42da623df0c849`**（15:08:30 重启时 `fabfeed0`，15:25 已 forward 到 `45de492e`；两者 `src/` 相同，差异仅 docs/scripts） | `git -C /home/lchen/workspace/RDLens rev-parse HEAD` |
| 第二批 B5 部署记录基线 | `622a43e2e76413b7a816ac224487cc22a9845693`（PR #796 merge，2026-10-23 窗口） | `dev_docs/validation/issue602_b5_20261023/README.md` |
| **生产代码漂移** | `622a43e2..45de492e` = **94 commits**；其中 `src/rdlens/research` + `src/rdlens/api` = **10 文件 / +394 −8**（`app.py`/`router.py`/`service.py`/`jobs/runtime.py`/`engine/*`/`shared_gpu.py` 新增） | `git rev-list --count`、`git diff --stat` |
| 迁移账本（代码上限） | PG **34** / Surreal **11**（`622a43e2` 起无新增迁移） | `_MAX_VERSION`、`control_plane_migrations.MIGRATIONS` |
| 迁移账本（生产实况） | `migrate ok: postgresql=34, surreal=[1..11]`（15:08:30 启动日志） | `journalctl -u rdlens.service` |
| 生产前端镜像 | `ghcr.io/hifibio-therapeutics/open-notebook-rdlens@sha256:1041c88e…be4dc`（tag `v1.14.0-rdlens.29`），**构建自 fork `e2c9d8d1`**，比 `2eb1afc` **落后 101 commits** | `docker ps` / `deploy/research/BASELINE.md` §1 |
| 工具链 | Node v22.20.0 / npm 10.9.3 / Next 16.2.6（Turbopack）；Python 3.12.12 / FastAPI 0.136.0 / uvicorn 0.44.0 / pydantic 2.13.1 | 探针 |

> **要点**：第三批是**纯前端改动**，后端第二批接口在 `622a43e2` 已合入；生产后端（`45de492e`）代码层面具备会话/编辑器/查回路由，但被 `RDLENS_RESEARCH_SESSION_CONTRACT` 门禁挡成 404（见 §3）。

---

## 2. 构建与测试（全部在隔离 worktree，未改产品代码）

### 2.1 前端生产构建（PASS）

```bash
cd .worktrees/batch3-b5-readiness/frontend      # 2eb1afc，node_modules 软链到主 checkout
NEXT_TELEMETRY_DISABLED=1 \
NEXT_PUBLIC_RD_EMBEDDED_MODE=true \
NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:7898 \
NEXT_PUBLIC_RD_PARENT_ORIGIN=http://127.0.0.1:8513 \
RD_FRAME_ANCESTORS=http://127.0.0.1:8513 \
npm run build
```

| 项 | 结果 |
|---|---|
| 退出码 | **0** |
| 编译 | `✓ Compiled successfully in 3.1s`（Turbopack） |
| TypeScript 阶段 | `Finished TypeScript in 10.4s`（`next build` 内置） |
| 静态页 | `✓ Generating static pages (16/16) in 450ms` |
| 产物 | `.next/` **101 MB**；standalone `server.js` 在 `.next/standalone/workspace/open-notebook-rdlens/.worktrees/batch3-b5-readiness/frontend/server.js`；`.next/static` 7.2 MB |
| 内联校验 | 构建产物含 `http://127.0.0.1:7898`（`NEXT_PUBLIC_RD_GATEWAY_URL` 构建期内联成功）；响应头 `Content-Security-Policy: frame-ancestors http://127.0.0.1:8513` |
| 警告（非阻塞） | `Next.js inferred your workspace root… multiple lockfiles`（`~/pnpm-lock.yaml` 与本仓库 lockfile 并存）；`proxyClientMaxBodySize: "100mb"` 实验特性提示 |
| 证据 | `b5_evidence/frontend_build.log` |

```bash
./node_modules/.bin/tsc --noEmit          # TSC_EXIT=0，0 行输出
./node_modules/.bin/vitest run src/lib/research/session-idempotency.test.ts \
  src/lib/research/session-contract.test.ts src/lib/research/api.session-stream.test.ts \
  src/components/research/ResearchDraftComposer.test.tsx
# Test Files 4 passed / Tests 87 passed；证据 b5_evidence/vitest.log
```

### 2.2 后端（不跑全量，记录范围）

| 范围 | 结果 | 说明 |
|---|---|---|
| 版本/依赖探针 | PASS | §1 工具链；`.venv` editable 指向 `/home/lchen/workspace/RDLens/src` |
| `tests/research/test_issue602_j1_busy.py`（J1-3 busy 语义） | **5 passed**（1.50s） | 第二批决策记录中“J1-3 分支是否合并需核对”的复核：用例在 `45de492e` 存在且通过 |
| `tests/research` J1 收口两腿（426 HTTP、损坏 editor 首次提交） | **2 passed**（4.88s，6472 deselected） | `test_headed_global_missing_c05_v1_returns_426_http`、`test_corrupt_editor_first_submission_is_409_zero_overwrite` |
| 全量 `tests/research` | **未跑**（刻意） | 数千用例，超出本任务时间盒；不得把局部通过写成整体绿 |
| `b5_deploy_window.sh preflight --deploy-sha fabfeed0` | **exit 0**（只读，6 条 OK + 2 条 WARN） | 见 §6.1 |

---

## 3. 生产当前状态（只读实测，多次采样）

### 3.1 采样（本任务窗口内生产被人反复启停）

| 时刻 | `rdlens.service` | 7891 `/health` | 备注 |
|---|---|---|---|
| 14:13 | **inactive**（自 10-26 10:59:30） | — | 任务书前提：inactive / flag off |
| 14:54:46 | 另一会话 `systemctl start`（新 drop-in `zz-c05-acceptance.conf`） | 200 | 启动迁移 34/11，journal 0 ERROR |
| 15:08:21 | 另一会话 `systemctl restart` | 200 | 重启后 15:08:30 ready |
| **15:19:44** | 另一会话 `systemctl stop` → **inactive** | **000** | 截至 15:30 仍 inactive |
| **16:13:25**（收口复采样） | 仍 **inactive/dead**（`InactiveEnterTimestamp=2026-10-28 15:19:44`；`ExecMainStartTimestamp=15:08:30`） | **000**（connection refused） | 见 §3.4 |

> 三次动作均为**其他会话**（`sudo[...]  lchen … COMMAND=/usr/bin/systemctl start|restart|stop rdlens`），本任务未执行任何启停。

### 3.2 有效 flag（从运行进程 `/proc/<pid>/environ` 实测）

| Flag | 有效值 | 来源 | 与仓库默认（`settings.yaml`）关系 |
|---|---|---|---|
| `RESEARCH_ENABLED` | **true** | `~/.config/rdlens/research-preview.env` | 覆盖 `research.enabled: false`（L679） |
| `RESEARCH_CONTRACT_V1_ENABLED` | **true** | 同上 | 覆盖 `feature_flags.research_contract_v1_enabled: false`（L711） |
| `RESEARCH_EXTERNAL_LLM_ENABLED` | **true** | 同上 | 覆盖 `false`（L712）——**外发已开**，第三批不要求改它 |
| `RESEARCH_DOCUMENT_WORKSPACE_CONTEXT_ENABLED` | true | 同上 | — |
| `RESEARCH_WORKSPACE_V2_ENABLED` | true | 同上 | — |
| `RESEARCH_C05_SCOPE_ENABLED` | 14:54–15:19 期间 **true**（临时 drop-in）；**16:13 复采样已失效** | 曾由 drop-in `/etc/systemd/system/rdlens.service.d/zz-c05-acceptance.conf`（2026-10-28 14:54:11，注释“验收后删除”）注入；**该文件已于本任务窗口外被删除**（`rdlens.service.d/` 目录 mtime 15:19，现仅剩 `10-research-preview.conf`），且 `research-preview.env` 无该行 | **C-05 现为 off**；见 §3.4 G3 已发生 |
| `RDLENS_RESEARCH_SESSION_CONTRACT` | **未设置（off）** | `.env` / `research-preview.env` / unit 三处均 0 命中 | **第三批上线前置：必须显式开启** |
| `RESEARCH_CORS_ALLOWED_ORIGINS` | `http://192.168.5.82:7800` | `research-preview.env` | 与前端 iframe 实际 origin 一致（实测 preflight 200） |

### 3.3 生产拓扑实测（重要，与任务书假设不同）

| 端点 | 事实 |
|---|---|
| 后端 7891 | `uvicorn rdlens.api.app:create_app --factory --port 7891`，`WorkingDirectory=/home/lchen/workspace/RDLens`，`PYTHONPATH=…/RDLens/src` |
| 前端宿主页 `:7890` | `http://192.168.5.82:7890/` 返回 RDLens Vite 宿主页；`/v1/research/*` 反代到 7891（后端停机时 502） |
| 前端 iframe `:7800` | nginx（`Server: nginx/1.18.0`）→ 容器 `research-open-notebook-open_notebook-1`（镜像 `rdlens.29`）；`/research` = 200 |
| 镜像内固化值 | `getEmbeddedGatewayUrl()` = `http://192.168.5.82:7890`；`getEmbeddedParentOrigins()` = `http://192.168.5.82:7890`；`isEmbeddedMode()` = `true`；CSP `frame-ancestors http://192.168.5.82:7890` |
| 路由注册状态 | `/v1/research/health` 200、`/workspace-status` 200、`projects/*/sources` 401、**`projects/*/chat/sessions` 404**（带 `X-Research-Session-Contract` 头仍 404 ⇒ 路由未注册，非鉴权失败） |

> **推论**：生产目前是「research 已开、会话契约未开、前端为第二批镜像」的**半开状态**；第三批 UI 一旦随 `rdlens.29` 之前的镜像上线，`capabilities.sessions=false` 会让新协议会话变成只读/禁发（DESIGN §2.6 的发布顺序约束）。**必须先开 `RDLENS_RESEARCH_SESSION_CONTRACT=true` 并重启，再换第三批镜像**（或同窗口内先 flag 后镜像）。

---

### 3.4 收口复采样（2026-10-28 16:13，任务交付前最终状态）

| 项 | 16:13 实测 | 与 15:30 结论的差异 |
|---|---|---|
| `rdlens.service` | `inactive`/`dead`，`InactiveEnterTimestamp=2026-10-28 15:19:44`，`ExecMainStartTimestamp=15:08:30` | 一致（仍停） |
| 7891 `/health` | `curl` exit 7 → **HTTP 000 connection refused** | 一致（后端未运行） |
| drop-in `zz-c05-acceptance.conf` | **文件不存在**；`/etc/systemd/system/rdlens.service.d/` 现仅 `10-research-preview.conf` | **新增事实**：临时 drop-in 已被外部删除 ⇒ `RESEARCH_C05_SCOPE_ENABLED` 回到 off（G3 预言的"删 drop-in 丢 C-05"已发生） |
| `RDLENS_RESEARCH_SESSION_CONTRACT` | 三来源（`research-preview.env` / `RDLens/.env` / unit+drop-in）**均 0 命中 = off** | 一致（G2 仍未闭合） |
| `research-preview.env` 现有 flag（只读键名） | `RESEARCH_ENABLED=true`、`RESEARCH_CONTRACT_V1_ENABLED=true`、`RESEARCH_EXTERNAL_LLM_ENABLED=true`、`RESEARCH_DOCUMENT_WORKSPACE_CONTEXT_ENABLED=true`、`RESEARCH_WORKSPACE_V2_ENABLED=true`；**无 C-05、无 session contract** | 新增细节 |

> **注意**：`RESEARCH_EXTERNAL_LLM_ENABLED=true` 在生产为**已开**状态（第二批遗留），第三批发布不要求改它；但若按"最小外发"原则回滚，需与负责人确认是否要一并关回 `false`。

---

## 4. 待部署项（flag / 构件 / 顺序）

| # | 项 | 现值 | 目标值 | 动作 | 风险 |
|---|---|---|---|---|---|
| D1 | 后端 `RDLENS_RESEARCH_SESSION_CONTRACT` | 未设置 | `true` | 在 `research-preview.env` 追加一行（0600）或主 unit `Environment=` | 开后会注册 `chat/sessions*`、`editor-state`、`submissions` 路由；旧路径不受影响（纯新增） |
| D2 | 后端 `RESEARCH_C05_SCOPE_ENABLED` | `true`（临时 drop-in） | 由正式渠道承载 | 把该行并入 `research-preview.env`，删除 `zz-c05-acceptance.conf` + `daemon-reload` | 删 drop-in 前必须先落正式渠道，否则 C-05 失效 |
| D3 | 前端镜像 | `rdlens.29`（fork `e2c9d8d1`） | **新 `rdlens.30`（fork `2eb1afc`）** | 构建并推 GHCR，锁 digest，更新 `deploy/research/compose.yaml` + `BASELINE.md` 台账 | 未构建；构建参数必须沿用冻结值（见 §4.1） |
| D4 | 后端代码 SHA | `45de492e`（未记录漂移） | 与部署记录一致 | 决定是「回退到 `622a43e2` 重走 B5」还是「把 `45de492e` 记为正式当前基线」 | **需负责人裁决**（见 §7） |
| D5 | 迁移 | 34 / 11 | 同（无新增） | 无需迁移 | — |
| D6 | 24h 观察（E14） | 连续 2 次 INVALID | 第 3 次窗口成立 | 需稳定不停服窗口 | 生产今日仍被人反复启停 |

### 4.1 前端镜像构建参数（冻结值，`BASELINE.md` §1.1 口径）

```bash
docker build \
  --build-arg NEXT_PUBLIC_RD_EMBEDDED_MODE=true \
  --build-arg NEXT_PUBLIC_RD_GATEWAY_URL=http://192.168.5.82:7890 \
  --build-arg NEXT_PUBLIC_RD_PARENT_ORIGIN=http://192.168.5.82:7890 \
  --build-arg RD_FRAME_ANCESTORS=http://192.168.5.82:7890 \
  -t ghcr.io/hifibio-therapeutics/open-notebook-rdlens:v1.14.0-rdlens.30 .
```

> 本任务**未构建镜像**（会占用 1.8 GB/次、需推 registry，属发布动作）；只验证了同源码的 `next build` 与 standalone 产物。镜像构建仍需在发布窗口内由授权人执行并回填 5 处台账。

---

## 5. 备份 / 回滚 / 维护窗口

### 5.1 备份（工具就绪，**未执行**）

| 项 | 状态 | 证据 |
|---|---|---|
| `b5_deploy_window.sh` | 就绪（`preflight` exit 0） | §6.1 |
| gpg / `postgres:16` 镜像 / `sha256sum` / `jq` / `uv` | 齐全 | preflight `OK 备份工具与 postgres:16 镜像就绪` |
| 口令文件 | `/mnt/data_ext-disk/lychen/RDLens/surreal_backups/.backup_passphrase`（0600，65 B） | `ls -l` |
| 备份落点 | `/mnt/data_ext-disk/lychen/RDLens/{surreal_backups,pgbackups}`，可用 9.2 TB | `df -h` |
| 根分区 | 可用 **47 GB**（门槛 2048 MB） | preflight |
| 上次备份 | PG `pg_20261023T120539.dump`（120,297,926 B）、Surreal `backup-20261023-120537.surql.gpg`（5,668,872 B） | `dev_docs/validation/issue602_b5_20261023/` |

### 5.2 回滚（同二进制 + flag off；不 down migration）

1. 先查 flag off（三来源：`.env` / `research-preview.env` / `systemctl cat`，含 drop-in）；
2. `sudo systemctl stop rdlens.service`；
3. **保持同一新二进制**，不 checkout 旧二进制、不 down migration、不 `--repair`；
4. 需要时从 §5.1 备份恢复（须回滚决策人批准并记录恢复点）；
5. `sudo systemctl start rdlens.service`（约 73 s 才 ready，健康检查勿按 15 s 判失败）；
6. 验证不止 `/health`：旧路径 `GET .../chat/sessions/{id}`（global / source 变体）必须 200；
7. 记录原因/命令/结果/数据影响并归档 E12。

> **前端回滚**：`deploy/research/compose.yaml` 把 digest 改回 `sha256:1041c88e…be4dc` 后 `docker compose up -d open_notebook`；服务端已保存的会话不回退（DESIGN §2.6）。

### 5.3 维护窗口 / 审批 / 责任人（仍待定）

| 项 | 状态 |
|---|---|
| 维护窗口 | **未定**。生产今日被其他会话 14:54 start → 15:08 restart → 15:19 stop，窗口不具备独占性 |
| 部署审批人（书面） | **缺**（第二批遗留，仍只有口头授权） |
| 变更单/工单号 | **未开单** |
| 通知对象 | 未通知 |
| 备份责任人 | 不指定（沿用第二批裁决：单人运维，执行人自担） |
| 回滚决策人 | 不指定（同上） |

---

## 6. 生产切换 checklist（供授权后逐条勾）

- [ ] 0. 取得**独占窗口**与启停授权（当前其他会话正在用生产，必须先协调）。
- [ ] 1. `b5_deploy_window.sh preflight --deploy-sha <目标SHA>` exit 0（本任务已对 `fabfeed0` 验证通过）。
- [ ] 2. 备份：Surreal 整 namespace 导出 + `pg_dump`（同一时点，先备份后迁移）；记录 sha256 与字节数。
- [ ] 3. 记录迁移前 `--status`（PG/Surreal 账本）。
- [ ] 4. 后端 flag：`RDLENS_RESEARCH_SESSION_CONTRACT=true` 写入 `research-preview.env`；把 `RESEARCH_C05_SCOPE_ENABLED` 从临时 drop-in 并入正式渠道；删除 `zz-c05-acceptance.conf` 并 `daemon-reload`；三来源复查。
- [ ] 5. 停服 → 切后端 SHA（或确认 `45de492e` 为正式基线）→ `uv sync` → `migrate --apply` → `migrate --check`（预期 34/11）。
- [ ] 6. 启动 + `/health` 200 + `/v1/research/health` ready + 新路由**注册**（不带 token 应为 401，而非 404）。
- [ ] 7. 构建并推 `rdlens.30` 镜像，锁 digest，改 `compose.yaml`，`docker compose up -d open_notebook`。
- [ ] 8. 冒烟（复用本任务 `api_smoke.py` / `ui_final.js` 口径，指向 7891/7800/7890）：create→edit→save（replay 200 / CAS 409）→ send 202→200 SSE→lookup terminal→刷新恢复。
- [ ] 9. 旧路径回归：旧 global/source detail 200；`session_store_unavailable` 计数不回潮。
- [ ] 10. 起 24h 观察（E14 第 3 次）：窗内**不得停服**，+12 h 处 `systemctl is-active` 中途复检；复核前先看 `uptime -s` 与 `InactiveEnterTimestamp`。
- [ ] 11. 证据归档 + §12 人工签收。

### 6.1 preflight 实测输出（`--deploy-sha fabfeed0`，exit 0）

```text
OK 部署 SHA 的树里含本脚本
WARN 工作树当前不干净（窗口前正常）
OK 部署 SHA 合法（>= 2dab95d5）
OK 冻结 JSON sha256/大小一致（03eaf56e…24c73f / 140644）
OK PR-10 冻结点后无迁移定义变更
OK 部署树 unit 通过 systemd-analyze verify
OK 回滚 unit 不含 external
OK .env 权限 600 且无 RDLENS_MIGRATIONS_EXTERNAL
OK §1：session contract flag off（三处均无真值）
OK 备份工具与 postgres:16 镜像就绪
OK 根分区可用 47GB
OK 7891 监听者数量：1
WARN 已知 drift：repo unit 与 install.sh 均不含 research-preview.env
OK preflight 全部通过
```

---

## 7. 隔离/staging 预演（同版本，未碰生产）

### 7.1 环境（全部本任务临时拉起，用完即停）

| 组件 | 地址 | 代码/构建 |
|---|---|---|
| 后端 Gateway（生产候选） | `127.0.0.1:7898` | `PYTHONPATH=/home/lchen/workspace/RDLens/src`（= 生产同一份代码，`fabfeed0`/`src` 与 `45de492e` 相同），`RDLENS_MIGRATIONS_EXTERNAL=1`（只读账本断言）；PG `5436/knowledge_os_issue602_b3`、Surreal `18004`（隔离） |
| 前端（**生产 standalone 构建**） | `127.0.0.1:8514` | 本任务 `next build` 产物 `node server.js`（`NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:7898`） |
| 宿主页（token 下发） | `127.0.0.1:8513` | 临时 `ThreadingHTTPServer`，postMessage 契约 v0，JWT 用隔离 secret 现签 |
| 浏览器 | Chromium 1243（playwright-core 1.64.1，headless 1440×950） | — |

> 未重启 7896/8503/8504；未改它们的配置。7896 的 CORS 只允许 8503/8504，因此预演另起 7898 而不是复用 7896（对 8512 预检实测 `400 Disallowed CORS origin`）。

### 7.2 API 冒烟（`api_smoke.py`，**10/10 PASS**，14:53:41）

| # | 腿 | 状态 | 判据 |
|---|---|---|---|
| 1 | 创建会话 | 201 | `session_ref.kind=global` |
| 2 | 列表含新会话 | 200 | `session_id` 在响应体 |
| 3 | 读 editor-state | 200 | 含 `editor_revision/editor_state/editor_intent_hash/capabilities` |
| 4 | 保存（PUT） | 200 | revision 递增 |
| 5 | 同 mutation 重放 | 200 | 幂等 |
| 6 | CAS 冲突 | **409** | `detail.code=editor_revision_conflict` |
| 7 | 发送 POST /chat | **202** | `content-type: application/json` |
| 8 | 绑定 SSE（同 body + `Last-Event-ID:0`） | **200** | `text/event-stream`，events `usage/thinking/answer/citation/usage/done` |
| 9 | 查回 submission | 200 | `acceptance_state=terminal` |
| 10 | 刷新恢复（新连接重读列表 + editor-state） | 200 | 会话在列表、draft 仍在 |

> 过程中暴露 2 个**探针自身**的缺陷（非产品缺陷）：① draft 与 wire `query` 不一致触发真实 `409 session_context_changed`（编辑器意图哈希契约生效，属正确行为）；② 查回路径应按 `draft_token` 而非 `Location`，产品无 `Location` 头（前端也是按 token 查回）。两者已修在探针里，记录以防误判为缺陷。

### 7.3 UI 冒烟（生产构建 + 真实 Chromium，**8/8 PASS**，45 次 research API 调用，0 console error）

| # | 腿 | 结果 |
|---|---|---|
| 1 | host↔iframe token 握手（`research-v0` ready→token） | PASS |
| 2 | iframe bootstrap（8 类 research API 全 200） | PASS |
| 3 | 新建会话 + 输入草稿 | PASS |
| 4 | **刷新后草稿恢复**（`chat-input` 回填 `2+3 等于几？只回答数字`，13 字符） | PASS |
| 5 | 发送按钮可用 | PASS |
| 6 | **`POST /chat` 202 → 同 URL 200 SSE** | PASS |
| 7 | 终态渲染（Submitted/Usage） | PASS |
| 8 | 发送后再刷新仍可恢复会话 | PASS |

证据：`b5_evidence/ui_smoke.json`、`b5_evidence/ui_send_1440.png`、`b5_evidence/ui_reload_1440.png`、`b5_evidence/api_smoke.json`。

### 7.4 预演结论

- **同版本可用**：生产候选后端代码 + 生产 standalone 前端构建在隔离 PG/Surreal + 本机 SGLang 上跑通“创建→编辑→保存（含幂等/冲突）→发送 202→SSE 200→查回→刷新恢复”全链，UI 无 console error。
- **limited**：① 非生产（隔离 DB/临时端口）；② 前端为 `next build` standalone，不是 OCI 镜像；③ 本地模型回答被证据一致性闸门拦截为 degraded（终态成立，非正常综合答案）；④ 生产 7890→7891 反代与 7800 nginx 未在预演中复现（后端 15:19 被停，无法取样）。

---

## 8. GAP 列表

| # | GAP | 影响 | 处置/所需 |
|---|---|---|---|
| **G1** | **生产代码未记录漂移 94 commits**（`622a43e2` → `45de492e`，含 10 个 research/api 文件） | 第二批 B5 的“已部署 SHA”事实失效；无人能说清当前在生产跑的是哪个版本 | **需负责人裁决**：回退重走 B5，或把 `45de492e` 追认为正式基线并补记录 |
| **G2** | **`RDLENS_RESEARCH_SESSION_CONTRACT` 未开** | 第三批前端上线后 `capabilities.sessions=false`，新协议会话只读/禁发；`chat/sessions*` 全是 404 | 开 flag + 重启（D1），**必须在换镜像前或同窗口** |
| **G3** | **临时 drop-in `zz-c05-acceptance.conf` 已被外部删除**（14:54 新增 → 16:13 已不存在），`RESEARCH_C05_SCOPE_ENABLED` 从 true 回落到 **off** | C-05 资料范围契约在生产失效；带 `X-Research-Contract: c05-v1` 的请求会得 426 | 授权窗口内把 `RESEARCH_C05_SCOPE_ENABLED=true` 写入 `research-preview.env`（正式渠道）后重启；不要再依赖 drop-in |
| **G4** | **新前端镜像未构建**（`rdlens.30` 不存在） | 生产 iframe 仍是 101 commits 前的构建，第三批 UI 不会上线 | 发布窗口内构建+推+锁 digest+改 compose+回填 5 处台账 |
| **G5** | **生产启停被多会话争用**（本窗口 14:54/15:08/15:19 三次外部动作） | 无法取得稳定窗口；E14 无法成立 | 需负责人协调独占窗口 |
| **G6** | 24h 观察 E14 连续 2 次 INVALID | B5 停在 `DEPLOYED / PENDING-OBSERVATION` | 第 3 次窗口（硬约束：窗内不停服，+12 h 中途复检） |
| **G7** | 书面审批 / 变更单 / 通知对象三项仍未闭合（第二批遗留） | 流程门禁不满 | 负责人裁决补记（可在 #602 下补窗口计划评论作为变更记录） |
| **G8** | `next build` 警告 multiple lockfiles（`~/pnpm-lock.yaml`） | 构建根推断可能非预期；本机产出正确但换机可能出错 | 建议 CI 显式设 `turbopack.root`（不属本任务改动范围） |
| **G9** | 生产 CORS=`7800`、镜像内 gateway=`7890`、CSP `frame-ancestors=7890` | 三处 origin 不同源但实测均可用（`7800` 预检 200、`7890` 反代）；改动任一都需同步 | 换镜像时保持这三个值不变，或同步改三处 |
| **G10** | 未跑全量 `tests/research` | 只有局部绿 | 不宣称整体通过；发布前如需可指定范围补跑 |

---

## 9. 阻塞项与最小所需信息

**状态：可切换，但 blocked on 以下 4 项（任一未满足都不得开工）**

1. **独占维护窗口 + 启停授权**：需明确时间窗（建议 ≥ 60 min）与“窗内其他会话不得 `systemctl`/重启/写生产”。当前无法保证（15:19 仍被外部 stop）。
   - 最小信息：窗口起止时间、授权人、窗内禁操确认。
2. **G1 裁决**：`45de492e` 是“当前生产基线”还是“需回退到 `622a43e2`”。
   - 最小信息：一句话裁决 + 回退时的可接受数据影响。
3. **镜像发布授权**：是否在本窗口构建/推送 `rdlens.30`（需要 GHCR push 凭据与台账更新责任）。
   - 最小信息：构建执行人、push 权限、digest 回填责任人。
4. **书面审批 / 变更单号**（G7）：第二批遗留三项，若要闭合需负责人指定工单形式。

> 以上 1–4 之外的准备工作**已就绪**：preflight 通过、备份工具齐备、构建与预演通过、切换 checklist 与回滚步骤已成文。

### 9.1 必须由用户提供的三项（缺一不得开工）

| # | 项 | 需要的具体信息 | 当前状态 |
|---|---|---|---|
| 1 | **独占维护窗口 + 启停授权** | 窗口起止时间（建议 ≥ 60 min）、授权人、窗内"其他会话不得 `systemctl`/重启/写生产"的确认 | **缺**。生产在本任务窗口内被外部会话 14:54 start → 15:08 restart → **15:19 stop**（见 §3.1，证据时间点）；无独占性 |
| 2 | **书面审批 / 变更单** | 书面审批人或变更单/工单号（第二批遗留仅口头授权） | **缺**。未开单、未通知 |
| 3 | **备份责任人** | 指定执行备份并核对 sha256/字节数、并在回滚时决策恢复点的人 | **缺**。第二批裁决为"单人运维、执行人自担"，本次未指定 |

> 另外两项需 Lead/负责人裁决（非用户信息，但同样阻塞）：**G1 版本漂移裁决**（`45de492e` 追认 vs 回退 `622a43e2`）、**镜像发布授权**（构建/推 `rdlens.30` 的执行人与 GHCR push 权限）。


---

## 9.2 可切换步骤（授权后按序执行，命令已就绪）

1. **取窗口**：确认 §9.1 三项 + G1 裁决；`b5_deploy_window.sh preflight --deploy-sha <目标SHA>`（已对 `fabfeed0` 验证 exit 0）。
2. **备份**：Surreal 整 namespace 导出 + `pg_dump`（同一时点），记录 sha256 与字节数；口令文件 `…/surreal_backups/.backup_passphrase`（0600）已就绪。
3. **开 flag（先于镜像）**：`RDLENS_RESEARCH_SESSION_CONTRACT=true` 写入 `research-preview.env`；把 `RESEARCH_C05_SCOPE_ENABLED` 从临时 drop-in `zz-c05-acceptance.conf` 并入正式渠道后删 drop-in + `daemon-reload`；三来源复查无遗漏（G2/G3）。
4. **切后端**：停服 → 切 SHA（或确认 `45de492e` 为基线）→ `uv sync` → `migrate --apply` → `migrate --check`（预期 PG 34 / Surreal 11）→ 启动。
5. **验证后端**：`/health` 200、`/v1/research/health` `{"enabled":true,"status":"ready"}`、`projects/*/chat/sessions` 不带 token 应为 **401（路由已注册）而非 404**。
6. **换前端镜像**：构建 `rdlens.30`（§4.1 冻结参数）→ 推 GHCR → 锁 digest → 改 `deploy/research/compose.yaml` → `docker compose up -d open_notebook` → 回填 5 处台账。
7. **冒烟**：复用 `api_smoke.py`（10 腿）与 `ui_final.js`（8 腿）口径指向 7891/7800/7890；再补旧路径回归（旧 global/source detail 200）。
8. **24h 观察（E14 第 3 次）**：窗内不停服，+12 h 复检 `systemctl is-active`/`uptime -s`。
9. **归档**：证据 + §12 签收；回滚按 §5.2（同二进制 + flag off，不 down migration）。

---

## 10. 本任务边界声明

- **未改动生产**：未写/删 `/etc/systemd/system/rdlens.service*`、未改 `research-preview.env`/`.env`/`settings.yaml`、未 `systemctl start|stop|restart`、未写生产 PG/Surreal。
- **未重启** 7896 / 8503 / 8504；未改其配置。
- **未构建/推送** OCI 镜像；未合并 PR；未关闭 issue。
- 生产上 14:54–15:19 的启停与 drop-in **由其他会话执行**，本任务只做只读采样并如实记录。
- 未写 token / 密钥 / JWT / 真实内容；预演内容为合成文本。

## 11. 证据索引

| 文件 | 内容 |
|---|---|
| `b5_evidence/frontend_build.log` | `npm run build` 完整输出（exit 0，Next 16.2.6，16/16 页）——**本地产物，`.gitignore` 的 `*.log` 排除，不入库**；关键摘要已内联到 §2.1 |
| `b5_evidence/tsc.log` | `tsc --noEmit`（0 行输出，exit 0）——本地产物，不入库 |
| `b5_evidence/vitest.log` | 4 文件 / 87 用例通过——本地产物，不入库（摘要见 §2.1） |
| `b5_evidence/api_smoke.json` | 10 腿 API 冒烟（含每腿状态码与判据） |
| `b5_evidence/ui_smoke.json` | 8 腿 UI 冒烟（含 45 次 research API 调用、console error=0） |
| `b5_evidence/ui_send_1440.png`、`ui_reload_1440.png` | 发送后 / 刷新后截图 |
| `b5_evidence/E01_git_baseline.log`、`E02_frozen_contract.log`、`E03_unit_hashes.log` | preflight 只读核对证据——**本地产物**；`*.log` 被 `.gitignore` 排除，且 E02/E03 含非凭证 64-hex digest 会触发 secret-scan R1，故不入库。关键值：E01 = 生产 `45de492e` / 部署 SHA `fabfeed0`；E02 = 冻结 JSON `03eaf56e…24c73f`（140,644 B）；E03 = 4 个 unit 文件 sha256（见 §6.1） |
| `b5_deployment_readiness.json` | 机器可读摘要（版本、构建、flag、GAP、阻塞项） |

---

## 12. 人工签收（授权窗口填）

| 项 | 负责人 | 时间 | 结论 | 备注 |
|---|---|---|---|---|
| 独占窗口与启停授权 | | | ☐ 批准 / ☐ 拒绝 | |
| G1 版本漂移裁决（`45de492e` 追认 / 回退 `622a43e2`） | | | ☐ 追认 / ☐ 回退 | |
| 书面审批 / 变更单号 | | | ☐ 已开单 | 单号： |
| 备份执行人 + 回滚决策人 | | | ☐ 已指定 | |
| 镜像 `rdlens.30` 构建/推送授权 | | | ☐ 批准 / ☐ 拒绝 | |
| 部署执行与结果 | | | ☐ 完成 / ☐ 部分 / ☐ 失败 | |
