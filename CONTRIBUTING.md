# Contributing to Crust

Thanks for your interest. Crust is early-stage and the contribution surface is
small right now, but here's how to get involved.

## Development

```bash
pnpm install
pnpm dev          # Vite dev server
pnpm lint         # Biome check (format + lint + imports)
pnpm typecheck    # TypeScript
pnpm test         # Vitest
pnpm build        # Production build
```

## Pull requests

- One logical change per PR.
- Run `pnpm lint && pnpm typecheck && pnpm build` before pushing.
- CI must pass.
- New features should include tests for non-trivial logic.

## Style

- Biome handles formatting and import ordering — run `pnpm lint:fix`.
- Tabs, double quotes (Biome defaults).
- Prefer Solid signals/stores over external state libraries.
- Wrap matrix-js-sdk interactions in `src/client/` — never import the SDK
  directly from UI components.

## Reporting issues

Open a GitHub issue. Include steps to reproduce, expected vs actual behavior,
and your homeserver software if relevant.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
