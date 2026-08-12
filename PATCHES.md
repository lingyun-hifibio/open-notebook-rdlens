# Open Notebook Fork Patch 台账（SPK-03）

> Task ID: SPK-03（GitHub Issue #19，repo: HiFiBiO-Therapeutics/RDLens）
> 日期：2026-08-06
> 基准 commit：`30c7e2a6`（上游 v1.14.0，BASE-01 固定）
> 分支：`feat/spk-03-embedded-adapter`
> 责任台账模板见 RDLens `deploy/research/BASELINE.md` §5
>
> 表述说明（2026-08-07）：分支已于 2026-08-06 rebase 至 `a7de90d`（fork main，
> 含 10 个上游 commit）并经 PR #1 合并（merge commit `edd699a`，tag
> `v1.14.0-rdlens.1`）；§2 清单与「基准 commit」仍按决策固定为 `30c7e2a6`——
> Patch 相对上游 v1.14.0 的改动面以该基准计量，rebase 只平移基底不改 Patch 内容。
> 后续修复见 §2.1（PR #2，tag `v1.14.0-rdlens.2`）。

## 1. 目标

在内部 Fork 证明嵌入式模式的禁用边界（Fork 侧）：

- REQ-DIS-01：保存 Source/Note 后无 `embed_note` / `source_embedding`（vectorize）
- REQ-DIS-02：原生 Provider/原生 AI 路径禁用，LLM 固定绑定 Research Gateway，
  词法搜索失败不回退向量搜索
- REQ-DIS-03：Transformation 仅 prompt-only，无代码/工具/URL/市场字段
- REQ-SCOPE-03：全局 Notebook、认证、系统设置、Provider/凭据、媒体、
  直接上传/URL 来源被屏蔽
- REQ-AUTH-03：客户端不能获取或切换非固定 Notebook ID

所有能力默认关闭（`RD_EMBEDDED_MODE` 未启用时完全保持上游行为），
由 RDLens 侧部署通过环境变量开启。

## 2. Patch 清单（相对基准 commit 30c7e2a6）

| 文件 | 类型 | 行数 | 说明 |
|---|---|---:|---|
| `open_notebook/config.py` | 配置 | +13 | `RD_EMBEDDED_MODE` / `RD_EMBEDDED_NOTEBOOK_ID` / `RD_AI_GATEWAY_URL` / `RD_AI_GATEWAY_MODEL` / `RD_AI_GATEWAY_API_KEY`；模块属性调用时读取 |
| `open_notebook/domain/notebook.py` | 行为守卫 | +15 | `Note.save()` 跳过 `embed_note`；`Source.vectorize()` fail-closed（InvalidInputError）；`text_search` 词法失败不再回退向量搜索 |
| `open_notebook/graphs/source.py` | 行为守卫 | +4/-1 | `save_source` 跳过 `source.vectorize()` |
| `open_notebook/ai/gateway.py` | 新增适配器 | +34 | 绑定 Gateway 的 `ChatOpenAI`；未配置 URL 时 `ConfigurationError`（fail-closed） |
| `open_notebook/ai/provision.py` | 行为守卫 | +6 | 嵌入式分支直接返回 Gateway 模型，跳过 `model_manager` 与用户 `model_id` |
| `api/embedded_scope.py` | 新增中间件 | +83 | API 屏蔽矩阵（`is_blocked` 纯函数 + ASGI 中间件，403） |
| `api/main.py` | 注册 | +5 | 最外层注册 `EmbeddedScopeMiddleware` |
| `tests/test_embedded_scope.py` | 测试 | +265 | 12 个边界测试（REQ-DIS-01/02/03、REQ-SCOPE-03、REQ-AUTH-03） |

合计：8 文件，+424/-1 行；**生产代码 6 文件 +160 行**，未改写 Domain/DB/Schema，
零数据库迁移。

### 2.1 SPK-03 修复（2026-08-07，审查发现）

RDLens 侧审查发现：屏蔽矩阵只拦 `POST /api/sources*`，上游存在的
`PUT /api/sources/{id}`、`DELETE /api/sources/{id}` 可绕过，浏览器可改写/删除
RDLens 同步的 Source，违反「来源只读 + RDLens 单写权威」（设计 §5.1）。

| 文件 | 类型 | 行数 | 说明 |
|---|---|---:|---|
| `api/embedded_scope.py` | 行为守卫 | +1/-1 | `/api/sources` 改为仅放行 GET/HEAD/OPTIONS，PUT/DELETE 等一律 403 |
| `tests/test_embedded_scope.py` | 测试 | +6 | 矩阵补 PUT/DELETE 屏蔽断言；新增端到端 403 用例（12 → 13） |

验证：`uv run pytest tests/test_embedded_scope.py -q` 13 passed；
全量 `tests/` 无回归（见 §5 验证记录）。

## 3. 改动边界与成本评估（REQ-POC-02）

- **未触碰**：Domain/DB 数据模型（零迁移）；SurrealDB；前端 Next.js；
  docker-compose.yml（镜像固定由 SPK-01 `deploy/research/compose.yaml` 与 FND-02 负责）。
- 所有守卫为「配置开关 + 2~4 行分支」，默认关闭 → 上游 rebase 冲突面小。
- **rebase 成本估算**：下一小版本预计 ≤ 1 工程日（仅 5 个后端文件 + 2 新模块 + 1 测试文件）。

## 4. 未覆盖 / 待验证项（显式清单）

- **CSP frame-ancestors / postMessage 绑定（REQ-EMB-01）**：RDLens 侧 UI-01 交付；
  Fork 前端 next.config 安全头未改，本 Spike 不验证前端构建。
- **Token 内存生命周期（REQ-EMB-02）**：RDLens 侧 SPK-02 已覆盖 Token 签发/校验/不落存储；
  Fork 前端刷新/登出/销毁消息处理留待 UI-01。
- **端到端 API 网络录制**：Gateway AI 端点未实现（FND-06）；本 Spike 以单元级绑定断言
  （`model.openai_api_base == RD_AI_GATEWAY_URL` 且 `model_manager` 未被调用）代替；
  端到端网络录制在 SPK-04 / GATE-01。
- **内部 Registry**：未就绪（BASELINE.md §4）；SPK-03 为纯代码 Spike，不构建镜像，不阻塞。
- **Fork 公开状态**：`lingyun-hifibio/open-notebook-rdlens` 为 public fork；
  是否迁移 org 私有由负责人决策。

## 5. UI-01 ResearchWorkspaceShell 与安全会话（2026-08-11）

> Task ID: UI-01（GitHub Issue #70，repo: HiFiBiO-Therapeutics/RDLens）
> 分支：`open-notebook-m4-ui-01`；PR：#4
> 设计锚点：设计方案 §3.2、§4.1–§4.3、§15.2、§16.2；契约 v0 §12
> Requirements：REQ-SCOPE-01、REQ-AUTH-01–03、REQ-EMB-01–02、REQ-DEP-02、
> REQ-POC-02、REQ-TST-02

### 5.1 改动清单（仅前端，后端零改动）

| 文件 | 类型 | 说明 |
|---|---|---:|
| `frontend/src/lib/embedded/messages.ts` | 新增 | postMessage v0 契约纯校验器（五要素：origin/source/schema/nonce/channel + 载荷形状；伪造一律返回 null） |
| `frontend/src/lib/embedded/session.ts` | 新增 | 会话状态机 booting→ready→authenticated/error，token/refresh/error/logout/destroy 处理，destroy 终态移除监听 |
| `frontend/src/lib/embedded/token-store.ts` | 新增 | Research Token 纯内存驻留（模块级变量；永不入 Storage/URL/日志） |
| `frontend/src/lib/embedded/config.ts` | 新增 | `NEXT_PUBLIC_RD_EMBEDDED_MODE` / `NEXT_PUBLIC_RD_GATEWAY_URL` / `NEXT_PUBLIC_RD_PARENT_ORIGIN`（默认关闭，语义同后端 `RD_EMBEDDED_MODE`） |
| `frontend/src/lib/embedded/shell.tsx` | 新增 | ResearchWorkspaceShell 三态（加载/错误/就绪）；挂载即 ready 握手；卸载销毁 |
| `frontend/src/lib/embedded/csp.ts` | 新增 | `RD_FRAME_ANCESTORS` → CSP `frame-ancestors` 纯函数（未配置不输出） |
| `frontend/src/app/research/page.tsx` | 新增 | 嵌入式入口路由（非嵌入式模式重定向 /notebooks） |
| `frontend/src/app/page.tsx` | 修改 | 嵌入式模式入口重定向 → /research |
| `frontend/src/app/layout.tsx` | 修改 | 嵌入式模式跳过 ConnectionGuard（SPK-03 屏蔽矩阵 403 `/api/config`） |
| `frontend/src/lib/api/client.ts` | 修改 | 嵌入式适配：baseURL=Gateway、Bearer=内存 Token、401 不跳 /login、Gateway 未配置 fail-closed |
| `frontend/next.config.ts` | 修改 | `headers()` 输出 CSP frame-ancestors |
| `frontend/src/lib/locales/*/index.ts` | 修改 | 14 语言 `research` 文案段 |
| `frontend/src/lib/embedded/*.test.ts(x)`、`frontend/src/lib/api/client.embedded.test.ts` | 测试 | 5 文件 38 测试（伪造消息全拒绝、Token 内存驻留、销毁无残留、Gateway 适配、CSP） |

### 5.2 安全语义（REQ-EMB-01/02）

- ready 由 iframe 生成会话 nonce/channel 并精确 targetOrigin 发送；父页面
  在 token/refresh/error/logout/destroy 中回显；校验失败的任一消息静默拒绝
  （不响应、不落日志正文）。
- Token 只存 `token-store` 模块级内存；刷新替换、登出/销毁清除；apiClient
  仅嵌入式模式读取内存 Token，绝不读 localStorage `auth-storage`。
- 嵌入式模式 401 不跳转 `/login`（会话续期由父页面 postMessage 驱动）。
- 未配置 `NEXT_PUBLIC_RD_GATEWAY_URL` 时请求 fail-closed 拒绝，Token 不
  发往未知基址。
- 未配置 `NEXT_PUBLIC_RD_PARENT_ORIGIN` 时 Shell 进入错误态（不发送 ready、
  不接受任何消息）。

### 5.3 契约适配说明

契约 v0 §12.1 表述 nonce「bootstrap 响应中下发」，但 FND-06 已合并的
bootstrap 响应（契约 §5）无 nonce 字段；本任务采用 iframe 生成 nonce +
channel 并在 ready 中携带、父页面回显的形态（与 §12.2 ready 载荷一致），
不改后端契约。父页面「仅符合条件的项目显示入口」由 RDLens 侧
`authorize_research_project`（FND-06）强制，属 RDLens frontend 交付面，
不在本 PR。

### 5.4 验证

- `cd frontend && npx vitest run`：28 文件 178 passed（含本任务 38 新增，
  基线 140 全绿）
- `npm run lint`：0 errors（7 条 pre-existing warnings）
- `npm run build`：通过，含 `/research` 路由与 CSP headers

### 5.5 未覆盖 / 后续

- 业务面板（Sources/Notes/Insights/Transformation/Chat 等）由 UI-02/03 交付。
- 非 research 路由在嵌入式模式下的前端禁用矩阵（UI 不可见）属 UI-02
  REQ-SCOPE-03 范围；后端 403 由 SPK-03 屏蔽矩阵已覆盖。
- 父页面（RDLens 主页面 iframe 嵌入 + bootstrap + 消息发送端）实现落
  RDLens frontend，Issue #70 统一追踪。
- Playwright 未在本 Fork 前端配置；以 jsdom 真实 MessageEvent 管线（组件级
  dispatch → 会话校验）作为等价安全 E2E。

## 6. UI-02 Sources、Citation 与 Artifact 工作台（2026-08-11）

> Task ID: UI-02（GitHub Issue #71，repo: HiFiBiO-Therapeutics/RDLens）
> 分支：`open-notebook-m4-ui-02`（基于 `open-notebook-m4-ui-01` / PR #4）；PR：#5
> 设计锚点：设计方案 §2.1、§4.4、§5.3、§6、§8、§9.1/§9.2、§12、§15.2
> Requirements：REQ-SCOPE-03–04、REQ-SRC-04–05、REQ-DATA-03–04、REQ-API-01、
> REQ-DIS-01–03、REQ-POC-02

### 6.1 改动清单（仅前端，后端零改动）

| 文件 | 类型 | 说明 |
|---|---|---:|
| `frontend/src/lib/embedded/claims.ts` | 新增 | Research Token claims 纯函数解码（project_id/role/scopes；契约 v0 §4.1；fail-closed，非法 claims 返回 null） |
| `frontend/src/lib/embedded/session.ts` | 修改 | authenticated 状态携带 projectId/role（claims 非法 → error session_invalid，不驻留 Token） |
| `frontend/src/lib/embedded/workspace-context.tsx` | 新增 | 工作台上下文（Shell 认证后注入 projectId/role；无 Provider 抛错 fail-closed） |
| `frontend/src/lib/embedded/routes.ts` | 新增 | 非 research 路由禁用矩阵纯函数（REQ-SCOPE-03） |
| `frontend/src/components/embedded/EmbeddedRouteGuard.tsx` | 新增 | 导航守卫：嵌入式模式非 research 路径重定向 /research（dashboard 布局 + login 页） |
| `frontend/src/lib/types/research.ts` | 新增 | Gateway 契约类型（契约 v0 §6/§7/§13.2；page_idx 0-based） |
| `frontend/src/lib/research/api.ts` | 新增 | Gateway API 模块（全部经 apiClient；路径精确匹配白名单，无 /api 前缀） |
| `frontend/src/lib/hooks/use-research.ts` | 新增 | 项目级 hooks（查询键隔离；403 → toast 呈现） |
| `frontend/src/components/research/*` | 新增 | CitationCard（失效降级）、SourceList/SourceDetail、Notes/Insights/Transformations、ExportSection、ResearchWorkbench、AdminReadOnlyBanner、citation-utils |
| `frontend/src/app/research/page.tsx` | 修改 | Shell 就绪后渲染 ResearchWorkbench |
| `frontend/src/app/(dashboard)/layout.tsx`、`frontend/src/app/(auth)/login/page.tsx` | 修改 | 挂载 EmbeddedRouteGuard |
| `frontend/src/lib/api/query-client.ts` | 修改 | research 项目级查询键 |
| `frontend/src/lib/locales/*/index.ts` | 修改 | 14 语言 research 工作台文案段（~50 键） |
| 测试 | 新增 | 15 文件 90 测试（claims/会话 claims/禁用矩阵/API 契约/hooks/全部面板/工作台 e2e 跳转） |

### 6.2 契约要点（与后端 research/router.py、契约 v0 对齐）

- Sources 只读（GET 列表/详情）；状态 pending/ready/stale/failed 全部可见；
  failed 附 last_error；同步重试仅 Admin（Owner 无重试入口，只提示可见性）。
- Citation：`page_idx` 0-based 仅展示 +1（REQ-DATA-03）；来源缺失/版本
  不一致/页缺失 → 禁用跳转、原文保留（REQ-DATA-04）。
- Notes/Insights/Transformations 全部经 Gateway；Note 保存载荷仅
  title/content（REQ-DIS-01）；Transformation 模板仅 prompt-only 四字段
  （REQ-DIS-03）、运行只走 Gateway run 端点（REQ-DIS-02），运行前数据
  外发提示为硬门槛（§12）。
- Owner 写 / Admin 只读矩阵：Admin 无写入口 + 只读横幅 + 后端 403 仍以
  toast 呈现（禁用入口不替代后端授权）。
- 后端 `GET .../sources`、`GET .../sources/{source_id}` 路由尚未在 RDLens
  main 落地（契约 §3.7 已定义）；本 PR 按契约实现并以其响应形状为测试
  fixture，后端落地后无需改动。用户侧无模型目录端点 → Transformation
  表单以 model_id 输入 + 首次外发提示呈现。

### 6.3 验证

- `cd frontend && npx vitest run`：43 文件 268 passed（基线 28/178 +
  本任务 15 文件 90 测试，零回归）
- `npm run lint`：0 errors（7 条 pre-existing warnings，无新增）
- `npm run build`：通过，含 `/research` 路由

## 7. UI-03 Search、Chat、长任务与 Compare 交互（2026-08-11）

> Task ID: UI-03（GitHub Issue #72，repo: HiFiBiO-Therapeutics/RDLens）
> 分支：`open-notebook-m4-ui-03`（基于 UI-01 #4）；PR：#6
> 设计锚点：设计方案 §7、§9.3、§10、§13、§15.2；契约 v0 §8–§10、§13.2
> Requirements：REQ-SCOPE-04、REQ-ENG-04、REQ-API-02、REQ-JOB-01–02、
> REQ-QUOTA-01、REQ-POC-02

### 7.1 改动清单（仅前端，后端零改动）

| 文件 | 类型 | 说明 |
|---|---|---:|
| `frontend/src/lib/research/sse.ts` | 新增 | SSE 契约纯 reducer：event_id 去重/乱序排序/终态恰好一次 + 帧解析；`lastEventId` = Last-Event-ID 重连依据；错误码与可重试集合（§9.4） |
| `frontend/src/lib/research/jobs.ts` | 新增 | Job 状态机纯函数（终态不可逆；queued/running 才可取消，§10） |
| `frontend/src/lib/research/compare.ts` | 新增 | Compare 选择边界（30 默认/50 硬上限/51 拒绝，REQ-QUOTA-01） |
| `frontend/src/lib/research/types.ts` | 新增 | Research API/SSE/Job 类型（契约 v0 §8–§10 字段） |
| `frontend/src/lib/research/api.ts` | 合并 | 与 UI-02 共享的 Gateway 客户端：Sources/Notes/Insights/Transformations/Export 端点（UI-02）+ Search/Chat/Compare/Jobs 端点与 fetch SSE 流（UI-03；Bearer=内存 Token、Last-Event-ID、409/网络错误分类、fail-closed）；`listSources/listNotes` 统一为 UI-02 分页签名，UI-03 工作区消费 `.items` |
| `frontend/src/lib/research/project.ts` | 新增 | 项目上下文：Token payload 解出 project_id（§4.1/§12.2，不校验签名，fail-closed） |
| `frontend/src/lib/hooks/use-research-chat.ts` | 新增 | Chat 流状态机：断线/409 按 Last-Event-ID 退避重连（≤3 次）、终态一次、session_id 跨轮续接；浏览器断开 ≠ 取消（§9.6） |
| `frontend/src/lib/hooks/use-research-jobs.ts` | 新增 | Job 交互：job_id 仅存 localStorage（关闭后恢复查看）、状态永远以 GET 为准（终态一次不回归）、显式取消（终态 409 语义）、Compare 51 篇前置拒绝 |
| `frontend/src/components/research/*` | 新增 | 工作区组合 + Source/Note 选择器 + Search/Chat/Compare/Jobs 四面板 + Citation 列表（page_idx+1 展示） |
| `frontend/src/app/research/page.tsx` | 修改 | Shell 内上下分屏并列 ResearchWorkbench（UI-02）+ ResearchWorkspace（UI-03） |
| `frontend/src/lib/locales/*/index.ts` | 修改 | 14 语言 research 面板文案段（zh-CN 翻译，其余英文占位）；移除 UI-01 遗留未用 `ready` 键 |
| `frontend/src/lib/research/*.test.ts`、`frontend/src/lib/hooks/*.test.ts(x)`、`frontend/src/components/research/*.test.tsx` | 测试 | 10 文件 78 测试 |

### 7.2 契约适配说明

- 项目 ID 来源：postMessage token 载荷无 project_id（UI-01 冻结），iframe 从
  JWT payload 读取 claim（§4.1）用于 Gateway URL 路由；服务端仍做最终一致校验。
- 白名单无 Job 列表端点：恢复查看以 localStorage 仅存 job_id + 按 id GET 回源
  （REQ-JOB-02），本地组件状态不是持久 Job 状态。
- Chat 无取消入口（§9.6：浏览器断开 ≠ 取消）；取消仅 Job 显式 POST。

### 7.3 验证

- `cd frontend && npx vitest run`：本任务 11 文件 77 测试；与 UI-02 合并后
  全量 54 文件 345 passed（= 基线 178 + UI-02 90 + UI-03 77，双方测试零删减）
- `npx tsc --noEmit`：0 errors；`npm run lint`：0 errors（7 条 pre-existing warnings）
- `npm run build`：通过，含 `/research` 路由
- `git diff --check`：通过

### 7.4 未覆盖 / 后续

- 断线/重连 E2E：Playwright 未在本 Fork 前端配置；以 jsdom + 假定时器
  驱动真实 fetch/ReadableStream 管线与组件级 dispatch 作为等价 E2E。
- 父页面（RDLens frontend）实现仍落 Issue #70。

### 7.5 与 UI-02（PR #5）合并说明（2026-08-11）

- 合并时 UI-02 已合入 fork main：`api.ts` 为双方共享模块（双方端点能力全部
  保留）；UI-03 流测试独立为 `stream.test.ts`（UI-02 的 `api.test.ts` 以 axios
  adapter 覆盖 CRUD 端点契约，模块级 mock 互不冲突）；`research.sources/notes`
  平铺键改名为 `selectSources/selectNotes`（避免与 UI-02 嵌套键 TS 类型冲突）；
  `page.tsx` 上下分屏并列两套面板；locale 为键集并集。

## 8. Private RDLens Source Adapter（2026-08-11）

> PR：[#7](https://github.com/lingyun-hifibio/open-notebook-rdlens/pull/7)
> 合并提交：`c5e0d375d26eeb36ae45f95eb32ad21db9391c85`
> 功能提交：`e03255d631d651b63ca1c23d752c1cf4e62fb999`
> 审查修复：`75fc5c03624dab5141c2cd643cea752f82cb5093`

### 8.1 目标与边界

- 新增固定的 `PUT /internal/rdlens/source` 与
  `DELETE /internal/rdlens/source`，使用独立 service credential；拒绝浏览器、
  代理和公网客户端，且不返回 CORS。
- 以 notebook/document/version 确定性生成 Source ID；重复 upsert/delete
  收敛，delete replay 在目标不存在时仍保持幂等成功。
- 仅写 `text`/`full_text` 与 notebook relation；不触发 provider、处理命令、
  原生 AI 或 embedding。
- embedded 模式下继续阻断普通 `/api/sources*` 写路径，内部适配器不放宽
  浏览器 API 边界。

### 8.2 Patch 清单

| 文件 | 类型 | 行数 | 说明 |
|---|---|---:|---|
| `.env.example` | 配置 | +5 | 独立 `RD_INTERNAL_SOURCE_ADAPTER_TOKEN` 及网络边界说明 |
| `api/internal_source_adapter.py` | 新增适配器 | +94 | service credential、请求来源守卫、固定 PUT/DELETE 路由 |
| `api/internal_source_service.py` | 新增服务 | +88 | 确定性 ID、最小字段写入、幂等 upsert/delete |
| `api/routers/internal_sources.py` | 新增路由 | +21 | 内部路由注册入口 |
| `api/models.py` | 模型 | +26 | 内部 Source upsert/delete 请求模型 |
| `api/main.py` | 注册 | +11 | 挂载内部 Source Adapter |
| `api/embedded_scope.py` | 行为守卫 | +5/-6 | 精确区分内部固定路由与普通 `/api/sources*` |
| `tests/test_internal_source_adapter.py` | 测试 | +220 | 凭据/网络/CORS/确定性 ID/幂等/副作用边界 |
| `tests/test_embedded_scope.py` | 测试 | +5/-4 | embedded 普通 Source API 阻断回归 |

合计：9 文件，+475/-10 行。

### 8.3 验证与发布

- Fork 全量测试：677 passed；Ruff、Mypy、`git diff --check` 通过。
- 内部镜像：`ghcr.io/hifibio-therapeutics/open-notebook-rdlens:v1.14.0-rdlens.3`
  固定为
  `sha256:d52b7bab55b508247511e9fb11b1b9d07f814f1e1af3ad6dc17c9e0078cab447`；
  OCI revision 为上述 PR #7 merge commit，平台为 `linux/amd64`。
- Registry metadata、远端 digest 拉取和镜像内 Source Adapter compile smoke
  均通过；尚未执行生产部署或双仓真实 E2E。

## 9. Embedded 部署构建参数（2026-08-12，Issue #102）

> Task ID: PMR-01（GitHub Issue #102，repo: HiFiBiO-Therapeutics/RDLens）
> 分支：`fix/pmr-102-embedded`；目标 tag：`v1.14.0-rdlens.4`
> 背景：正式 Research 部署未启用 Embedded 安全模式（post-merge review PMR-HIGH）。
> 物证：前端 `NEXT_PUBLIC_RD_*` 与 `RD_FRAME_ANCESTORS` 均在 `next build` 时固化
> （物证 `.next/routes-manifest.json`），运行时注入无效，必须带 build arg 重建镜像。

### 9.1 目标与边界

- `NEXT_PUBLIC_RD_*` 由 Next.js 构建时内联进客户端 bundle；`RD_FRAME_ANCESTORS`
  由 `next.config headers()` build 时求值一次、固化进 `.next/routes-manifest.json`。
  两者运行时修改环境变量均不生效，必须以 build arg 重建镜像。
- 后端 5 变量（`RD_EMBEDDED_MODE` 等）为模块导入时读 env，运行时注入有效，经
  RDLens `deploy/research/compose.yaml` 注入，不在本 Patch 范围。
- 所有 build arg 默认空 = 上游默认行为（G3：未启用时完全保持上游行为）。

### 9.2 Patch 清单

| 文件 | 类型 | 行数 | 说明 |
|---|---|---:|---|
| `Dockerfile` | 构建参数 | +11 | frontend-builder 阶段 `COPY frontend/` 后、`npm run build` 前插入 4 个 `ARG` + `ENV` 注入（`NEXT_PUBLIC_RD_EMBEDDED_MODE` / `NEXT_PUBLIC_RD_GATEWAY_URL` / `NEXT_PUBLIC_RD_PARENT_ORIGIN` / `RD_FRAME_ANCESTORS`），默认空 |
| `frontend/next.config.ts` | 注释修正 | +4/-2 | headers() 注释改为「build 时求值固化进 routes-manifest.json，运行时改 env 不生效须重建（Issue #102）」 |
| `frontend/src/lib/embedded/csp.ts` | 注释修正 | +3/-2 | 同上（模块 docstring） |

合计：3 文件，+18/-4 行；零行为改动（仅构建参数声明与注释修正）。

### 9.3 构建命令（嵌入式镜像）

```bash
docker build \
  --build-arg NEXT_PUBLIC_RD_EMBEDDED_MODE=true \
  --build-arg NEXT_PUBLIC_RD_GATEWAY_URL=<rdlens-gateway-url> \
  --build-arg NEXT_PUBLIC_RD_PARENT_ORIGIN=<rdlens-parent-origin> \
  --build-arg RD_FRAME_ANCESTORS="<frame-ancestors-origin-list>" \
  -t ghcr.io/hifibio-therapeutics/open-notebook-rdlens:v1.14.0-rdlens.4 .
```

> ⚠️ RDLens PMR #102 首次构建以占位/POC origin（`http://127.0.0.1:7890`）打通
> 构建链路；**生产部署必须以真实 RDLens origin 重建镜像**，占位值不得用于生产。

### 9.4 验证

- 构建后自检：`docker run --rm --entrypoint cat <image> /app/frontend/.next/routes-manifest.json \
  | grep frame-ancestors` 应输出 CSP frame-ancestors；`.next/static` chunks 应内联
  `NEXT_PUBLIC_RD_*` 取值。
- 后端/前端运行行为零改动（仅构建参数声明与注释），不重跑全量测试。
