# #1158 zh-CN topic-overview locale — public Before/After visual evidence

Public-safe screenshots for fork PR [#124](https://github.com/lingyun-hifibio/open-notebook-rdlens/pull/124)
(RDLens follow-up [#1158](https://github.com/HiFiBiO-Therapeutics/RDLens/issues/1158), finding 2: zh-CN UI showed
English `topicOverview` labels).

- **Data**: controlled **synthetic UI-demo project** (2 synthetic text sources, explicit label); no internal/real
  material titles, ids, account names, tokens or Feishu content. Host account group masked.
- **Environment**: isolated candidate environment (real backend, isolated PG/Surreal, real local model — but these
  captures used **0 model calls**); Playwright Chromium 153, light theme, zh-CN, 1440×900 (+1024×768 After).
- **Before**: fork build at deployed base content `afcd7aa26a80612a3a39f1021bb994b9da71eee4` (tree `6c18d6b2…`,
  content equal to merged fork main `0459f29` for this surface); zh-CN UI labels are English.
- **After**: PR #124 head `a3eebeedc495d530dfe33fc9610c63443fbf79e2` (tree `1df0cddf…`); same scenario/viewport/
  theme/project, zh-CN labels turned Simplified Chinese (`主题概览`/`查看概览`/`主要问题`/`主要发现`/`分歧`/`建议优先细读`/`引用`…).
- Same synthetic overview body in both sides (demo overview was generated pre-DEF-2 with `response_language=en`), so the
  comparison isolates **UI label language**; date strings inside zh labels still use en-US format (out of copy-only scope).
- Machine manifests: `before-manifest.json`, `after-manifest.json` (pins, checks, observed labels, sha256).

This is by an automated agent, not a human.
