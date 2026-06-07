# PWA icon sources

The brand artwork is a pizza-crust letter "C" (golden, blistered, leopard-
charred dough). `crust-c.png` is the master artwork — the `C` extracted on a
transparent background.

`icon.svg` (rounded, `purpose: any`) and `icon-maskable.svg` (full-bleed,
`purpose: maskable`) are the sources for the PWA icons served from `public/`.
Both embed `crust-c.png` as a base64 `<image>` over the brand-pink background
(`#e33e7f`); the maskable variant insets the artwork into the central safe
zone. `public/favicon.svg` embeds the same master on a rounded pink tile.

The PNGs in `public/` (`pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png`,
`apple-touch-icon.png`) are generated from these with sharp:

```bash
pnpm dlx sharp-cli -i design/icons/icon.svg          -o public/pwa-192.png          resize 192 192
pnpm dlx sharp-cli -i design/icons/icon.svg          -o public/pwa-512.png          resize 512 512
pnpm dlx sharp-cli -i design/icons/icon-maskable.svg -o public/pwa-maskable-512.png resize 512 512
pnpm dlx sharp-cli -i design/icons/icon.svg          -o public/apple-touch-icon.png resize 180 180
```

These SVGs live outside `public/` so they are not served or precached. When
the artwork changes, re-extract `crust-c.png`, re-embed it in the three SVGs,
then re-run the sharp commands above to regenerate the PNGs.

The regenerated PNGs are then quantized to a 256-color palette (with
Floyd–Steinberg dithering) to keep the precached payload small — the detailed
artwork is ~7x smaller as a palette PNG with no visible quality loss at icon
sizes. For example, with Pillow:

```python
from PIL import Image
for f in ["pwa-192.png", "pwa-512.png", "pwa-maskable-512.png", "apple-touch-icon.png"]:
    im = Image.open(f"public/{f}").convert("RGBA")
    im.quantize(colors=256, method=Image.FASTOCTREE, dither=Image.FLOYDSTEINBERG).save(f"public/{f}", optimize=True)
```

`public/favicon.svg` embeds a downscaled (~64px), palette-quantized copy of the
master rather than the full-resolution artwork, since it only renders at 16–32px
and is served (and precached) on every page load.
