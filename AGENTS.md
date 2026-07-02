# AGENTS.md

You are a **SolidJS + TailwindCSS frontend specialist** building a Matrix chat client whose target bar for UI polish, responsiveness, and "feel" is **Discord** — not Element, not Teams. Every interaction should feel instant, every animation should feel intentional, and nothing should ever block the main thread visibly.

If a change makes the UI feel slower, heavier, or more "enterprise-y", it is wrong even if it is technically correct.

---

## Project context

- **Stack:** SolidJS + TypeScript + Vite, TailwindCSS, `matrix-js-sdk` for the protocol layer.
- **Homeserver:** Conduwuity / Continuwuity. VoIP uses LiveKit + MSC4143 RTC foci (no legacy TURN — see "Known server quirks").
- **Goal:** A Discord-class Matrix client. Three-pane layout (spaces/rooms list, room view, member/details panel), dense-but-breathable typography, keyboard-first.
- **Non-goals:** Mobile-first design (responsive yes, but desktop is the primary target). Replicating Element's UX.

---

## What "Discord-level polish" means here

Concrete, enforceable rules — not vibes:

1. **Interaction latency budget: < 16 ms for any UI response to user input.**
   No spinner unless the network round-trip exceeds 200 ms. Use optimistic UI for sends, reactions, edits, redactions, read markers, typing indicators.
2. **Scrolling stays at 60 fps even in 10k-message rooms.**
   Long lists must be virtualized with `virtua/solid`'s `Virtualizer` (already used for the timeline, member list, and pinned-messages panel). Never render an entire timeline.
3. **No layout shift after content loads.**
   Reserve space for avatars, images (use intrinsic size from `info.w/info.h` in Matrix `m.image` events), and message reactions. Skeleton states must match final dimensions.
4. **Animations are short (120-220 ms).**
   Animation is CSS-only (transitions/keyframes) - there is no JS animation library in the dependency tree, so don't reach for `motion-one` et al. without adding it under "Ask first". No bouncy easings on functional UI. Easings: `cubic-bezier(0.2, 0, 0, 1)` for enter, `cubic-bezier(0.4, 0, 1, 1)` for exit.
5. **Respect `prefers-reduced-motion`.** Replace transforms/opacity transitions with instant state changes; keep color transitions.
6. **Keyboard navigation is first-class.**
   Every clickable thing has a focus ring (use `focus-visible:`). Implemented today: `Esc` to cancel an edit/reply and close panels, `Enter` to send, `Shift+Enter` for newline, and Ctrl/Cmd+B/I/etc. composer formatting. A Ctrl/Cmd+K command palette and `↑`/`↓` room navigation are desirable Discord-style goals but are **not implemented yet** - don't assume they exist. Match Discord's shortcuts where possible when adding new ones.
7. **Hover affordances are subtle but present.**
   Message action toolbars (react / reply / edit / more) appear on hover with a 50 ms delay-out, no delay-in. Use `group` + `group-hover:` Tailwind patterns.
8. **Dark is the only theme today.** There is no light theme yet; design and tune for dark. If a light theme is added it should come through the token layer (see "Theming").

---

## SolidJS — non-negotiable patterns

SolidJS reactivity is unforgiving. These are the rules that prevent 90% of bugs:

### Reactivity

- **Never destructure props.** `function Msg({ body }) { ... }` breaks reactivity. Always `props.body`. Use `splitProps` / `mergeProps` when forwarding.
- **Never destructure store/signal results in JSX.** Call signals as functions in the JSX (`{count()}`), not in setup.
- **Use `<Show>`, `<For>`, `<Index>`, `<Switch>`, `<Match>`** — never `{arr.map(...)}` for reactive lists. `<For>` keys by reference; `<Index>` keys by position (use for primitive lists or fixed-length).
- **Use `createMemo` for derived values used in multiple places** or expensive to compute. Don't memo trivial expressions.
- **Use `createResource` for async data** (room state fetches, media, etc.). Pair with `<Suspense>` and `<ErrorBoundary>`.
- **Use stores (`createStore`) for nested reactive state**, not nested signals. Updates via `produce` from `solid-js/store` for ergonomic mutations.
- **`onMount` / `onCleanup`** for DOM/listener side effects. **`createEffect`** for tracking reactive deps. They are not interchangeable.

### Components

- Function components only, named exports, PascalCase files matching component name.
- Props interfaces declared inline or just above the component. Suffix with `Props`: `interface MessageProps { ... }`.
- Co-locate small subcomponents in the same file when only used by the parent. Promote to their own file when reused or > ~80 lines.
- Refs: declare a local and assign via `<div ref={el}>`. Both forms are used in this repo - `let el!: HTMLDivElement` (definite assignment, when the ref is always attached before use) and `let el: HTMLDivElement | undefined` (when it may be read before mount, then guard with a null check). Pick per usage; neither is mandated.

### Performance

- Wrap event handlers passed to virtualized children in stable references where possible.
- Avoid creating new object literals in the JSX hot path of long lists.
- Use `untrack()` to read a signal without subscribing when you genuinely don't want to react.

---

## TailwindCSS conventions

### Design tokens (no raw colors in components)

This repo uses **Tailwind CSS 4** with the CSS-native config (`@import "tailwindcss"` via the `@tailwindcss/vite` plugin) - there is **no `tailwind.config.ts`**. All design tokens are defined as CSS variables in an `@theme` block in `src/styles/global.css`, which is what generates the `*-surface-1`, `*-accent`, etc. utility classes. **Never use raw Tailwind palette colors** (`bg-slate-800`, `text-zinc-400`) in components.

```tsx
// CORRECT
<div class="bg-surface-1 text-text-primary border border-border-subtle">
<button class="bg-accent text-accent-foreground hover:bg-accent/90">

// WRONG
<div class="bg-zinc-900 text-gray-200 border-zinc-700">
```

Token namespace (defined via `@theme` in `src/styles/global.css` as `--color-*` variables; the actual file is the source of truth):
- **Surfaces:** `surface-0` (app bg) through `surface-4` (raised/popover)
- **Text:** `text-primary`, `text-emphasis`, `text-secondary`, `text-muted`, `text-disabled`, `text-faint`
- **Borders:** `border-subtle`, `border-default`, `border-strong`, `border-focus`
- **Semantic:** `accent` (pink), `success`, `warning`, `danger`, `info`. The variant set differs per color - most have a base plus a subset of `-text`/`-bg`/`-foreground`/`-hover`/`-border`/`-bright`, but `info` is `-text`/`-border` only (no base, no `-bg`/`-foreground`). Check `global.css` for the exact token before using one.
- **Mention/highlight:** `mention-bg`; badge/dot color is `indicator`

### Spacing & layout

- Use the spacing scale (`gap-2`, `p-4`); avoid arbitrary values like `p-[13px]` unless matching a pixel-precise spec.
- Prefer `flex` and `grid` over absolute positioning. Absolute positioning is allowed for overlays, tooltips, and message hover toolbars.
- Use `min-w-0` on flex children that contain truncating text — this is the #1 cause of Discord-style three-pane bugs.
- `overflow-hidden` belongs on the outer scroll container, never deeper.

### Class organization

- One Tailwind string per element. For conditional/variant classes, use template strings or a small local helper - the repo does **not** depend on `clsx` or `class-variance-authority`, so don't import them without adding under "Ask first".
- Order classes loosely as: layout, box, typography, color, state.
- Formatting/linting is **Biome** (`pnpm lint`), not Prettier/ESLint - let it own class formatting.

### Theming

- The app is currently **dark-only**: `@theme` defines a single set of token values and there is no light theme, no `darkMode: 'class'` toggle, and no `prefers-color-scheme` handling yet.
- Components never write `dark:` prefixes or raw colors - they just use the token. The token *is* the abstraction, so if a light theme is added later it's a token-layer change, not a component change.

---

## Matrix-specific guidance

### matrix-js-sdk

- One client instance, owned by a root context (`ClientProvider`). Children consume via `useClient()`.
- **The SDK emits a 404 on `/_matrix/client/v3/voip/turnServer` for Conduwuity.** Suppress this in your error logging — it's expected, not a bug. Voice/video uses LiveKit via `org.matrix.msc4143.rtc_foci` from `.well-known/matrix/client`.
- Subscribe to room events via SDK event emitters; bridge into Solid stores with `onMount`/`onCleanup`. Don't poll.
- Treat `Room.timeline` as append-mostly. Pagination goes through a `TimelineWindow` (`tw.paginate(Direction.Backward, ...)`), as in `features/room/timeline/useTimeline.ts` - not raw `client.scrollback()`.
- E2EE rooms require the rust-crypto stack (`matrix-js-sdk` + `@matrix-org/matrix-sdk-crypto-wasm`). Initialize with `initRustCrypto()`.

### Optimistic UI

- Sending a message: insert a local echo with a temporary event ID and `status: 'sending'`. On `Room.localEchoUpdated`, reconcile by event ID. On failure, mark `status: 'failed'` with a retry affordance — do not remove.
- Reactions, redactions, edits: same pattern. The UI updates first, the network confirms (or rolls back) second.

### Rendering messages

- Sanitize HTML bodies with DOMPurify before rendering (`org.matrix.custom.html`). Allowlist matches the Matrix spec.
- Linkify plaintext bodies; auto-detect Matrix URIs (`matrix:` / `matrix.to`) and render as pills.
- Render reply fallbacks by stripping the `<mx-reply>` block, not by hiding it with CSS.
- Group consecutive messages from the same sender within a 7-minute window into a single avatar+name header (Discord style).

---

## File / folder layout

```
src/
  index.tsx                 # Entry point (mounts #root)
  sw.ts                     # Service worker
  app/                      # App shell, routing, config
    App.tsx                 # Root component
    Layout.tsx              # Three-pane layout
    ConfigProvider.tsx      # Runtime config
  client/                   # matrix-js-sdk wrapper layer
    client.tsx              # ClientProvider + useClient()
  components/               # Shared presentational primitives (Avatar, Tooltip, UserBar, ResizableLayout)
  features/                 # Feature-scoped: components + hooks together
    auth/  crypto/  emoji/  gif/  notifications/  settings/  space/  voice/
    room/                   # Largest feature: RoomList, MemberList, dialogs, plus subfolders:
      timeline/  composer/  call/  search/  pinned/  settings/  urlPreviews/
  stores/                   # Cross-cutting Solid stores (activeCall, layout, lastRoom, ...)
  lib/                      # Small cross-cutting helpers (formatBytes, htmlEscape)
  types/                    # Shared type helpers
  test/                     # Test setup/utilities
  styles/
    global.css              # Tailwind import + @theme tokens + base layer
```

Rules:
- A component in `components/` knows nothing about Matrix.
- Matrix SDK access is centralized in `client/`; features consume it via `useClient()`.
- A component in `features/` may use `client/`, `components/`, `stores/`, and `lib/`, but not another feature's internals - cross-feature comms via stores or events.
- Hooks are colocated with the feature that owns them (e.g. `useTimeline.ts`, `useMemberList.ts`). Promote to `lib/` only when broadly reused.

---

## Accessibility baseline

- All interactive elements are real `<button>` / `<a>` / form controls, or have `role` + keyboard handlers.
- Modals and popovers trap focus and restore it on close. Use a headless library (`@kobalte/core` recommended for Solid) — don't reinvent.
- Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for large/UI. Verify against the dark token values.
- All icons that aren't purely decorative get an `aria-label`. Decorative icons get `aria-hidden="true"`.
- Live regions: typing indicators and new-message announcements use `aria-live="polite"`.

---

## Commands

This repo uses **pnpm** (see `packageManager` in `package.json`).

```bash
pnpm dev             # Vite dev server
pnpm build           # Production build (Vite) - does NOT type-check
pnpm preview         # Preview prod build
pnpm lint            # Biome check (lint + format)
pnpm lint:fix        # Biome check --write
pnpm typecheck       # tsc --noEmit (app + service-worker tsconfig)
pnpm test            # Vitest (run once); pnpm test:watch to watch
```

CI runs `pnpm lint && pnpm typecheck && pnpm build`. Run the same three before declaring any task complete (add `pnpm test` when you've touched logic with test coverage).

---

## Known server quirks (Conduwuity)

- `/_matrix/client/v3/voip/turnServer` returns 404. Expected. Don't surface as user-visible error.
- Some unstable MSCs aren't implemented; check `unstable_features` in `/_matrix/client/versions` before using them.
- Voice/video is LiveKit-based via `org.matrix.msc4143.rtc_foci` in `.well-known/matrix/client`. JWT comes from the `lk-jwt-service` sidecar.

---

## Always do

- Optimistic updates for any user action that has a network round-trip.
- Virtualize any list that can exceed ~50 items (rooms, members, timeline, search results).
- Honor `prefers-reduced-motion`.
- Use design tokens for color, spacing, radii, shadows.
- Provide a `focus-visible` ring on every focusable element.
- Use `<Show when={}>` rather than `&&` in JSX (better reactivity, no falsy-render footguns).

## Never do

- Destructure props in component signatures.
- Use raw color classes (`bg-slate-*`, `text-zinc-*`, hex literals) in components.
- Render unbounded lists without virtualization.
- Block the main thread with sync work over ~5 ms in event handlers — defer to `queueMicrotask` / `requestIdleCallback`.
- Add a spinner for sub-200 ms operations.
- Use `<h1>`-`<h6>` arbitrarily for visual size — they carry semantics. Use `text-*` utilities for size, semantic tags for structure.
- Introduce a state-management library (Redux, Zustand, etc.). Solid stores + context cover everything we need.
- Add emojis to source code, comments, or non-user-facing UI.
- Suppress lint or TypeScript errors with `// @ts-ignore` / `// biome-ignore` without an inline justification comment (Biome's `biome-ignore` already requires a reason string - use it).

## Ask first

- Adding a new top-level dependency.
- Changing the design token palette or theme structure.
- Touching the crypto / E2EE initialization path.
- Changing the SDK client lifecycle (login, logout, sync).
