# Crust

A self-hosted, opinionated Matrix client for Discord-style communities.

Built for [chat.strange.pizza](https://chat.strange.pizza); open-sourced
under Apache-2.0. Public deploy at [crust.chat](https://crust.chat) coming soon.

> **Status: Phase 6 — GIF search.** Phases 0–5 shipped. Cutover from Cinny
> is planned but not yet scheduled.

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
- GIF search (Giphy / Klipy) — opt-in, TOS-compliant *(in progress)*
- Embedded MatrixRTC calls via self-hosted Element Call *(planned)*
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
   them inline, fetching directly from the CDN. Users can disable automatic
   fetching in settings (it defaults to on).
3. **Cross-client**: recipients using other Matrix clients see a clickable link
   instead of an inline GIF. This is a trade-off we're transparent about — if
   you want inline GIFs, use Crust.
4. **Encrypted rooms**: the URL is encrypted in the message body, but when Crust
   fetches the GIF for display, the user's IP is visible to the CDN. This is the
   same trade-off as URL previews. A brief privacy hint appears when sending.

GIF search is **off by default**. The operator enables it in `config.json` by
providing a provider API key. Content rating defaults to `g`.

## What Crust is not

- A mobile app (responsive enough to use, not optimized)
- A bridge management UI
- An SSO/OIDC client (password-auth only in v1)
- A replacement for Element's full feature surface

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

**Crust itself is one container.** Voice/video calls require self-hosting
[Element Call](https://github.com/element-hq/element-call) +
[LiveKit](https://livekit.io/) (separate containers). Push notifications
require a Web Push gateway (also separate). All optional.

## License

[Apache-2.0](LICENSE)
