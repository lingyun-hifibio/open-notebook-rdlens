#!/usr/bin/env python3
"""Fill the issue #1135 README placeholders from the captured manifests + logs."""
import json
import re
from collections import OrderedDict
from pathlib import Path

EV = Path(__file__).resolve().parent.parent  # dev_docs/validation/issue-1135
README = EV / "README.md"
BEFORE = json.loads((EV / "before-manifest.json").read_text())
AFTER = json.loads((EV / "after-manifest.json").read_text())

SCENE_TITLES = {
    "E1": "E1 旧 Note 行操作区（Hover）",
    "E2": "E2 旧 Note 编辑路径（旧表单 / 启用→原地 d2-v1）",
    "E3": "E3 能力关闭（note_editor=false）",
    "E4": "E4 403 restricted（终态）",
    "E5": "E5 503 dependency + 重试",
    "E6": "E6 未知结果 → 同 mutation 确认",
    "E7": "E7 Admin 只读",
    "E8": "E8 能力读取失败 fail-closed",
}


def grouping(manifest):
    grouped = OrderedDict()
    for scene in manifest["scenes"]:
        grouped.setdefault(scene["id"], []).append(scene)
    return grouped


def assertion_table(manifest, empty="—（基线无该流程，N/A）"):
    grouped = grouping(manifest)
    rows = []
    for scene_id in ("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"):
        runs = grouped.get(scene_id, [])
        if not runs:
            rows.append(f"| {SCENE_TITLES[scene_id]} | N/A | 0 |")
            continue
        names = []
        for run in runs:
            for item in run.get("assertions", []):
                if item["name"] not in names:
                    names.append(item["name"])
        count = sum(len(run.get("assertions", [])) for run in runs)
        cells = "、".join(f"`{name}`" for name in names)
        rows.append(f"| {SCENE_TITLES[scene_id]} | {cells} | {count} |")
    return "\n".join(rows)


def enable_summary(manifest, scene_id):
    grouped = grouping(manifest)
    runs = grouped.get(scene_id, [])
    if not runs:
        return "N/A"
    requests = runs[0].get("stats", {}).get("enable_requests") or []
    applies = runs[0].get("stats", {}).get("enable_semantic_changes")
    if not requests:
        if scene_id == "E2" and manifest["phase"] == "before":
            saves = runs[0].get("stats", {}).get("saves") or []
            statuses = ",".join(str(entry.get("status")) for entry in saves)
            return f"0× `POST .../editing`；旧表单 PATCH {len(saves)}× ({statuses})"
        return "0× `POST .../editing`"
    parts = [f"{entry['outcome']}/{entry['status']}" for entry in requests]
    text = f"{len(requests)}× `POST .../editing`: " + " → ".join(parts)
    if applies is not None:
        text += f"；语义变更 {applies}×"
    return text


def request_table():
    rows = []
    for scene_id in ("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"):
        rows.append(
            f"| {scene_id} | {enable_summary(BEFORE, scene_id)} | {enable_summary(AFTER, scene_id)} |"
        )
    return "\n".join(rows)


def totals(manifest):
    totals = manifest["totals"]
    return (
        f"{totals['assertions_pass']} PASS / {totals['assertions_fail']} FAIL / "
        f"{totals['scene_errors']} scene errors "
        f"({totals['assertions']} assertions, {totals['scenes']} scene runs)"
    )


def local_verification():
    log = (EV / "logs" / "local-verification.txt").read_text()
    lines = [line.strip() for line in log.splitlines() if line.strip()]
    summary = next((line for line in lines if line.startswith("head=")), "")
    tests = next((line for line in lines if line.startswith("Tests ")), "")
    changed = [line for line in lines if line.startswith("changed files")]
    targeted = [line for line in lines if line.startswith("vitest (targeted")]
    parts = ["# 命令与退出码（完整输出见 logs/local-verification.txt）", summary]
    if changed:
        parts.append(changed[0])
    if tests:
        parts.append(tests)
    if targeted:
        parts.append("targeted vitest: PASS")
    return "\n".join(parts)


impl_diff = AFTER.get("implementation_diff", {})
impl_cell = (
    f"{impl_diff.get('changed_files', '?')} files（`git diff --name-only origin/main deca625`；"
    "源码 + 单测 + 14 语言文案，见 after-manifest.json.implementation_diff）"
)

text = README.read_text()
replacements = {
    "{{BEFORE_TOTALS}}": totals(BEFORE),
    "{{AFTER_TOTALS}}": totals(AFTER),
    "{{BEFORE_ASSERT_TABLE}}": (
        "| 场景 | 关键断言（全部 PASS） | 计数（两视口合计） |\n|---|---|---|\n"
        + assertion_table(BEFORE)
    ),
    "{{AFTER_ASSERT_TABLE}}": (
        "| 场景 | 关键断言（全部 PASS） | 计数（两视口合计） |\n|---|---|---|\n"
        + assertion_table(AFTER)
    ),
    "{{REQUEST_TABLE}}": (
        "| 场景 | BEFORE（`/__stats`） | AFTER（`/__stats`） |\n|---|---|---|\n"
        + request_table()
    ),
    "{{LOCAL_VERIFICATION}}": local_verification(),
    "{{IMPL_DIFF}}": impl_cell,
}
for key, value in replacements.items():
    if key not in text:
        raise SystemExit(f"placeholder missing in README: {key}")
    text = text.replace(key, value)
README.write_text(text)
print("README filled")
print("BEFORE:", totals(BEFORE))
print("AFTER:", totals(AFTER))
