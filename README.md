# Crust

A self-hosted, opinionated Matrix client for Discord-style communities.

Built for the [strange.pizza](https://strange.pizza) community; open-sourced
under Apache-2.0. Public deploy at
[strange.pizza/crust](https://strange.pizza/crust).

> **Status: Post-Phase 6 — polish and notifications.** Phases 0–6 shipped.
> Cutover from Cinny is planned but not yet scheduled.

## Why Crust exists

We wanted to send GIFs on Matrix. No client could do it — every GIF provider
prohibits re-hosting, and no Matrix client renders third-party URLs inline. So we
built one that does. Everything else (spaces-first nav, real mentions, E2EE,
calls) is table stakes for a chat client we'd actually use daily.

## What Crust is

- Spaces-first navigation (no global room list dumping ground)
- Real `@mentions` with proper Matrix metadata
- Per-room and per-space unread badges computed from sync state (no
  `/v3/notifications` dependency)
- E2EE by default for DMs, with SAS verification and key backup
- Custom emoji and image packs (MSC2545)
- GIF search (Giphy / Klipy) — opt-in, TOS-compliant
- Desktop notifications with per-room levels (default / all / mentions-only / mute)
- Native MatrixRTC voice/video calls (LiveKit-backed, end-to-end encrypted);
  optional fallback to embedded Element Call iframe
- Strict Content Security Policy from day one

## GIF search — how and why

Every GIF provider (Giphy, Tenor, Klipy) prohibits downloading and re-hosting
their content — GIFs must be served from the provider's CDN. But no Matrix
client renders third-party URLs inline; only images uploaded to the homeserver
(`m.image` with an MXC URI) display as inline media. These two requirements are
mutually exclusive, which is why **no Matrix client has shipped a native GIF
picker.**

Crust resolves this honestly:

1. **Send**: the selected GIF is sent as a normal text message containing the
   provider's CDN URL. This complies with provider TOS.
2. **Render**: Crust recognizes GIF provider URLs in the timeline and renders
   them inline, fetching directly from the CDN.
3. **Cross-client**: recipients using other Matrix clients see a clickable link
   instead of an inline GIF. This is a trade-off we're transparent about.
4. **Encrypted rooms**: the URL is encrypted in the message body, but when Crust
   fetches the GIF for display, the user's IP is visible to the CDN. This is the
   same trade-off as URL previews.

GIF search is **off by default**. The operator enables it in `config.json` by
providing a provider API key. Content rating defaults to `g`.

For local development, copy `.env.example` to `.env.local` and set
`VITE_GIF_API_KEY` (and `VITE_GIF_ENABLED=true`) there instead of editing
`config.json` — `.env.local` is gitignored so your key won't be committed.
Any valid `VITE_GIF_*` value overrides the matching field in `config.json`;
unset, empty, or otherwise invalid values are ignored.

## What Crust is not

- A mobile app (responsive enough to use, not optimized — desktop-first is the
  whole point: a dense, keyboard-first, three-pane layout)
- A bridge management UI (bridges are a server-side operator concern, configured
  out-of-band)
- An SSO/OIDC client (password auth only — our homeserver, Continuwuity, has no
  OIDC login support yet; this is a "not yet," not a "never," and worth
  revisiting if that changes)
- A clone of Element's full feature surface (features are chosen intentionally
  rather than to reach 100% parity — this rules out labs and niche admin
  surfaces, *not* mainstream features like threads or polls, which remain fair
  game)

## Tech stack

TypeScript · Solid · Vite · Tailwind v4 · Kobalte · matrix-js-sdk · Biome

## Quick start

```bash
pnpm install
pnpm dev
```

## Self-hosting

Crust is a static site. Build the Docker image and serve it behind any reverse
proxy.

```bash
docker build -t crust .
docker run -p 8080:80 -v $(pwd)/config.json:/usr/share/nginx/html/config.json:ro crust
```

Mount your own `config.json` to set the default homeserver, enable GIF search,
etc.

### Hosting under a sub-path

To host the app at `https://example.com/crust/` instead of the domain root,
build with the `VITE_BASE_PATH` Docker build arg (trailing slash required):

```bash
docker build --build-arg VITE_BASE_PATH=/crust/ -t crust .
```

This bakes `/crust/` into the asset URLs and the in-app router. The container
still serves at its own root (`/`), so put a reverse proxy in front that
strips the `/crust` prefix before forwarding to the container — for example
with nginx:

```nginx
# Redirect the bare mount point so /crust → /crust/ (nginx's location
# match below only handles trailing-slash URLs).
location = /crust {
    return 301 /crust/;
}
location /crust/ {
    proxy_pass http://crust:80/;
}
```

You can also override the base path for a local build outside Docker:

```bash
VITE_BASE_PATH=/crust/ pnpm build
```

**Crust itself is one container.** Voice/video calls require self-hosting
[Element Call](https://github.com/element-hq/element-call) +
[LiveKit](https://livekit.io/) (separate containers). Push notifications
require a Web Push gateway (also separate). All optional.

## Tests

```bash
pnpm test              # full suite (jsdom + browser projects)
pnpm test:unit         # jsdom project only (fast, no Playwright needed)
pnpm test:watch        # vitest in watch mode
pnpm test:browser      # browser-mode only (headless Chromium via Playwright)
```

Most tests run in jsdom (the `unit` project). Layout-dependent tests live in
`*.browser.test.tsx` files (the `browser` project) and run inside a real
headless Chromium so `ResizeObserver`, RAF cadence, and scroll math behave
like a real browser. The browser project requires Playwright's Chromium
download (`pnpm exec playwright install chromium`) on first run, so `pnpm
test` fails without it - use `pnpm test:unit` for the fast, Playwright-free
path.

CI (`.github/workflows/ci.yml`) runs `pnpm test:unit` in the main job and the
`browser` project in a separate job that installs Chromium first, so both
projects gate every PR and push to `main`.

## License

[Apache-2.0](LICENSE)
