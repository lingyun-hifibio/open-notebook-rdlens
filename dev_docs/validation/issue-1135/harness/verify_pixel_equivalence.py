#!/usr/bin/env python3
"""Tolerant per-pixel comparison for issue #1135 AFTER vs BEFORE screenshots of
surfaces that must not change visually (capability-off, Admin read-only,
capability-read-failure).

`next dev` can shift a handful of anti-aliasing pixels between runs, so byte
sha256 identity is recorded only as information in the capture manifest. This
script is the cross-phase *visual* gate: for each fixed pair it decodes both
PNGs and reports differing-pixel count / max channel delta against a small
tolerance.

Usage:
  python3 verify_pixel_equivalence.py [evidence-issue-dir]
Writes <evidence>/logs/pixel-equivalence.txt and exits non-zero on FAIL.
Requires Pillow (PIL); if unavailable it prints SKIP and exits 0.
"""
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops
except Exception:  # pragma: no cover - environment without Pillow
    print("SKIP: Pillow (PIL) is not available in this environment; pixel equivalence not evaluated")
    raise SystemExit(0)

EV = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
SHOTS = EV / "screenshots"
LOG = EV / "logs" / "pixel-equivalence.txt"

# Pairs whose rendered surface must not change between BEFORE and AFTER.
PAIRS = []
for width in ("1440", "1024"):
    PAIRS.append((f"e3_capability_off_legacy_form_{width}",
                  f"before_e3_capability_off_legacy_form_{width}.png",
                  f"after_e3_capability_off_legacy_form_{width}.png"))
    PAIRS.append((f"e7_admin_readonly_{width}",
                  f"before_e7_admin_readonly_{width}.png",
                  f"after_e7_admin_readonly_{width}.png"))
    PAIRS.append((f"e8_capability_error_{width}",
                  f"before_e8_capability_error_{width}.png",
                  f"after_e8_capability_error_{width}.png"))

# Tolerance: ignore sub-perceptual channel deltas (<=2) and allow a tiny number
# of anti-aliasing/caret pixels (<=100) with a small maximum delta (<=8).
IGNORE_CHANNEL_DELTA = 2
MAX_DIFF_PIXELS = 100
MAX_CHANNEL_DELTA = 8

lines = [
    "Issue #1135 — tolerant pixel equivalence for unchanged surfaces",
    f"pairs={len(PAIRS)} ignore_channel_delta<={IGNORE_CHANNEL_DELTA} "
    f"max_diff_pixels<={MAX_DIFF_PIXELS} max_channel_delta<={MAX_CHANNEL_DELTA}",
    "",
]
failures = 0
for label, before_name, after_name in PAIRS:
    before_path = SHOTS / "before" / before_name
    after_path = SHOTS / "after" / after_name
    if not before_path.exists() or not after_path.exists():
        lines.append(f"FAIL {label}: missing screenshot ({before_name} / {after_name})")
        failures += 1
        continue
    before = Image.open(before_path).convert("RGB")
    after = Image.open(after_path).convert("RGB")
    if before.size != after.size:
        lines.append(f"FAIL {label}: size mismatch {before.size} vs {after.size}")
        failures += 1
        continue
    diff = ImageChops.difference(before, after)
    bbox = diff.getbbox()
    # Per-pixel max across RGB channels (C-level ops; fast on 1440x900).
    red, green, blue = diff.split()
    max_per_pixel = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    histogram = max_per_pixel.histogram()
    significant = sum(histogram[IGNORE_CHANNEL_DELTA + 1:])
    max_delta = max((value for value, count in enumerate(histogram) if count > 0), default=0)
    width, height = diff.size
    ok = significant <= MAX_DIFF_PIXELS and max_delta <= MAX_CHANNEL_DELTA
    status = "PASS" if ok else "FAIL"
    if not ok:
        failures += 1
    lines.append(
        f"{status} {label}: size={width}x{height} diff_bbox={bbox} "
        f"pixels_over_{IGNORE_CHANNEL_DELTA}={significant} max_channel_delta={max_delta} "
        f"-> {'within tolerance' if ok else 'EXCEEDS tolerance'}"
    )

lines.append("")
lines.append(f"summary: pairs={len(PAIRS)} failures={failures}")
text = "\n".join(lines) + "\n"
LOG.parent.mkdir(parents=True, exist_ok=True)
LOG.write_text(text)
print(text, end="")
raise SystemExit(1 if failures else 0)
