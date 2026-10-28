# B5：第二批真实可用部署确认与环境固化（隔离验证环境）

- **日期**：2026-10-28（取证窗口 11:14–11:38 CST）
- **证据级别**：`isolated real deployment`（真实 HTTP 服务 + 真实 PostgreSQL/SurrealDB + 本地 SGLang + 真实 Chromium bootstrap）；**不是生产部署**。
- **结论**：隔离环境已固化为「指定验证部署」，可作为 DESIGN §10.4「第二批可用构建/部署」的**隔离环境证据**（limited：非生产、前端为 dev server、Surreal ns/db 存在偏差，见 §7/§9）。**生产 B5 未执行**，需用户单独授权（见 §8）。
- **任务**：#602 第三批 6b 收口 / task-13；本文件为唯一部署记录（另有脱敏机器摘要 `deployment.json`）。

---

## 1. 版本与 SHA

| 组件 | 版本 / SHA | 取证方式 |
|---|---|---|
| RDLens 后端（运行中 Gateway 7896） | **`3620c9c1d741cb9173e7355f8c6a23b609f48687`**（detached HEAD，工作树干净） | 进程 `cwd=/home/lchen/workspace/RDLens-issue602-b3`；`PYTHONPATH=/home/lchen/workspace/RDLens-issue602-b3/src`；`git -C … rev-parse HEAD` |
| RDLens 主仓当前 HEAD | `92ae0c09f95338a967b3e078104af3c3f19d5149`（比隔离 worktree 新，**未被本次验证使用**） | `git -C /home/lchen/workspace/RDLens rev-parse HEAD` |
| fork 证据 worktree（本文件所在） | HEAD `8226f12564569c91df1afca82e3cb79f4bea0e50`，分支 `feat/issue602-b3-remaining-evidence` | `git rev-parse HEAD` / `git branch --show-current` |
| fork 交付基线 | `origin/main = 8226f12564569c91df1afca82e3cb79f4bea0e50`（PR-1…PR-12 + 证据 PR-85 的合并线）；本地 `main` 分支为旧上游线 `7c99dff`，未用于本证据 | `git rev-parse origin/main` / `git rev-parse main` |
| 前端 8503（运行中） | `next-server v16.2.6`（`next dev -p 8503`），worktree `.worktrees/batch3-pr12` @ `92be0401d5357b17171f07158f008bb5ed61bfbf`，分支 `feat/issue602-b3-pr12` | 进程 cmdline/cwd + `git rev-parse HEAD` |
| Host 8504 | `/tmp/rdlens-issue602-b3/host_server.py`（Python `ThreadingHTTPServer`，监听 `127.0.0.1:8504`） | 进程 cmdline/cwd |
| 本地模型 | SGLang `Qwen3.8-27B`（`max_model_len=131072`，`--tp-size 2`，`0.0.0.0:9999`） | `GET 127.0.0.1:9999/v1/models` |
| PG | 容器 `rdlens-issue623-s3-pg`（`postgres:16`，`127.0.0.1:5436`），库 `knowledge_os_issue602_b3` | `docker ps` + `psql`（只读） |
| SurrealDB | 容器 `rdlens-issue623-s3-surrealdb`（`surrealdb/surrealdb`，`127.0.0.1:18004`），`surrealdb-2.6.5` | `docker ps` + `GET /version` |

运行时长（取证时）：Gateway 8h29m（启动 2026-10-28 02:55:54）；前端 8h59m（02:26:16）；Host 16h41m（2026-10-27 18:43:37）；SGLang 24m（11:00:31，重启过）。

---

## 2. 启动命令（脱敏，可复用；不含 token/密钥）

### 2.1 后端 Gateway（7896，隔离 worktree）

```bash
cd /home/lchen/workspace/RDLens-issue602-b3
export PYTHONPATH=/home/lchen/workspace/RDLens-issue602-b3/src
export RESEARCH_ENABLED=true
export RESEARCH_CONTRACT_V1_ENABLED=true
export RDLENS_RESEARCH_SESSION_CONTRACT=true
export RESEARCH_C05_SCOPE_ENABLED=true
export RESEARCH_DOCUMENT_WORKSPACE_CONTEXT_ENABLED=true
export RESEARCH_EXTERNAL_LLM_ENABLED=false
export RESEARCH_CORS_ALLOWED_ORIGINS='http://127.0.0.1:8503,http://127.0.0.1:8504'
export RDLENS_PG_DSN='postgresql://<user>:<redacted>@127.0.0.1:5436/knowledge_os_issue602_b3'
export RDLENS_REDIS_URL='redis://localhost:6379/2'
export RESEARCH_SURREAL_URL='http://127.0.0.1:18004'
export RESEARCH_SURREAL_USER='s3_owner'
export RESEARCH_SURREAL_PASSWORD='<redacted>'
export RESEARCH_JWT_SECRET='<redacted>'
/home/lchen/workspace/RDLens/.venv/bin/python -m uvicorn rdlens.api.app:create_app \
  --factory --host 127.0.0.1 --port 7896 --proxy-headers
```

- 上述 env 由 Lead 启动时经 shell 注入（实测读取 `/proc/1862101/environ` 白名单字段）；`RDLENS_PG_DSN`、`RESEARCH_SURREAL_PASSWORD`、`RESEARCH_JWT_SECRET` 的值**不落盘**，本文只记“已配置”。
- 进程未注册 systemd unit；由 Lead 会话进程直接拉起（PPID 为 `dsh web`）。

### 2.2 前端（8503，dev server）

```bash
cd /home/lchen/workspace/open-notebook-rdlens/.worktrees/batch3-pr12/frontend
node node_modules/.bin/next dev -p 8503    # 等价：npm run dev -- -p 8503
```

### 2.3 Host 桥（8504）

```bash
cd /tmp/rdlens-issue602-b3
/home/lchen/workspace/RDLens/.venv/bin/python host_server.py
# host_server.py 读取同目录 app.env（权限 600，含 secret，不纳入证据）；监听 127.0.0.1:8504
```

### 2.4 本地模型（SGLang，9999）

```bash
sglang serve --model-path /mnt/data_ext-disk/lychen/pre-trained_models/QWen/cyankiwi/Qwen3.8-27B-AWQ-INT4 \
  --tp-size 2 --mem-fraction-static 0.90 --context-length 131072 \
  --host 0.0.0.0 --port 9999 --served-model-name Qwen3.8-27B
# 其余量化/调度参数见运行进程 cmdline；无外部模型、无外发凭据
```

### 2.5 依赖服务

- PostgreSQL 5436：容器 `rdlens-issue623-s3-pg`（与 #623 S3 共用，**不得销毁**）。
- SurrealDB 18004：容器 `rdlens-issue623-s3-surrealdb`（与 #623 S3 共用，**不得销毁**）。

---

## 3. 有效 flag（运行时实测，脱敏）

| Flag | 有效值 | 作用 |
|---|---|---|
| `RESEARCH_ENABLED` | `true` | 注册 `/v1/research/*`、装配 ResearchService |
| `RESEARCH_CONTRACT_V1_ENABLED` | `true` | 第二批生成契约（contract v1）门禁 |
| `RDLENS_RESEARCH_SESSION_CONTRACT` | `true` | 第二批 session 契约（`research-session-v1`） |
| `RESEARCH_C05_SCOPE_ENABLED` | `true` | C-05 资料范围契约 |
| `RESEARCH_DOCUMENT_WORKSPACE_CONTEXT_ENABLED` | `true` | document/workspace context level |
| `RESEARCH_EXTERNAL_LLM_ENABLED` | `false` | **外部模型关闭**；仅本地模型 |
| `RESEARCH_CORS_ALLOWED_ORIGINS` | `http://127.0.0.1:8503,http://127.0.0.1:8504` | iframe 精确 origin |
| `RDLENS_PG_DSN` | `postgresql://<redacted>@127.0.0.1:5436/knowledge_os_issue602_b3` | 隔离 PG |
| `RDLENS_REDIS_URL` | `redis://localhost:6379/2` | Redis DB 2（未单独验证，见 §9） |
| `RESEARCH_SURREAL_URL` / `_USER` | `http://127.0.0.1:18004` / `s3_owner` | 隔离 Surreal |
| `RESEARCH_JWT_SECRET` | 已配置（值不记录） | Research Token 签发/校验 |

> 说明：隔离 worktree 的 `settings.yaml` 仍是仓库默认（`research.enabled: false`、`research_contract_v1_enabled: false`），有效 flag 来自**环境变量覆盖**；这是隔离验证的启动方式，不代表生产配置。

### 生产当前事实（只读，未改动）

| 项 | 实测 |
|---|---|
| `rdlens.service` | `ActiveState=inactive`、`SubState=dead`、`UnitFileState=enabled`（未启动） |
| 生产 `src/rdlens/config/settings.yaml` | `research.enabled: false`（L679）、`feature_flags.research_contract_v1_enabled: false`（L711）、`research_external_llm_enabled: false`（L712） |

---

## 4. 健康检查与原始输出（脱敏）

### 4.1 Gateway

```text
GET http://127.0.0.1:7896/health
HTTP=200
{"status":"ok"}

GET http://127.0.0.1:7896/v1/research/health
HTTP=200
{"enabled":true,"status":"ready"}

GET http://127.0.0.1:7896/v1/research/workspace-status
HTTP=200
{"workspace_v2_enabled":false}

GET http://127.0.0.1:7896/v1/research/projects/demo/sources   # 未带 Research Token
HTTP=401
{"detail":"research token required"}

OPTIONS /v1/research/health   Origin: http://127.0.0.1:8503
HTTP/1.1 200 OK
access-control-allow-origin: http://127.0.0.1:8503
access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT
access-control-allow-headers: authorization
```

- `status=ready` 的语义来自 `ResearchService.health_status()`：`enabled=true` 且（未配置 `open_notebook_url` 或已配置 adapter token）即为 ready；**它不探测 PG/Surreal 存活**。DB 可达性由 §5 独立验证。
- `/workspace-status` 返回 `false` 属预期（V2 曝光开关默认关闭，不影响第二批 API）。

### 4.2 前端 8503 / Host 8504

```text
GET http://127.0.0.1:8503/          → HTTP=307，Location: /notebooks
GET http://127.0.0.1:8503/research  → HTTP=200，Content-Type: text/html; charset=utf-8，34,029 bytes，<title>Open Notebook</title>

GET http://127.0.0.1:8504/          → HTTP=200，text/html，B3 Host（iframe src=http://127.0.0.1:8503/research）
GET http://127.0.0.1:8504/token     → HTTP=200，application/json；keys=[expires_at, token]（token 值不记录）
```

### 4.3 真实浏览器 bootstrap（Chromium headless，1440×950）

```json
{
  "host_ready": true,
  "host_last_message_type": "ready",
  "iframe": { "src": "http://127.0.0.1:8503/research", "url": "http://127.0.0.1:8503/research", "title": "Open Notebook" },
  "console_errors": [],
  "ui": {
    "testids_sample": ["research-header","header-current-scope","research-scope-summary","research-context-scope","research-session-nav","session-switcher-global","session-switcher-trigger","session-switcher-current","session-switcher-new","legacy-session-content","research-layout","research-scope-editor","workbench-group-nav"],
    "body_excerpt": "Entire project Edit scope Qwen3.8-27B Local · Local Activity Export research artifacts Chat Sessions New conversation New session Open a source to start a conversation RESEARCH SCOPE Entire project Selected sources and notes",
    "buttons": 23
  }
}
```

- Host 收到 iframe `ready` 后经 `/token` 签发 Research Token 并 postMessage；前端进入已认证研究页（模型显示 `Qwen3.8-27B Local`，与 9999 本地模型一致；`RESEARCH_EXTERNAL_LLM_ENABLED=false` 生效）。
- 同一次 bootstrap 捕获的 `/v1/research/*` 调用（全部 `200`，无 3xx/4xx/5xx，无外部域名调用）：

```text
GET /v1/research/projects/<synthetic_project>/models
GET /v1/research/projects/<synthetic_project>/execution-preferences
GET /v1/research/projects/<synthetic_project>/jobs?limit=100
GET /v1/research/projects/<synthetic_project>/chat/sessions?kind=all&limit=1
GET /v1/research/projects/<synthetic_project>/chat/sessions?kind=all&limit=20
GET /v1/research/projects/<synthetic_project>/external-egress-consent
GET /v1/research/projects/<synthetic_project>/notes?limit=100
GET /v1/research/projects/<synthetic_project>/sources?limit=100
（共 10 次请求，去重后 8 类；全部 200）
```

- 项目为合成种子（`usr_1_…` 哈希形式），未使用真实项目内容。

### 4.4 本地模型

```text
GET http://127.0.0.1:9999/v1/models
HTTP=200
{"object":"list","data":[{"id":"Qwen3.8-27B","max_model_len":131072,"owned_by":"sglang"}]}
```

---

## 5. PostgreSQL / SurrealDB（只读实测）

### 5.1 PostgreSQL

```text
pg_isready -h 127.0.0.1 -p 5436 -d knowledge_os_issue602_b3
127.0.0.1:5436 - accepting connections

psql（凭据取自运行进程 env，未落盘）：
current_database=knowledge_os_issue602_b3 | current_user=admin | public tables=44
```

### 5.2 SurrealDB

```text
GET http://127.0.0.1:18004/version
HTTP=200
surrealdb-2.6.5

INFO FOR DB（rdlens_research / research_artifacts）→ 200，已有 rdlens_artifact / rdlens_chat_input 等研究表（SCHEMAFULL）
INFO FOR DB（rdlens_research_602 / research_artifacts_602）→ 200，tables={}（空）
```

- **实际生效的 ns/db = 默认值 `rdlens_research` / `research_artifacts`**：运行进程 env 无 `RESEARCH_SURREAL_NAMESPACE/DATABASE` 覆盖，隔离 worktree `settings.yaml` 也是默认值；任务简述中的 `rdlens_research_602/research_artifacts_602` 虽已创建但为空、未被本 Gateway 使用。
- 该项为**环境偏差**，需 Lead 确认：若 B5 要求 `_602` 隔离库，需以正确 override 重启 Gateway（本任务未改、未重启）。

---

## 6. 回滚方式（未执行；仅记录）

1. **生产**：本任务未改生产 flag、未启停 `rdlens.service`、未写生产数据 → **无需回滚**；如后续获授权做生产 B5，按 `deploy/research/PRD_runbook` §10 执行，回滚为恢复 `research.enabled=false`/`research_contract_v1_enabled=false` 并重启服务。
2. **隔离 Gateway 7896**：`kill 1862101`（Lead 会话进程子进程，未注册 systemd）；重启即重新执行 §2.1。
3. **隔离前端 8503**：`kill 1419847`（父进程 `next dev` 1419788）；重启执行 §2.2。
4. **Host 8504**：`kill 2534192`；重启执行 §2.3。
5. **DB 容器**：`rdlens-issue623-s3-pg` / `rdlens-issue623-s3-surrealdb` 与 #623 S3 共用，**不得销毁/清空**；本次未写入产品数据（种子为合成）。
6. **代码**：RDLens 隔离 worktree detached `3620c9c1` 且干净；fork 证据分支仅本目录文档变更，未 commit/push（按 Lead 指令）。

> 本任务**不执行**任何回滚动作（Lead 明确 7896/8504 由 Lead 运行，不得停止）。

---

## 7. 该环境能否作为 §10.4「第二批可用构建/部署」证据

**可以，但仅限隔离环境证据（`isolated real deployment`，limited）**：

- 支持点：后端为真实进程、真实 `3620c9c1` 代码（PYTHONPATH 指向该 worktree）；`/v1/research/health` `enabled=true,status=ready`；session/contract/C-05 flag 在运行时为 true；真实 PG（44 表）与 Surreal（研究表存在）；真实 Chromium 完成 host→iframe token 握手并渲染研究页；bootstrap 期间 8 类 research API 全部 200；本地 Qwen3.8-27B 生效且外部模型关闭。
- 限制：①**非生产**（生产 service inactive、生产 flag false，未执行 B5）；②前端是 `next dev`（PR-12 worktree），不是生产构建产物；③Surreal 实际使用默认 ns/db，`_602` 库为空（偏差）；④`/v1/research/health` 不探测 DB 存活，DB 证据来自独立只读查询；⑤未验证 Redis DB 2。
- 因此：可作为 6b「隔离真实环境可用」与 B5 环境固化的证据；**不能**据此宣称「生产第二批可用构建/部署」已完成。

---

## 8. 生产未执行声明

- `rdlens.service`：`inactive/dead`，**未启动、未重启**。
- 生产 `settings.yaml`：`research.enabled=false`、`research_contract_v1_enabled=false`、`research_external_llm_enabled=false`，**未修改**。
- 未修改生产 flag/部署配置/生产数据；未接触真实项目内容；未使用外部模型；未外发任何内容。
- 生产 B5 属独立部署动作，**需用户单独授权**；本任务输出为隔离环境固化记录（`limited`），不伪造生产 pass。

## 9. 剩余限制与待确认

1. Surreal ns/db 偏差（`rdlens_research/research_artifacts` vs 任务简述 `_602`），需 Lead 确认是否要求 `_602` 隔离；若要求，需授权后重启 Gateway。
2. 前端为 `next dev`（非生产构建）；生产可用构建需另行构建/部署与授权。
3. Redis DB 2 未单独验证（环境无 `redis-cli`）。
4. fork `main` 实测 `7c99dff`，与 Lead 口述 `8226f12` 不一致（8226f12 为证据分支 HEAD）；已按实测记录。
5. 本次证据均为隔离环境；生产 B5 状态仍为「未执行 / 待授权」。

---

## 10. 取证命令摘要（可复现）

```bash
# 版本
git -C /home/lchen/workspace/RDLens-issue602-b3 rev-parse HEAD
git -C /home/lchen/workspace/open-notebook-rdlens/.worktrees/batch3-pr12 rev-parse HEAD
# 进程/端口
ss -ltnp | grep -E ':(7896|8503|8504|5436|18004|9999)\b'
# 健康
curl -sS http://127.0.0.1:7896/health
curl -sS http://127.0.0.1:7896/v1/research/health
curl -sS http://127.0.0.1:7896/v1/research/workspace-status
# 前端/host
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8503/research
curl -sS http://127.0.0.1:8504/ | head
# 模型
curl -sS http://127.0.0.1:9999/v1/models
# DB（只读；凭据来自运行进程 env，不落盘）
pg_isready -h 127.0.0.1 -p 5436 -d knowledge_os_issue602_b3
curl -sS http://127.0.0.1:18004/version
# 生产只读
systemctl show rdlens.service -p ActiveState -p SubState
grep -n 'research_contract_v1_enabled\|^  enabled: false' /home/lchen/workspace/RDLens/src/rdlens/config/settings.yaml
# 浏览器 bootstrap / API 200 捕获：Playwright chromium headless 访问 8504，等 window.__b3.ready===true
```

> 证据级别：`isolated real deployment`（simulated 之外的唯一真实环境证据）；所有 secret/token/JWT/真实内容均未写入本文件。
