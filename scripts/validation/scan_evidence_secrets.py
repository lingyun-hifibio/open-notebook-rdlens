#!/usr/bin/env python3
"""证据目录 secret-scan 门禁（#602 第三批 PR-6 事故后新增）。

用途：在提交/推送验证证据前，扫描 `dev_docs/validation/**`（默认）中的
明文凭证、环境变量赋值、docker env dump 与高熵串；命中即失败。
设计原则：
- 只打印 `路径:行号:规则`，**绝不打印命中的值**；
- 64-hex 默认拒绝，仅放行 allowlist 中登记的 digest（文档 SHA-256、镜像 digest 等）；
- 与证据生成流程配套：证据脚本只输出白名单字段，不 dump `docker inspect .Config.Env`。

用法：
  python3 scripts/validation/scan_evidence_secrets.py [--root dev_docs/validation]
退出码：0 = 通过；1 = 有命中/根目录不存在。

规则：
  R1  64-hex（非 allowlist 且非 40-hex commit SHA）
  R2  常见 token 前缀：sk- / ghp_ / github_pat_ / AKIA
  R3  `(API_KEY|TOKEN|PASSWORD|SECRET)=值`（值长度 >= 8；放行占位符）
  R4  `Config.Env` / `docker inspect … .Config.Env` 原始 dump
  R5  32–39 位（及 41+ 位）高熵 hex（熵 > 4.0；放行 allowlist 与 40-hex commit SHA）
  R6  PEM 私钥块
  R7  `Bearer <token>`（token >= 20 字符）
"""
from __future__ import annotations

import argparse
import math
import pathlib
import re
import sys

SKIP_DIRS = {'.git', 'node_modules'}
SKIP_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.zip', '.gz', '.ico'}
HEX64 = re.compile(r'\b[0-9a-fA-F]{64}\b')
TOKEN_PREFIX = re.compile(
    r'(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})'
)
ENV_ASSIGN = re.compile(
    r'(?i)\b([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|PASSWORD|PASSWD|SECRET)[A-Z0-9_]*)'
    r'\s*[=:]\s*["\']?([^"\'\s,}]{8,})'
)
ENV_DUMP = re.compile(r'(Config\.Env|docker\s+inspect[^\n]*Config\.Env)')
# 只有“看起来像 env dump”的行才命中：同行出现 KEY=value/KEY:value 赋值。
ENV_DUMP_ASSIGN = re.compile(r'[A-Z0-9_]{3,}\s*[=:]\s*["\']?[^\s"\',}]{4,}')
PRIVATE_KEY = re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')
BEARER = re.compile(r'(?i)\bBearer\s+[A-Za-z0-9._\-]{20,}')
HEX_LONG = re.compile(r'\b[0-9a-fA-F]{32,}\b')
ALLOW_PLACEHOLDER = (
    'root', '***', 'redacted', '<', 'your_', 'replace-', '${', 'example',
    'placeholder', 'changeme', 'none', 'null', 'undefined', 'secret',
)
SHA40 = re.compile(r'\b[0-9a-f]{40}\b')


def entropy(text: str) -> float:
    if not text:
        return 0.0
    counts: dict[str, int] = {}
    for ch in text:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(text)
    return -sum((count / n) * math.log2(count / n) for count in counts.values())


def load_allowlist(root: pathlib.Path, explicit: pathlib.Path | None) -> set[str]:
    allow: set[str] = set()
    candidates = [explicit] if explicit is not None else [root / 'secret-scan-allowlist.txt']
    for candidate in candidates:
        if candidate is None or not candidate.is_file():
            continue
        for line in candidate.read_text().splitlines():
            value = line.split('#', 1)[0].strip()
            if value:
                allow.add(value.lower())
    return allow


def scan_file(path: pathlib.Path, allow: set[str]) -> list[tuple[int, str]]:
    hits: list[tuple[int, str]] = []
    try:
        text = path.read_text(errors='replace')
    except OSError:
        return hits
    for lineno, line in enumerate(text.splitlines(), 1):
        for match in HEX64.finditer(line):
            token = match.group(0)
            if token.lower() not in allow and not SHA40.fullmatch(token):
                hits.append((lineno, 'R1:64hex'))
        if TOKEN_PREFIX.search(line):
            hits.append((lineno, 'R2:token-prefix'))
        for match in ENV_ASSIGN.finditer(line):
            name, value = match.group(1), match.group(2)
            lowered = value.lower()
            if any(marker in lowered for marker in ALLOW_PLACEHOLDER) or value.startswith('$'):
                continue
            hits.append((lineno, f'R3:env-assign:{name}'))
        if ENV_DUMP.search(line) and ENV_DUMP_ASSIGN.search(line):
            hits.append((lineno, 'R4:env-dump'))
        for match in HEX_LONG.finditer(line):
            token = match.group(0)
            if token.lower() in allow or SHA40.fullmatch(token):
                continue
            if entropy(token) > 4.0:
                hits.append((lineno, 'R5:high-entropy-hex'))
        if PRIVATE_KEY.search(line):
            hits.append((lineno, 'R6:private-key'))
        if BEARER.search(line):
            hits.append((lineno, 'R7:bearer-token'))
    return hits


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Scan evidence files for secrets.')
    parser.add_argument('--root', default='dev_docs/validation', help='evidence root directory')
    parser.add_argument(
        '--allowlist',
        default=None,
        help='allowlist file (default: <root>/secret-scan-allowlist.txt)',
    )
    args = parser.parse_args(argv)
    root = pathlib.Path(args.root)
    if not root.exists():
        print(f'evidence root not found: {root}')
        return 1
    allow = load_allowlist(root, pathlib.Path(args.allowlist) if args.allowlist else None)
    findings = 0
    for path in sorted(root.rglob('*')):
        if not path.is_file() or any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        for lineno, rule in scan_file(path, allow):
            # 只输出位置与规则，绝不输出命中的值。
            print(f'{path}:{lineno}: {rule}')
            findings += 1
    if findings:
        print(f'SECRET-SCAN FAILED: {findings} finding(s)')
        return 1
    print('SECRET-SCAN OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
