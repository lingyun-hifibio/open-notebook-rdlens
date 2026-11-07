# #1106（W1）PR-B — 前端「本次用途」可见可改：L2/L3 证据

> 证据级别：**L2 候选环境**（真实 host + 真实 fork 生产构建 + 真实 RDLens 后端 + 隔离真实 PG/SurrealDB + 真实本地模型 + 真实 Playwright Chromium）+ **L3 真实本地模型探针**。
> 合成注入仅：登录 token 注入浏览器内存、受控材料（合成 ORR/PFS 文本，明确标注）。非生产部署验收；本项目未部署、未启用生产 flag、无外发。

- Issue：[RDLens #1106](https://github.com/HiFiBiO-Therapeutics/RDLens/issues/1106)（W1 自然工作目的理解与可纠正）
- 计划：[`issue1106_purpose_plan_20261107.md`](https://github.com/HiFiBiO-Therapeutics/RDLens/blob/main/dev_docs/plans/issue1106_purpose_plan_20261107.md) §8（PR-A 已合 RDLens main `16e44fae6` / #1127）
- PR-B：本 fork PR #119，head `cc17d1b`，base fork `main` `b94142ac`
- 白名单扩充：owner 2026-11-07 Feishu「批准」；计划 §11 PR-B白名单已扩为 `frontend/src`（同批 RDLens docs PR）

## 结论

| 项 | 结果 |
|---|---|
| L1 前端（tsc / vitest / lint / build） | tsc exit 0；定向 13 文件 **426 passed**；全量 **2487 passed / 25 failed**（25 失败 = fork main 既有 NotesPanel 11 + SourceListPanel 14，非本 PR 引入）；next build exit 0 |
| L2 Before/After（真实浏览器） | Before **21/21 BASELINE**（能力缺失基线，anomaly=0）；After **21/21 PASS**（20 主矩阵 + d 故障注入场景；FAIL=0 / NOT RUN=0） |
| L3 真实本地模型探针（10 场景，D10） | **10/10 PASS，D10 闭合**；`verify_evidence.py` 90/90 checks passed |
| 生产状态 | 未部署、未启用 flag、无外发；候选进程隔离端口 |

## 环境 / revision

| 项 | 值 |
|---|---|
| backend-before | RDLens main `352381254`（PR-A 前，inference off/不存在） |
| backend-after | RDLens main `16e44fae6`（PR-A #1127 merge，inference flag on） |
| host | RDLens `16e44fae6` 生产构建（`frontend/` 树在 352381254→16e44fae6 无差异） |
| fork-before | fork `main` `b94142ac` standalone 生产构建 |
| fork-after | PR-B head `cc17d1b` standalone 生产构建 |
| 模型 | Qwen3.8-27B，隔离 SGLang `127.0.0.1:9998`（shared，max_model_len 32768；非生产 9999） |
| 浏览器 | Playwright Chromium 153.0.8010.12，headless，deviceScaleFactor=1；zh-CN/en-US；1440×900/1024×768；light |
| flags | contract_v1 / d1c / session / c05 / workspace_v2 / document_workspace_context = true；purpose_inference = after true、before 不存在；external_llm = false |

After capabilities：`purpose_inference=true`、`purpose_sources=["explicit","default_legacy","inferred"]`；Before 两键缺席（fail-closed 基线）。

## L2：Before → After 对照（真实浏览器）

Before 状态统一为 **BASELINE**（能力缺失，如实记录；不等于 After 失败）。After 才做 PASS/FAIL 判定。

| # | 场景 | Before（fork b94142ac + RDLens 352381254） | After（fork cc17d1b + RDLens 16e44fae6） |
|---|---|---|---|
| a1 | 空 selected「讨论一个假设」 | 无「本次用途」UI；空 selected 被范围门禁阻断，无请求 | **PASS**：摘要「本次用途：自动判断」；空 selected 可发送；请求省略 `work_purpose`；持久化 `exploration/inferred`；首流 usage 两键同源；脚注「探索讨论（自动判断）」 |
| a2 | all selected「讨论一个假设」 | 请求省略 purpose；持久化 `document_qa/default_legacy`（缺省资料问答，非探索） | **PASS**：请求省略；持久化 `exploration/inferred`；脚注同源 |
| b | 目的可见可改 + 显式资料查询 + 写作 W3 文案 | 无 purpose UI/三选/写作文案；请求无 `work_purpose` | **PASS**：摘要+展开三选+自动判断；写作标注「完整写作将在 W3 提供」；显式后请求 `work_purpose=document_qa`、持久化 `document_qa/explicit`、脚注「资料查询（你选择）」 |
| c | 歧义/低置信 → 可纠正缺省 | 无 purpose UI，缺省不可见不可纠 | **PASS**：可见「默认（资料问答）」（`default_legacy`）+ 改用途入口 |
| d | 推断异常 fail-safe 回退 | 无 inference 模块，不可构造（BASELINE） | **PASS（故障注入）**：省略 `work_purpose` → 不 5xx、202→completed、持久化 `document_qa/default_legacy`、脚注「默认（资料问答）」、后端 `reason=inference_fallback`（不冒充 inferred） |
| e | 纠正只作用下一请求、旧回答不重写 | 两轮均省略 purpose、均 `document_qa/default_legacy`；首轮行逐字段不变；draft token 不同 | **PASS**：首轮 auto 后改用途→第二轮显式；首轮 assistant 行/历史逐字节不变；新 draft token/新幂等键 |
| f1 | 空 selected 歧义 → 422 +「改为探索讨论并重发」 | 空 selected 被本地范围门禁阻断，无请求/无纠正动作 | **PASS**：首请求省略 `work_purpose` → 422 `scope_selected_empty`（零写入）；错误卡 `chat-scope-purpose-recovery`；点重发 → 新 POST `work_purpose=exploration` → 200 新回答追加（statuses 422,202,200；无 409）；原 422 行不重写 |
| f2 | 无检索命中不静默换目的 | 无 purpose UI/动作；回答 `document_qa/default_legacy` | **PASS**：不静默换目的；always-available「改用途」入口可见；无专用 no-hit 动作如实登记（已知欠项） |
| g1 | 历史重开/重放同源 | reload 两次同一 assistant 行 `document_qa/default_legacy`，无 purpose 标签 | **PASS**：reload/重开同一 assistant 行 purpose/source 一致；replay usage 与详情同源；脚注同值 |
| g2 | 旧行 null/not_recorded →「未记录」 | 无 purpose UI；旧行不适用（BASELINE） | **PASS**：seed legacy session `s-legacy-9c0a859d7e`（无两键）→ headed `null/not_recorded` → 脚注「用途：未记录」，不回填 `document_qa`，无 POST /chat |

Before 基线断言 0 fail / anomaly=0；After 逐场景 checks 全通过（明细见 RDLens 私有证据分支 `dev_docs/validation/issue1106/l2/manifest.json`）。

### Before/After 截图

| # | 场景 | 视口 | 语言 | Before | After |
|---|---|---|---|---|---|
| 1 | a1 空 selected「讨论一个假设」 | 1440×900 | zh-CN | ![](screenshots/before_a1_empty_selected_hypothesis_zh_1440.png) | ![](screenshots/after_a1_empty_selected_hypothesis_zh_1440.png) |
| 2 | a1 空 selected「讨论一个假设」 | 1440×900 | en-US | ![](screenshots/before_a1_empty_selected_hypothesis_en_1440.png) | ![](screenshots/after_a1_empty_selected_hypothesis_en_1440.png) |
| 3 | a2 全部资料「讨论一个假设」 | 1440×900 | zh-CN | ![](screenshots/before_a2_all_selected_hypothesis_zh_1440.png) | ![](screenshots/after_a2_all_selected_hypothesis_zh_1440.png) |
| 4 | b 目的可见可改：摘要 | 1440×900 | zh-CN | ![](screenshots/before_b_purpose_ui_zh_1440.png) | ![](screenshots/after_b_purpose_summary_zh_1440.png) |
| 5 | b 目的展开三选 + 写作 W3 文案 | 1440×900 | zh-CN | （能力缺失，同 #4） | ![](screenshots/after_b_purpose_expanded_zh_1440.png) |
| 6 | b 显式资料查询请求/来源「你选择」 | 1440×900 | zh-CN | — | ![](screenshots/after_b_explicit_document_qa_sent_zh_1440.png) |
| 7 | c 歧义 → 可纠正缺省 | 1440×900 | zh-CN | ![](screenshots/before_c_ambiguous_zh_1440.png) | ![](screenshots/after_c_correctable_default_zh_1440.png) |
| 8 | e 纠正只作用下一请求、旧回答不重写 | 1440×900 | zh-CN | ![](screenshots/before_e_correction_first_turn_zh_1440.png) | ![](screenshots/after_e_correction_second_turn_history_zh_1440.png) |
| 9 | f1 空 selected 歧义 422 +「改为探索讨论并重发」 | 1440×900 | zh-CN | ![](screenshots/before_f1_empty_selected_document_qa_zh_1440.png) | ![](screenshots/after_f1_422_recovery_zh_1440.png) |
| 10 | f1 纠正后重发（新请求/旧行不变） | 1440×900 | zh-CN | — | ![](screenshots/after_f1_corrective_resend_zh_1440.png) |
| 11 | f2 无检索命中不静默换目的 | 1440×900 | en-US | ![](screenshots/before_f2_no_hit_en_1440.png) | ![](screenshots/after_f2_no_hit_en_1440.png) |
| 12 | g1 历史重开/重放同源 | 1440×900 | zh-CN | ![](screenshots/before_g1_history_reopened_zh_1440.png) | ![](screenshots/after_g1_history_replayed_zh_1440.png) |
| 13 | g2 旧行 not_recorded「未记录」 | 1440×900 | zh-CN | （旧行不适用） | ![](screenshots/after_g2_legacy_not_recorded_zh_1440.png) |
| 14 | d 推断异常 fail-safe 回退 | 1440×900 | zh-CN | ![](screenshots/before_d_failsafe_attempt_zh_1440.png) | ![](screenshots/after_d_failsafe_legacy_zh_1440.png) |

完整 Before/After manifest、逐场景 checks、原始请求/SSE 与全套 133 PNG 见 RDLens 私有证据分支 `evidence/purpose-frontend-e9228b9e826e` 的 `dev_docs/validation/issue1106/`（同 #1104 惯例）。

## L3 真实本地模型探针（10 场景，D10）

| 类别 | 场景 | 结果 |
|---|---|---|
| 讨论假设 | S01 zh / S02 en（held-out 改写） | PASS：`exploration/inferred`；前提/替代解释/区分性观察/不确定性齐全；0 引用不补造；重放=详情 |
| 资料事实 | S03 显式 / S04 推断 / S05 en | PASS（grounded）：`document_qa/explicit|inferred`、`direct_context`、included_chunks=2、citations 非空、ORR 42%（21/50）可溯源；PFS「未报告」不编造；verification=pass |
| 混合 | S06 / S07 | PASS：`document_qa/default_legacy` + `work_purpose_defaulted`，未静默换目的；引用栅栏通过 |
| 显式覆盖 | S08 / S09 | PASS：显式优先于文本推断，不静默改用户意图 |
| 写作 | S10（D8=a） | PASS：`writing/inferred`；行为 legacy，诚实标注「完整写作 W3」，不主张写作产物 |
| 不确定路径 | D1/D2 | 422 `scope_selected_empty` + `recovery_action=reselect_sources`（可纠正缺省），零 Generation（不伪装） |

模型：Qwen3.8-27B @ 隔离 SGLang 9998；backend-after `16e44fae6`；purpose inference on、external LLM off。受控材料：source:a→d1/v1（ORR 42%/队列 A 18%；PFS 未报告）。

## 限制（如实）

- 非生产部署验收；未部署、未启用生产 flag、无外部模型/外发。
- 真实模型为隔离实例（9998），非生产 9999；受控合成材料，非真实业务语料。
- L3 为单轮回答质量探针；多轮纠正/历史一致性由 L2 与本 PR 单测覆盖。
- 无检索命中（no-hit）无专用 wire 信号：以 always-available 用途纠正入口 + 422 显式重发动作覆盖，不新增本地检测器（已知欠项，W4/P5 另议）。
- L2 只验证 UI/请求/响应/持久化投影与浏览器行为；回答语义质量由 L3 覆盖。

## 复现

见 RDLens 私有证据分支 `dev_docs/validation/issue1106/README.md` §6 与 `environment/ENV.md`；本目录只含公开安全截图与摘要。
