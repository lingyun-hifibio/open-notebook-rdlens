# 第一批契约缺口登记：`$defs/list_query` 无 source 选择器（#602 第三批 6b 收口）

- 日期：2026-10-28
- 任务：登记第一批 `list_query` source 选择器缺口与负责人（task-17）
- 结论：**此前未在 issue 台账登记**（仅设计/索引文本有缺口说明，无 issue 评论、无负责人回填）；**本次已完成登记**，未修改冻结 JSON/代码。

## 1. 缺口事实（实测）

- 冻结契约：`dev_docs/设计方案/Research/Issue602_第一批_契约与测试场景_v1_20261020.json`
  - `revision=6`、`status=frozen`
  - `$defs/list_query`：仅 `cursor`/`limit`/`kind`，`additionalProperties: false`，**无 `source_id`**
  - sha256：`03eaf56e49f08ee971d1a59ce37c80dceee0070321765854590af7c24024c73f`
- 影响：`GET /v1/research/projects/{project_id}/chat/sessions?kind=source` 无法按单一来源过滤；第三批 Source 快捷列表只能用旧读路径 `GET /sources/{source_id}/chat/sessions` 作 session 身份枚举，**不计入新契约证据**。
- 设计依据：`01_DESIGN.md` §1.4-9、§4.1、§10.6 未勾选项；`02_INTERFACE_FREEZE.md` §3 “已知契约缺口”。

## 2. 登记结果（公开链接）

| 位置 | 内容 | 链接 |
|---|---|---|
| 主仓 #584（D1 阶段入口） | 缺口说明、影响、第三批临时兜底与限制、建议修订方向、建议负责人 | https://github.com/HiFiBiO-Therapeutics/RDLens/issues/584#issuecomment-6459850878 |
| 主仓 #602（第三批） | 简短记录 + 链接 #584 评论 + 负责人 | https://github.com/HiFiBiO-Therapeutics/RDLens/issues/602#issuecomment-6459879248 |

- **负责人（建议/回填）**：@lingyun-hifibio（#601 D1-A owner；第一批契约冻结/批准方为项目负责人），待其确认或转派。
- **修订方向（建议）**：下一版第一批契约给 `list_query` 增加可选 `source_id`（`string|null`；`kind=source` 时限定单一来源），同步 JSON Schema/测试向量/接口索引并升 revision；备选为正式扩展旧读路径并冻结其响应/分页/权限语义。
- **临时兜底（第三批）**：项目级历史走新 `kind=all`；Source 快捷列表旧路径仅身份枚举 + 404 按来源暂不可用处理；不声称满足新 `list_response`，不把旧路径计为新契约证据。

## 3. 冻结 JSON 未改证明（RDLens 主仓）

```text
repo: /home/lchen/workspace/RDLens
HEAD: 92ae0c09f95338a967b3e078104af3c3f19d5149
JSON: dev_docs/设计方案/Research/Issue602_第一批_契约与测试场景_v1_20261020.json
sha256: 03eaf56e49f08ee971d1a59ce37c80dceee0070321765854590af7c24024c73f
git status --porcelain -- <JSON>:  （空）
git diff --stat HEAD -- <JSON>:    （空）
revision=6, status=frozen（读取自文件）
```

## 4. 本证据工作树改动范围

- 工作树：`/home/lchen/workspace/open-notebook-rdlens/.worktrees/batch3-evidence-remaining`
- 分支：`feat/issue602-b3-remaining-evidence`（base `origin/main`，HEAD `8226f12564569c91df1afca82e3cb79f4bea0e50`）
- 本任务**仅新增本文件**（未 commit/push）；其余文件未改动：
  - `git status --short` 仅 `?? dev_docs/validation/issue602_batch3/real_integration/gap_registration.md`
- 未修改产品代码、未修改冻结 JSON、未提交/推送。

## 5. 网络重试记录

- #584 评论：第 1 次成功（无重试）。
- #602 评论：第 1 次成功（无重试）。
- 未出现 GitHub 网络异常。
