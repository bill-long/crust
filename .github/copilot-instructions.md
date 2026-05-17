# Copilot instructions for Crust

Crust is a self-hosted, opinionated Matrix client targeting Discord-class polish.
Stack: **TypeScript · SolidJS · Vite 8 · Tailwind CSS 4 · Kobalte · matrix-js-sdk · Biome · pnpm**.

Read `.github/agents/ui-engineer.md` for the full UI/SolidJS/Tailwind/Matrix
playbook. **When that file and this one disagree, this file wins** — it has
been audited against current code; a few sections of the playbook (notably
"no cross-feature imports", the `Room.localEchoUpdated` reconciliation flow,
and the "refs must use definite-assignment `!`" rule) are aspirational or
stale and do not match the codebase. Issue #54 tracks reconciling them.
This file covers what you must know before touching code.

## Commands

```bash
pnpm install
pnpm dev          # Vite dev server
pnpm lint         # Biome (format + lint + import order); use lint:fix to auto-write
pnpm typecheck    # tsc --noEmit
pnpm test         # Vitest, single run
pnpm test:watch   # Vitest watch mode
pnpm build        # Production build
```

Run a single test file: `pnpm test path/to/file.test.ts`
Run a single test by name: `pnpm test -t "name pattern"`

**Before declaring any task complete:** the build-gate from
`.github/skills/code-review/SKILL.md` is `pnpm typecheck && pnpm lint && pnpm build`
(all must pass, in that order). Also run `pnpm test` if you touched anything
covered by tests.

## Architecture

Three-pane Discord-style layout driven by `@solidjs/router` routes in `src/app/App.tsx`:
`/`, `/login`, `/home/:roomId?`, `/space/:spaceId/:roomId?`, `/dm/:roomId`,
`/settings/*`.

Boot flow: `App` → `ConfigProvider` (loads `/config.json` at runtime) →
`AuthGuard` (redirects to `/login` if no session) → `ClientProvider` (owns the single
`MatrixClient`, sync lifecycle, crypto bootstrap, and the `SummariesStore`) →
`SyncGate` (renders spinner until initial sync) → `Layout`.

`src/client/summaries.ts` maintains a `SummariesStore` (`Record<roomId, RoomSummary>`)
that mirrors per-room state (name, avatar, last message, unread/highlight counts,
encrypted/DM/space flags, space children) by subscribing to matrix-js-sdk events.
**Room-list / sidebar / unread surfaces read from the summaries store** for cheap
reactivity; in-room views (composer, timeline) still call `client.getRoom(...)`
directly when they need member lists, receipts, or live timeline events. Unread
/ highlight counts come from sync state, never `/v3/notifications`.

Folder rules (`src/`):
- `components/` — Matrix-agnostic presentational primitives.
- `features/{auth,crypto,emoji,gif,room,settings,space}/` — feature-scoped UI +
  hooks + local stores. Cross-feature imports exist (e.g. `settings` consumes
  `crypto`, `room` consumes `space`, `room/timeline` consumes `emoji`/`gif`);
  keep them shallow and one-directional, and prefer routing new shared logic
  through `stores/` or `client/`.
- `client/` — owns the long-lived `MatrixClient`, sync state, crypto
  bootstrap, and the `SummariesStore`. `matrix-js-sdk` is imported throughout
  `features/` and `app/` — not just types and event enums but also runtime
  helpers and classes (`TimelineWindow` / `Direction` in
  `src/features/room/timeline/useTimeline.ts`; `decodeRecoveryKey` from
  `matrix-js-sdk/lib/crypto-api/recovery-key` in
  `src/features/crypto/backup/RecoveryKeyInput.tsx`; etc.) — and a few
  specific paths legitimately drive lifecycle outside `src/client/` (login
  probing in `src/features/auth/LoginPage.tsx` creates a temporary client;
  `src/app/Layout.tsx` and `src/app/App.tsx` call `logout` / `stopClient` /
  `clearStores` on session end). Don't introduce a second long-lived sync
  client; follow the existing patterns rather than refactoring opportunistically.
  CONTRIBUTING.md's stricter "never import the SDK from UI" rule is aspirational.
- `stores/` — app-wide Solid stores (`session`, `settings`, `layout`,
  `cryptoActions`).
- `app/` — shell, providers, routing, the `useDecodedParams` hook.

## Conventions that bite if ignored

- **Use `useDecodedParams()` from `src/app/useDecodedParams.ts`**, never
  `useParams()` from `@solidjs/router`. Matrix IDs contain `:` and arrive
  percent-encoded; raw params will not match room/space IDs.
- **Navigation / route selection uses `aria-current`** (sidebar items,
  room/space list, settings tabs). **Toggle buttons use `aria-pressed`**
  (Members pane toggle in `Layout.tsx`, reaction pills in `TimelineItem.tsx`,
  segmented choices in `GeneralTab.tsx`, emoji-picker category tabs). Pick
  the one that matches the control's role; don't substitute one for the other.
- **Trim user-visible room/space names before fallback**; treat whitespace-only
  names as missing (see `src/app/Layout.tsx`, `src/features/space/spaceHierarchy.ts`).
- **App zoom** is a CSS variable (`--app-zoom`) with `html { height: calc(100vh / var(--app-zoom)) }`
  and an unbroken `h-full` chain — do not introduce `h-screen` anywhere in the tree
  or you will break the zoom feature.
- **Spaces sidebar** width is user-resizable 48–96px (default 64) via
  `ResizableLayout` persisted pane widths. Keep both bounds in sync if you touch it.
- **User actions with a network round-trip** (send, react, edit, redact) are
  fired-and-awaited via `matrix-js-sdk` directly in the handler with a
  try/catch. `matrix-js-sdk` itself inserts a local echo into the room timeline
  immediately (temporary `~`-prefixed event ID, reconciled when the server
  responds), so the new message *does* appear without waiting for the next
  sync. What is **not** built yet is a centralized per-message
  `sending|sent|failed` store with a retry affordance. Failure UX is
  inconsistent today: the composer (`src/features/room/composer/Composer.tsx`)
  surfaces send/edit errors via a local `setError` inline alert (rendered
  `role="alert"` in the composer), but reaction and
  redaction failures in `src/features/room/timeline/TimelineView.tsx` only
  `console.error` — fix the surrounding handler if you're adding a new one,
  don't replicate the silent path. See issue #53 for the planned optimistic-UI
  work. `.github/agents/ui-engineer.md` describes the Discord-polish targets
  (sub-200ms = no spinner) that constrain new handlers.
- **Virtualize** large lists with `@tanstack/solid-virtual`. Today only the
  member list (`src/features/room/MemberList.tsx`) and the timeline
  (`src/features/room/timeline/TimelineView.tsx`) are virtualized; the room
  list (`RoomList.tsx`) and the GIF / emoji pickers still use plain `<For>`
  and should be virtualized when they grow (forward-looking, not a blocker
  on small instances).
- **Design tokens only** — no raw Tailwind palette colors (`bg-zinc-*`, `text-slate-*`)
  in components. Tokens live in the `@theme` block of `src/styles/global.css`;
  the namespaces are `surface-{0..4}`, `text-{primary,emphasis,secondary,muted,disabled,faint}`,
  `border-{subtle,default,strong,focus}`, semantic colors (`accent`, `success`,
  `warning`, `danger`, `info`), and the standalone tokens `mention-bg` and
  `indicator`. Each semantic family defines a different subset of `-text` / `-text-bright` / `-text-muted` / `-bg` /
  `-border` / `-foreground` / `-hover` / `-strong` variants — **grep `global.css`
  before assuming a variant exists** (e.g. `info` has only `-text` and
  `-border`). Tailwind v4 is configured in CSS; there is no `tailwind.config.ts`.
  Known existing exceptions: dialog backdrops use `bg-black/60`
  (`SettingsOverlay`, crypto dialogs, etc.), the avatar-upload overlay in
  `AccountTab.tsx` uses `bg-black/40`, and the `SettingsControls` toggle
  thumb uses `bg-white`. Match those when extending the same patterns;
  otherwise use tokens.
- **SolidJS reactivity:** never destructure `props` in a component signature
  or destructure reactive *fields* off a Solid store (you lose reactivity).
  Destructuring stable, non-reactive values off a hook return is fine and
  routine (`const { client } = useClient()`). Render conditional JSX with
  `<Show when={...}>` / `<For>` / `<Index>` / `<Switch>` rather than the
  `{cond && <Component />}` pattern (booleans inside the `when=` expression
  itself are fine). Use `createStore` (not nested signals) for nested state.
  `onMount` / `onCleanup` are for DOM/listener side effects; `createEffect`
  is for reactive tracking — they are not interchangeable.
- **HTML message bodies** must be sanitized with DOMPurify before render.
- **E2EE** uses the rust-crypto stack (`initRustCrypto()`); secret-storage key
  prompts go through `ClientProvider.requestRecoveryKey` /
  `setRecoveryKeyResolver`. Ask before touching the crypto init path.
- **Conduwuity quirk:** the SDK throws 404 on `/_matrix/client/v3/voip/turnServer`.
  Suppress it in logs — voice/video uses LiveKit via `org.matrix.msc4143.rtc_foci`.

## Style

- Biome owns formatting (**tabs, double quotes**) and import ordering — run
  `pnpm lint:fix` rather than hand-formatting.
- Function components, named exports, PascalCase filenames matching the component.
- Props interfaces suffixed `Props`, declared inline or just above the component.
- Refs default to `let el: HTMLDivElement | undefined; <div ref={el}>` (use
  the specific element type for the element you're referencing) with
  null/undefined checks at use sites — this is the dominant pattern
  (`TimelineView.tsx`, `Composer.tsx`, `GifPicker.tsx`, `MemberList.tsx`,
  etc.). The definite-assignment form `let el!: HTMLDivElement` is used in a
  couple of places (`SettingsOverlay.tsx`, `AccountTab.tsx`) when the code
  unconditionally needs the element after mount; match the surrounding file.
- No `// @ts-ignore` / `// biome-ignore` without an inline justification.
- No emojis in comments, log messages, commit messages, or as code-level
  decoration. Intentional emoji *icons* inside user-facing UI (e.g. 🔒 for
  encryption, 😀 for the picker trigger) are fine.

## Ask before

- Adding a top-level dependency.
- Changing the design-token palette or theme structure.
- Touching the crypto/E2EE init path or the SDK client lifecycle
  (login, logout, sync).

## Reference

- `.github/agents/ui-engineer.md` — full UI/SolidJS/Tailwind/Matrix playbook.
  **This file overrides it on any conflict** (see the note at the top).
- `.github/skills/code-review/SKILL.md` — mandatory local code-review workflow.
- `CONTRIBUTING.md` — PR expectations.
- `README.md` — product scope and self-hosting.
