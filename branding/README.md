# Clanky Branding

Source pixel art and the crops used across the docs site and elsewhere.

## Layout

- `source/clanky-original.png` — original 778×1124 pixel-art portrait (hooded figure + cat companion). Untouched.
- `source/clanky-desert-world.png` — 1024×1024 pixel-art desert world scene with the hooded figure and companion.
- `source/clanky-forest-overlook.png` — 1024×1024 pixel-art mountain forest overlook scene with the hooded figure and companion.
- `source/clanky-forest-run.png` — 1024×1024 pixel-art green forest action scene with the hooded figure and companion.
- `masters/clanky-with-companion-880.png` — 880×880 square crop of the full figure + cat with breathing room. The primary brand image.
- `masters/clanky-figure-600.png` — 600×600 tight crop on the hood figure alone.
- `masters/clanky-icon-380.png` — 380×380 ultra-tight crop on the hood opening (glowing eyes). Best for small sizes.

Web-ready exports (PNG, all square) live in `apps/docs/public/branding/`:

| File | Source | Use |
|---|---|---|
| `clanky-logo-{64,128,256,512}.png` | with-companion master | header logo, OG image, hero |
| `clanky-figure-{256,512}.png` | figure master | alternative portrait variant |
| `clanky-icon-{16,32,48,64,96,128,256}.png` | face master | favicon, anywhere the logo gets small |
| `clanky-desert-world-1024.png` | desert world source | dramatic brand/world image, alternate hero, social preview |
| `clanky-forest-overlook-1024.png` | forest overlook source | docs start image and calm brand/world image |
| `clanky-forest-run-1024.png` | forest run source | using-Clanky image and active companion/agent image |
| `apple-touch-icon.png` (180×180) | with-companion master | iOS home-screen icon |

## Usage notes

- All images have a pure black (`#000000`) background and look best on dark surfaces. On light backgrounds they read as a colored tile — apply `rounded-md` or similar in CSS to soften the edge.
- For text-adjacent placements (header, mobile nav), the with-companion crop reads down to ~32px; below that, switch to the face/icon variant.
- The figure is intentional pixel art — do not anti-alias or upscale beyond 2× without resampling at integer ratios.
- The full-scene world images are square 1024px assets. Use them as docs hero/support images rather than small icons.

## Regenerating

The master crops were produced with `sips` from `clanky-original.png`:

```bash
# with-companion: full-width 880 vertical, then pad to 880×880
sips --cropOffset 240 0 --cropToHeightWidth 880 778 clanky-original.png --out tmp.png
sips --padToHeightWidth 880 880 --padColor 000000 tmp.png --out clanky-with-companion-880.png

# figure-only: centered on the hood figure
sips --cropOffset 360 178 --cropToHeightWidth 600 600 clanky-original.png --out clanky-figure-600.png

# icon: ultra-tight on the hood opening
sips --cropOffset 320 360 --cropToHeightWidth 380 380 clanky-original.png --out clanky-icon-380.png
```

Then resize each master into the sizes needed with `sips -z H W <master> --out <out>`.
