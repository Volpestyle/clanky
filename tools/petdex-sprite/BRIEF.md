# Generating Clanky's petdex sprite with imagegen + the assembler

Hatch Pet isn't available and petdex has no local generator, so we use the
**imagegen** skill (which Codex *does* have) to draw the poses, then
`build_sheet.py` lays them into petdex's exact 1536x1872 / 9-row / 192x208 grid
and writes `pet.json`. The assembler is already verified.

Reference image to attach on EVERY imagegen prompt (keeps the character
consistent): `branding/clanky-logo-512-alpha.png`.

## Option A — fastest (one pose)
Generate a single clean idle pose, then let the assembler fake motion for every
state (bob / mirror / red-tint / jump-arc / zoom). Pose changes are subtle but
the pet reacts.

imagegen prompt:
> Using the attached image as the exact character reference, draw this hooded
> mage standing, full body, centered, facing forward, arms relaxed. Pixel-art,
> transparent background, single character only, no staff-less changes, no
> companion, no scenery. Square canvas.

Save it as `states/idle.png`, then:
```sh
cd ~/dev/clanky/tools/petdex-sprite
./.venv/bin/python build_sheet.py --in ./states --default ./states/idle.png
```

## Option B — expressive (one pose per state)
Generate one image per state so each activity has a distinct pose; the assembler
still adds light motion on top. Attach the reference every time and keep the
style identical. Save each as `states/<state>.png`.

| File | Pose to ask imagegen for |
|---|---|
| `states/idle.png` | standing, relaxed, calm |
| `states/running-right.png` | mid-stride running to the right, leaning forward |
| `states/running-left.png` | (optional — assembler mirrors running-right if absent) |
| `states/waving.png` | one arm raised waving hello |
| `states/jumping.png` | crouched/launching, both feet off ground |
| `states/failed.png` | slumped, dejected, head down |
| `states/waiting.png` | standing, patient, looking around |
| `states/running.png` | jogging in place, arms pumping |
| `states/review.png` | leaning in, inspecting, hand to chin / focused |

Each prompt template:
> Using the attached image as the exact character reference, draw this hooded
> mage <POSE>. Pixel-art, transparent background, full body, centered, single
> character only, no companion, no scenery. Square canvas, same colors and
> proportions as the reference.

Then:
```sh
cd ~/dev/clanky/tools/petdex-sprite
./.venv/bin/python build_sheet.py --in ./states --default ./states/idle.png
```

## True frame-by-frame animation (optional, best)
If you get multiple frames for a state (e.g. from a real animation tool), put
them in a folder `states/<state>/01.png 02.png ...` and the assembler uses them
as-is (no faked motion). Mix and match: folders for animated states, single
PNGs for the rest.

## After building
`build_sheet.py` writes to `~/.codex/pets/clanky/` by default. Then:
```sh
npx petdex init          # desktop app + sidecar (once)
npx petdex select clanky
```
Add `CLANKY_PET=1` to `~/dev/clanky/.env.local`, then `clanky down && clanky up`.
