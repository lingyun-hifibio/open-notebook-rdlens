# PR-6 环境快照（2026-10-27，真实查询）

原始输出：[`raw/env_snapshot_20261027.txt`](raw/env_snapshot_20261027.txt)、[`raw/gateway_probes_20261027.txt`](raw/gateway_probes_20261027.txt)。

## 1. 代码基线

| 项 | 值 | 命令 |
|---|---|---|
| fork（实施仓）HEAD | `404c0e227ae34148b26f95a1471cebde8d52d112` | `git rev-parse HEAD` |
| 分支 | `feat/issue602-b3-pr6`（tracking `origin/main`） | `git branch --show-current` |
| RDLens 主仓 HEAD | `3620c9c1d741cb9173e7355f8c6a23b609f48687`（2026-10-26 15:25，含第二批 PR-1…PR-10） | `git -C /home/lchen/workspace/RDLens rev-parse HEAD` |
| 部署 fork 前端镜像 | `ghcr.io/hifibio-therapeutics/open-notebook-rdlens@sha256:1041c88e9a9abe017eb7982825f4f0b3236c369054aa9c9a9a2028cd05ebe4dc`（tag `v1.14.0-rdlens.29`，构建 **2026-10-22 01:32**） | `docker inspect` |
| 部署容器 | `research-open-notebook-open_notebook-1`（Up 29h, healthy；`127.0.0.1:5055` API / `8502` 前端） | `docker ps` |

> 部署镜像构建于 2026-10-22，**早于 PR-5b（2026-10-27 合并）**，本身不含本批前端改动；仅用于证明“第二批真实接入不可用”的环境事实。

## 2. Gateway / 入口

| 入口 | 实测 | 说明 |
|---|---|---|
| RDLens 后端 systemd `rdlens.service` | `ActiveState=inactive`、`SubState=dead`（上次启动 2026-10-26 09:17:39） | `systemctl show rdlens.service` |
| `http://127.0.0.1:7891/health`（生产 unit loopback） | `connection refused`（curl exit 7 / http 000） | 后端未运行 |
| `http://127.0.0.1:7892/health`（HTTP 回退 upstream） | `connection refused` | 后端未运行 |
| `http://192.168.5.82:7890/health` | `502 Bad Gateway`（nginx 监听、上游 dead） | 对外入口不可用 |
| `http://192.168.5.82:7800/` / `127.0.0.1:8502/` | `307 → /notebooks`（fork/ON 前端可达） | 只有前端，没有第二批 API |
| `http://127.0.0.1:5055/health` | `200 {"status":"healthy"}` | ON embedded API（非 RDLens `/v1/research/*`） |

## 3. flag / 能力开关（默认关闭，未注入真实环境）

| 项 | 实测 | 命令 |
|---|---|---|
| `RDLENS_RESEARCH_SESSION_CONTRACT`（第二批 session 契约开关） | 已安装 unit **0 处**；`/home/lchen/workspace/RDLens/.env` 未设置；`deploy/research/compose.yaml` **0 处**；代码 `env_bool(SESSION_CONTRACT_FLAG)` 默认 `False` | `systemctl cat rdlens.service \| grep -c …`；`grep -E '^RDLENS_RESEARCH_SESSION_CONTRACT' .env`；`grep -c … compose.yaml`；`src/rdlens/research/session_protocol.py` |
| `research.enabled` | `settings.yaml:666` → `false` | `grep -n "enabled:" settings.yaml` |
| `research_contract_v1_enabled` | `false` | 同上（`settings.yaml:698`） |
| `research_external_llm_enabled` | `false` | 同上（`settings.yaml:699`） |
| 部署文档状态 | B5 = `DEPLOYED / PENDING-OBSERVATION`；生产 **flag off**；24h 观察未闭环；flag-on 启用属 §11.2 后续步骤（未执行） | `dev_docs/plans/issue602_batch2_deployment_checklist_20261022.md` §0.1 |

## 4. 模型 / 预算（部署 ON 容器 env，仅记录不用于外发）

| 项 | 值 |
|---|---|
| `RD_AI_GATEWAY_MODEL` | `rdlens-research-engine`（固定） |
| `RD_AI_GATEWAY_URL` | `http://192.168.5.82:7890`（当前 502） |
| `RD_EMBEDDED_MODE` | `true` |
| 预算配置 | 未能查询（Gateway 未运行、需认证）；未发起任何模型调用 |
| 项目 / owner | 未能查询（Gateway 未运行、`/api/health` 需认证）；未接触真实私有会话 |

## 5. 结论

第二批接口在当前环境**不可验证**：Gateway 进程未运行（7891/7892 refused、7890 502）+ session contract flag 默认 off 且未启用 + `research.enabled=false` + 部署前端早于本批。按 cards/PR-6 停止条件：真实接入腿全部 `pending`/`excluded`，**不部署、不改 flag、不伪造 pass**；第三批出口保持未完成。
