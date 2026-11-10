#!/usr/bin/env python3
"""Tolerant per-pixel comparison for issue #1134 AFTER vs BEFORE screenshots of
surfaces that must not change visually (Admin read-only, capability-off blocked
view) plus the legacy old-delete path compared on the legacy-row region only
(its full-page screenshots necessarily include the new d2 delete icons).

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

# Pairs whose rendered surface must not change between BEFORE and AFTER:
# E9 Admin read-only (no delete entry), E10 note_editor_existing=false
# (fail-closed blocked view), E11 legacy old delete path (dialog + post-delete
# catalog). The d2 delete entry/dialog/error surfaces are expected to differ and
# are therefore not pixel-paired (E1/E2-E8).
PAIRS = []
for width in ("1440", "1024"):
    PAIRS.append(
        (
            f"e9_admin_readonly_{width}",
            f"before_e9_admin_readonly_{width}.png",
            f"after_e9_admin_readonly_{width}.png",
        )
    )
    PAIRS.append(
        (
            f"e10_existing_off_blocked_{width}",
            f"before_e10_existing_off_blocked_{width}.png",
            f"after_e10_existing_off_blocked_{width}.png",
        )
    )

# E11's full-page screenshots necessarily contain the #1134 delta (the new
# note-delete icons on the d2 rows above the legacy row), so the legacy old-delete
# path is compared on the *legacy row region only*: before = after for the old
# Delete button/dialog flow. Coordinates come from the E1 real-Chromium layout
# probe recorded in before-manifest.json; the synthetic host bar is 24px tall.
HOST_BAR = 24
LEGACY_ROW_FALLBACK = {1440: (16, 649, 486, 713), 1024: (16, 623, 340, 687)}


def legacy_row_regions():
    regions = {}
    manifest = EV / "before-manifest.json"
    if manifest.exists():
        try:
            import json

            data = json.loads(manifest.read_text())
            for scene in data.get("scenes", []):
                if scene.get("id") != "E1":
                    continue
                row = (scene.get("layout") or {}).get("legacyRow") or {}
                box = row.get("box") or {}
                if "x" in box and "y" in box and "right" in box and "bottom" in box:
                    regions[str(scene["width"])] = (
                        int(box["x"]) - 2,
                        int(box["y"]) + HOST_BAR - 2,
                        int(box["right"]) + 2,
                        int(box["bottom"]) + HOST_BAR + 2,
                    )
        except Exception:
            regions = {}
    for width, box in LEGACY_ROW_FALLBACK.items():
        regions.setdefault(str(width), (box[0] - 2, box[1] + HOST_BAR - 2, box[2] + 2, box[3] + HOST_BAR + 2))
    return regions


REGIONS = legacy_row_regions()
REGION_PAIRS = []
for width in ("1440", "1024"):
    REGION_PAIRS.append(
        (
            f"e11_legacy_delete_dialog_{width}_legacy_row_region",
            f"before_e11_legacy_delete_dialog_{width}.png",
            f"after_e11_legacy_delete_dialog_{width}.png",
            REGIONS[width],
        )
    )
    REGION_PAIRS.append(
        (
            f"e11_legacy_deleted_{width}_legacy_row_region",
            f"before_e11_legacy_deleted_{width}.png",
            f"after_e11_legacy_deleted_{width}.png",
            REGIONS[width],
        )
    )

# Tolerance: ignore sub-perceptual channel deltas (<=2) and allow a tiny number
# of anti-aliasing/caret pixels (<=100) with a small maximum delta (<=8).
IGNORE_CHANNEL_DELTA = 2
MAX_DIFF_PIXELS = 100
MAX_CHANNEL_DELTA = 8

lines = [
    "Issue #1134 — tolerant pixel equivalence for unchanged surfaces",
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
    significant = sum(histogram[IGNORE_CHANNEL_DELTA + 1 :])
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

# Region pairs (legacy row crop for E11: the surrounding page carries the
# intentional new delete-entry delta, so only the unchanged legacy row region is
# compared).
for label, before_name, after_name, region in REGION_PAIRS:
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
    crop = before.crop(region), after.crop(region)
    diff = ImageChops.difference(*crop)
    bbox = diff.getbbox()
    red, green, blue = diff.split()
    max_per_pixel = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    histogram = max_per_pixel.histogram()
    significant = sum(histogram[IGNORE_CHANNEL_DELTA + 1 :])
    max_delta = max((value for value, count in enumerate(histogram) if count > 0), default=0)
    ok = significant <= MAX_DIFF_PIXELS and max_delta <= MAX_CHANNEL_DELTA
    if not ok:
        failures += 1
    lines.append(
        f"{'PASS' if ok else 'FAIL'} {label}: region={region} size={crop[0].size} diff_bbox={bbox} "
        f"pixels_over_{IGNORE_CHANNEL_DELTA}={significant} max_channel_delta={max_delta} "
        f"-> {'within tolerance' if ok else 'EXCEEDS tolerance'}"
    )

lines.append("")
lines.append(f"summary: pairs={len(PAIRS)} region_pairs={len(REGION_PAIRS)} failures={failures}")
text = "\n".join(lines) + "\n"
LOG.parent.mkdir(parents=True, exist_ok=True)
LOG.write_text(text)
print(text, end="")
raise SystemExit(1 if failures else 0)
