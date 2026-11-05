# Issue #585 D2 PR1 共享黄金向量（fork 侧 TypeScript 消费副本，Issue #1045）

主仓：`HiFiBiO-Therapeutics/RDLens`；host PR
[#1072](https://github.com/HiFiBiO-Therapeutics/RDLens/pull/1072) **已合并**
（merge commit `f01ed9be96febdf25db4f34888dfd6de3887c7a1`，2026-11-05）。
机器契约：主仓 `deploy/research/issue585_d2_contract_v1.yaml`（合并后 main 同内容）
Python 参考实现：主仓 `src/rdlens/research/issue585/canonical.py` + `vector_cases.py`
Issue：#1045「PR1：契约与黄金向量」

## 文件

| 文件 | 用途 |
|---|---|
| `canonical.ts` | `C`（`d2-canonical-v1` 确定性递归编码）与 `H`（`sha256(紧凑 JSON [namespace, C(value)])` 的小写十六进制） |
| `golden_vectors.json` | 主仓 bundle 的**逐字节复制**（29 条向量、10 种 kind） |
| `canonical.test.ts` | bundle 字节摘要锚、全部向量重算、`C` 的拒绝面 |
| `README.md` | 本文件 |

## 与主仓合并状态的对应关系

| 项 | 值 |
|---|---|
| host PR | `HiFiBiO-Therapeutics/RDLens#1072`（已合并） |
| host merge commit（合并后 main） | `f01ed9be96febdf25db4f34888dfd6de3887c7a1` |
| 合并后 main 的 `golden_vectors.json` 字节 SHA-256 | `884050b3020e4853f8ee63dbe39e15fac56177fb2f5c69f09fd8eb714e5db358`（与本 README/测试钉住的值相同） |
| 合并后 main 与 host PR head（`a7b911a`）在 PR1 路径上的树差异 | 空（`git diff --stat` 无输出；即合并未改变契约/向量字节） |

验证命令（2026-11-05，主仓 clone）：

```text
$ git merge-base --is-ancestor a7b911a origin/main     # exit 0
$ git diff --stat a7b911a..origin/main -- \
    src/rdlens/research/issue585 tests/research/issue585 \
    deploy/research/issue585_d2_contract_v1.yaml dev_docs/progress/issue585_validation.md
（无输出）
$ git show origin/main:src/rdlens/research/issue585/golden_vectors.json | sha256sum
884050b3020e4853f8ee63dbe39e15fac56177fb2f5c69f09fd8eb714e5db358  -
$ cmp <(git show origin/main:src/rdlens/research/issue585/golden_vectors.json) \
      frontend/src/lib/research/issue585/golden_vectors.json   # exit 0：bytes identical
```

## 同步规则（跨仓库字节锚）

- 唯一权威是主仓 `src/rdlens/research/issue585/golden_vectors.json`；
- fork 侧**只允许逐字节复制**：不重排、不重新生成、不手工编辑（生成器是主仓
  `vector_cases.py::serialize_bundle`，UTF-8 + 2 空格缩进 + 键排序 + 末行换行）；
- 复制后必须同步三处：bundle 字节、`canonical.test.ts` 的 `GOLDEN_VECTORS_SHA256`、
  本 README 的摘要；测试用 `node:crypto` 对**文件字节**做 SHA-256 与常量比对，
  主仓或 fork 任何一侧漂移都会变红。

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `golden_vectors.json` | 115441 | `884050b3020e4853f8ee63dbe39e15fac56177fb2f5c69f09fd8eb714e5db358` |

## 测试验证范围（不重复实现服务端逻辑）

| kind | 验证方式 |
|---|---|
| `codec` | `C(value)` 重算 `encoded`；`[namespace, C(value)]` 重算 `preimage_utf8`；`H` 重算 `sha256`（另有 Node `crypto` 交叉校验） |
| `note_snapshot` / `mutation_request` / `export_request` | 服务端 normalize **不在 TS 侧重写**：直接用 bundle 冻结的 `normalized_value` 验证 `C`/`H`，并断言给定 `encoded` + `preimage_utf8` 的重新序列化逐字节一致 |
| `export_id` | `nex_` + `sha256([namespace, C(value)])` 前 32 个十六进制字符 |
| `file_content_hash` | `sha256(UTF-8(file_text))`（无 BOM） |
| `document_context` / `history_turns` | `H([namespace, C(normalized_value)])`；紧凑 JSON、无 BOM |
| `writing_intent` | `H([namespace, C(value)])` |
| `writing_envelope` | `H([namespace, C({payload: payload_without_envelope_hash, document_context, history_turns})])`；`payload` 不含自引用摘要 |

拒绝面（显式用例）：浮点 `1.5`、非有限数、安全整数 `±(2^53)` 越界、未配对
surrogate 字符串/对象键、symbol 键对象、函数/`undefined`/symbol/bigint、
`Map`/`Set`/`Date`/`Uint8Array`、稀疏数组、空命名空间。

## 命令

```bash
cd frontend
npx vitest run src/lib/research/issue585
```

本 PR 实测：`51 passed (51)`（1 个测试文件）。

## 范围与限制

- **契约与黄金向量层，无产品接线**：不 import 到任何页面/请求路径，不做存储、
  网络、路由或授权判定；
- `H` 复用 `src/lib/research/session-idempotency.ts` 的纯 TS SHA-256，浏览器 /
  jsdom / Node 字节一致（不依赖 WebCrypto / TextEncoder 的环境差异）；测试仍在
  vitest 默认 jsdom 环境运行（`src/test/setup.ts` 依赖 `window`），但被测函数是纯函数；
- 已知跨语言差异：JavaScript `number` 只有 binary64，字面量 `1.0` 与 `1` 不可区分，
  TS 按整数接受；Python 侧 `float` 输入拒绝。wire 上写成 `1.0` 的 JSON 由服务端
  Python 校验拦截，TS 侧不存在能表达「浮点 1.0」的输入类别；
- 向量数据全部为合成样例，不含真实正文、来源片段或凭据。
