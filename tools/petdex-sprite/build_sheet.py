#!/usr/bin/env python3
"""Assemble a petdex spritesheet + pet.json from per-state source images.

petdex floats a single sprite and plays one animation row per activity state.
The desktop reads a FIXED grid: 9 rows, up to 8 columns, every cell 192x208 px,
full sheet 1536x1872, transparent background. This tool takes the images you
generate (one per state, e.g. from Codex's imagegen) and lays them into that
exact grid, adding light procedural motion so each row animates even when the
source is a single pose.

Input resolution per state (first match wins), under --in:
  1. <state>/            a folder of frame images (used as-is, fit to cell)
  2. <state>.png|.webp   a single pose (replicated across the row + motion)
  3. --default image     fallback so a partial set still yields a full sheet

Usage:
  build_sheet.py --in ./states [--out ~/.codex/pets/clanky] \
      [--name Clanky] [--slug clanky] [--default ./states/idle.png] [--no-motion]
"""

import argparse
import json
import math
import os
import sys

from PIL import Image, ImageEnhance

# (state id, frame count). Order IS the row order the desktop expects.
STATES = [
    ("idle", 6, 1100),
    ("running-right", 8, 1060),
    ("running-left", 8, 1060),
    ("waving", 4, 700),
    ("jumping", 5, 840),
    ("failed", 8, 1220),
    ("waiting", 6, 1010),
    ("running", 6, 820),
    ("review", 8 - 2, 1030),  # 6 frames
]

CELL_W, CELL_H = 192, 208
COLS = 8
ROWS = len(STATES)
SHEET_W, SHEET_H = CELL_W * COLS, CELL_H * ROWS  # 1536 x 1872
IMAGE_EXTS = (".png", ".webp", ".gif")


def load_rgba(path):
    return Image.open(path).convert("RGBA")


def fit_to_cell(img):
    """Contain img inside the cell, preserving aspect, on a transparent cell."""
    scaled = img.copy()
    scaled.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
    cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    cell.paste(scaled, ((CELL_W - scaled.width) // 2, (CELL_H - scaled.height) // 2), scaled)
    return cell


def find_state_source(in_dir, state):
    """Return ('frames', [paths]) | ('pose', path) | None for a state."""
    frame_dir = os.path.join(in_dir, state)
    if os.path.isdir(frame_dir):
        frames = sorted(
            os.path.join(frame_dir, f)
            for f in os.listdir(frame_dir)
            if f.lower().endswith(IMAGE_EXTS)
        )
        if frames:
            return ("frames", frames)
    for ext in IMAGE_EXTS:
        pose = os.path.join(in_dir, state + ext)
        if os.path.isfile(pose):
            return ("pose", pose)
    return None


def render_pose_frame(base, state, phase, motion):
    """One animated frame from a single pose. phase in [0,1) across the row."""
    sprite = fit_to_cell(base)
    dx = dy = 0
    if motion:
        wave = math.sin(phase * 2 * math.pi)
        if state in ("idle", "waiting"):
            dy = round(-2 * wave)
        elif state in ("running", "running-right", "running-left"):
            dy = round(-3 * abs(wave))
            dx = round(2 * wave)
        elif state == "waving":
            sprite = sprite.rotate(6 * wave, resample=Image.BICUBIC, expand=False)
        elif state == "jumping":
            dy = round(-14 * math.sin(phase * math.pi))  # single up-and-down arc
        elif state == "failed":
            r, g, b, a = sprite.split()
            r = ImageEnhance.Brightness(r).enhance(1.35)
            g = ImageEnhance.Brightness(g).enhance(0.7)
            b = ImageEnhance.Brightness(b).enhance(0.7)
            sprite = Image.merge("RGBA", (r, g, b, a))
            dy = round(4 * phase)  # slow slump
            dx = round(2 * wave) if phase > 0.5 else 0  # late shiver
        elif state == "review":
            scale = 1.0 + 0.04 * wave
            w, h = round(CELL_W * scale), round(CELL_H * scale)
            zoomed = sprite.resize((w, h), Image.LANCZOS)
            cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
            cell.paste(zoomed, ((CELL_W - w) // 2, (CELL_H - h) // 2), zoomed)
            sprite = cell
    if state == "running-left":
        sprite = sprite.transpose(Image.FLIP_LEFT_RIGHT)
        dx = -dx
    if dx or dy:
        shifted = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
        shifted.paste(sprite, (dx, dy), sprite)
        sprite = shifted
    return sprite


def build_row(sheet, row, source, fallback, state, frames, motion):
    kind, payload = source if source else ("pose", fallback)
    for col in range(frames):
        if kind == "frames":
            path = payload[col % len(payload)]
            cell = fit_to_cell(load_rgba(path))
        else:
            phase = col / frames if frames else 0.0
            cell = render_pose_frame(load_rgba(payload), state, phase, motion)
        sheet.paste(cell, (col * CELL_W, row * CELL_H), cell)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_dir", required=True, help="dir of per-state images")
    ap.add_argument("--out", default=os.path.expanduser("~/.codex/pets/clanky"))
    ap.add_argument("--name", default="Clanky")
    ap.add_argument("--slug", default="clanky")
    ap.add_argument("--default", dest="default_img", help="fallback pose for missing states")
    ap.add_argument("--no-motion", action="store_true", help="hold the pose, no procedural motion")
    args = ap.parse_args()

    if not os.path.isdir(args.in_dir):
        sys.exit(f"--in dir not found: {args.in_dir}")

    fallback = args.default_img
    if fallback and not os.path.isfile(fallback):
        sys.exit(f"--default image not found: {fallback}")

    sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))
    missing = []
    for row, (state, frames, _dur) in enumerate(STATES):
        source = find_state_source(args.in_dir, state)
        if source is None:
            if not fallback:
                sys.exit(f"no image for state '{state}' and no --default given")
            missing.append(state)
        build_row(sheet, row, source, fallback, state, frames, not args.no_motion)

    os.makedirs(args.out, exist_ok=True)
    sheet_path = os.path.join(args.out, "spritesheet.png")
    sheet.save(sheet_path)

    pet = {
        "name": args.name,
        "slug": args.slug,
        "frameWidth": CELL_W,
        "frameHeight": CELL_H,
        "spritesheet": "spritesheet.png",
        "states": [
            {"id": s, "row": i, "frames": f, "durationMs": d}
            for i, (s, f, d) in enumerate(STATES)
        ],
    }
    with open(os.path.join(args.out, "pet.json"), "w") as fh:
        json.dump(pet, fh, indent=2)

    print(f"wrote {sheet_path}  ({sheet.width}x{sheet.height}, transparent RGBA)")
    print(f"wrote {os.path.join(args.out, 'pet.json')}")
    if missing:
        print(f"NOTE: used --default for missing states: {', '.join(missing)}")


if __name__ == "__main__":
    main()
