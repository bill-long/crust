# PWA icon sources

`icon.svg` (rounded, `purpose: any`) and `icon-maskable.svg` (full-bleed,
`purpose: maskable`) are the sources for the PWA icons served from `public/`.

The PNGs in `public/` (`pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png`,
`apple-touch-icon.png`) are generated from these with sharp:

```bash
pnpm dlx sharp-cli -i design/icons/icon.svg          -o public/pwa-192.png          resize 192 192
pnpm dlx sharp-cli -i design/icons/icon.svg          -o public/pwa-512.png          resize 512 512
pnpm dlx sharp-cli -i design/icons/icon-maskable.svg -o public/pwa-maskable-512.png resize 512 512
pnpm dlx sharp-cli -i design/icons/icon.svg          -o public/apple-touch-icon.png resize 180 180
```

These SVGs live outside `public/` so they are not served or precached.
