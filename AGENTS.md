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
   Long lists must be virtualized (`@tanstack/solid-virtual` or hand-rolled). Never render an entire timeline.
3. **No layout shift after content loads.**
   Reserve space for avatars, images (use intrinsic size from `info.w/info.h` in Matrix `m.image` events), and message reactions. Skeleton states must match final dimensions.
4. **Animations are spring-based and short (120–220 ms).**
   Use CSS transitions for hover/focus, `motion-one` or `@motionone/solid` for entry/exit. No bouncy easings on functional UI. Easings: `cubic-bezier(0.2, 0, 0, 1)` for enter, `cubic-bezier(0.4, 0, 1, 1)` for exit.
5. **Respect `prefers-reduced-motion`.** Replace transforms/opacity transitions with instant state changes; keep color transitions.
6. **Keyboard navigation is first-class.**
   Every clickable thing has a focus ring (use `focus-visible:`). Ctrl/Cmd+K command palette, `↑`/`↓` to navigate rooms, `Esc` to close panels, `Enter` to send, `Shift+Enter` for newline. Match Discord's shortcuts where possible.
7. **Hover affordances are subtle but present.**
   Message action toolbars (react / reply / edit / more) appear on hover with a 50 ms delay-out, no delay-in. Use `group` + `group-hover:` Tailwind patterns.
8. **Dark mode is the default and primary theme.** Light theme must work but dark is what we tune for.

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
- Refs: `let el!: HTMLDivElement;` then `<div ref={el}>`. The `!` is required.

### Performance

- Wrap event handlers passed to virtualized children in stable references where possible.
- Avoid creating new object literals in the JSX hot path of long lists.
- Use `untrack()` to read a signal without subscribing when you genuinely don't want to react.

---

## TailwindCSS conventions

### Design tokens (no raw colors in components)

All colors come from CSS variables defined in `src/index.css` and exposed as Tailwind tokens in `tailwind.config.ts`. **Never use raw Tailwind palette colors** (`bg-slate-800`, `text-zinc-400`) in components.

```tsx
// CORRECT
<div class="bg-surface-1 text-text-primary border border-border-subtle">
<button class="bg-accent text-accent-foreground hover:bg-accent/90">

// WRONG
<div class="bg-zinc-900 text-gray-200 border-zinc-700">
```

Token namespace (define these in the config):
- **Surfaces:** `surface-0` (app bg), `surface-1` (panel), `surface-2` (raised), `surface-3` (popover/menu)
- **Text:** `text-primary`, `text-secondary`, `text-muted`, `text-disabled`
- **Borders:** `border-subtle`, `border-strong`, `border-focus`
- **Semantic:** `accent`, `success`, `warning`, `danger`, plus `-foreground` variants
- **Mention/highlight:** `mention`, `mention-bg`

### Spacing & layout

- Use the spacing scale (`gap-2`, `p-4`); avoid arbitrary values like `p-[13px]` unless matching a pixel-precise spec.
- Prefer `flex` and `grid` over absolute positioning. Absolute positioning is allowed for overlays, tooltips, and message hover toolbars.
- Use `min-w-0` on flex children that contain truncating text — this is the #1 cause of Discord-style three-pane bugs.
- `overflow-hidden` belongs on the outer scroll container, never deeper.

### Class organization

- One Tailwind string per element. If it exceeds ~120 chars, break into `clsx`/`cva` (`class-variance-authority`) variants.
- Order classes loosely as: layout → box → typography → color → state. Don't fight Prettier's tailwind plugin if it's installed.
- Use `cva` for any component with > 2 visual variants (buttons, badges, message bubbles).

### Dark mode

- Use `class` strategy (`darkMode: 'class'`). Toggle on `<html>`.
- All tokens have a dark variant defined in CSS — components don't write `dark:` prefixes; they just use the token. The token *is* the abstraction.

---

## Matrix-specific guidance

### matrix-js-sdk

- One client instance, owned by a root context (`ClientProvider`). Children consume via `useClient()`.
- **The SDK emits a 404 on `/_matrix/client/v3/voip/turnServer` for Conduwuity.** Suppress this in your error logging — it's expected, not a bug. Voice/video uses LiveKit via `org.matrix.msc4143.rtc_foci` from `.well-known/matrix/client`.
- Subscribe to room events via SDK event emitters; bridge into Solid stores with `onMount`/`onCleanup`. Don't poll.
- Treat `Room.timeline` as append-mostly. For pagination, use `client.scrollback()`.
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
  app/                      # App shell, providers, routing
    Providers.tsx           # ClientProvider, ThemeProvider, etc.
    Shell.tsx               # Three-pane layout
  features/                 # Feature-scoped: components + hooks + stores together
    rooms/
      RoomList.tsx
      RoomListItem.tsx
      useRoomList.ts
    timeline/
      Timeline.tsx
      Message.tsx
      MessageActions.tsx
      useTimeline.ts
    composer/
    members/
    spaces/
    call/                   # LiveKit / MSC4143
  ui/                       # Pure presentational primitives (Button, Tooltip, Popover, ...)
  matrix/                   # SDK wrappers, type helpers, event predicates
  lib/                      # Cross-cutting helpers (formatters, hotkeys, virtualization)
  styles/
    index.css               # Tokens + base layer
  main.tsx
```

Rules:
- A component in `ui/` knows nothing about Matrix.
- A component in `features/` may use `matrix/` and `ui/` but not other features' internals — cross-feature comms via stores or events.
- Hooks colocated with the feature that owns them. Promote to `lib/` only when used by 3+ features.

---

## Accessibility baseline

- All interactive elements are real `<button>` / `<a>` / form controls, or have `role` + keyboard handlers.
- Modals and popovers trap focus and restore it on close. Use a headless library (`@kobalte/core` recommended for Solid) — don't reinvent.
- Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for large/UI. Verify in dark *and* light themes.
- All icons that aren't purely decorative get an `aria-label`. Decorative icons get `aria-hidden="true"`.
- Live regions: typing indicators and new-message announcements use `aria-live="polite"`.

---

## Commands

```bash
npm run dev          # Vite dev server
npm run build        # Type-check + production build
npm run preview      # Preview prod build
npm run lint         # ESLint (solid + tailwindcss plugins)
npm run typecheck    # tsc --noEmit
npm run test         # Vitest
```

Run `npm run lint && npm run typecheck` before declaring any task complete.

---

## Known server quirks (Conduwuity)

- `/_matrix/client/v3/voip/turnServer` returns 404. Expected. Don't surface as user-visible error.
- Some unstable MSCs aren't implemented; check `unstable_features` in `/_matrix/client/versions` before using them.
- Voice/video is LiveKit-based via `org.matrix.msc4143.rtc_foci` in `.well-known/matrix/client`. JWT comes from the `lk-jwt-service` sidecar.

---

## Always do

- Optimistic updates for any user action that has a network round-trip.
- Virtualize any list that can exceed ~50 items (rooms, members, timeline, search results).
- Honor `prefers-reduced-motion` and `prefers-color-scheme`.
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
- Suppress lint or TypeScript errors with `// @ts-ignore` / `eslint-disable` without an inline justification comment.

## Ask first

- Adding a new top-level dependency.
- Changing the design token palette or theme structure.
- Touching the crypto / E2EE initialization path.
- Changing the SDK client lifecycle (login, logout, sync).
