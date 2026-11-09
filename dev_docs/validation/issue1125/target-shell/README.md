# #1125 target-shell topic-overview — public Before/After visual evidence

This branch holds the **public-safe** Before/After screenshots used in
[PR #123](https://github.com/lingyun-hifibio/open-notebook-rdlens/pull/123) (RDLens issue
[#1125](https://github.com/HiFiBiO-Therapeutics/RDLens/issues/1125), owner decision "选A":
fix the default-shell integration as a defect).

- **Data**: a controlled **synthetic UI-demo project** (2 synthetic text sources, explicitly
  labelled); no internal/real material titles, ids, account names or credentials. The host account
  group is masked in the captures.
- **Environment**: isolated candidate environment (real RDLens backend, real isolated PG/Surreal,
  real local model; Playwright Chromium 153, light theme, 1440×900 and 1024×768, zh-CN).
- **Before**: fork deploy pin `fb4f5f6ff02e190a69b2526394279ab8a957aacf` (tree
  `1943335d12f6c4c02abc1f1703d180274d97bb7a` = the deployed `.42` image tree): default target shell
  has **no** topic-overview entry.
- **After**: PR #123 head `afcd7aa26a80612a3a39f1021bb994b9da71eee4` (tree `6c18d6b2…`;
  deployed pin + target-shell wiring + round-1 review fixes + DEF-2 `response_language` fix):
  the existing overview card/Dialog is mounted at the central conversation start position
  (D-UI-04=A), with no right rail / no new navigation.
- Real-material L2 evidence (real 10-paper batch, private) lives in the RDLens private evidence
  branch `evidence/issue1125-20261109` (`dev_docs/validation/issue1125/l2-raw/`), not here.

Files: `before-screenshots/` (1), `after-screenshots/` (4: 1440 entry + dialog, 1024 entry + dialog),
plus the machine manifests from the capture harness.

This is by an automated agent, not a human.
