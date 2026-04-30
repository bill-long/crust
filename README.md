# Crust

A self-hosted, opinionated Matrix client for Discord-style communities.

Built for [chat.strange.pizza](https://chat.strange.pizza) first; open-sourced
under Apache-2.0.

> **Status: Phase 0 — scaffolding.** Not usable yet.

## What Crust is

- Spaces-first navigation (no global room list dumping ground)
- Real `@mentions` with proper Matrix metadata
- Per-room and per-space unread badges computed from sync state (no
  `/v3/notifications` dependency)
- E2EE by default for DMs, with SAS verification and key backup
- GIF search (Giphy / Klipy) as an opt-in operator feature
- Embedded MatrixRTC calls via self-hosted Element Call
- Strict Content Security Policy from day one

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
