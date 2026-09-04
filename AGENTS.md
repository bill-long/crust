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

The token namespace (surfaces, text, borders, semantic colors, mention/indicator, per-sender username colors) is defined via `@theme` in `src/styles/global.css` as `--color-*` variables - that file is the source of truth. Variant sets differ per color, so check `global.css` for the exact token before using one.

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
- **The SDK emits a 404 on `/_matrix/client/v3/voip/turnServer` for Conduwuity.** Suppress this in your error logging - it's expected, not a bug. Voice/video uses LiveKit; the SFU is discovered by the MSC4519 `/rtc/transports` endpoint first and `org.matrix.msc4143.rtc_foci` from `.well-known/matrix/client` as the fallback (`features/room/call/rtc/discoverFoci.ts`). Continuwuity serves the endpoint (v26.8+), so that is the live path; `rtc_foci` stays published for older clients.
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

## Error handling

One convention for a caught error, by where the failure is visible:

- **Inside a dialog / form** - render the error inline (a `setError` signal near the affected control). Derive the text with `userFacingErrorMessage(e, fallback)` (`src/lib/errorMessage.ts`), which keeps human-written server/SDK messages and swaps browser jargon (`DOMException`, fetch `TypeError`) for the fallback.
- **Everywhere else** - route it through `reportError(err, { userMessage, logLabel })` (`src/lib/reportError.ts`). It always `console.error`s (`logLabel`), and shows a dismissable error toast when `userMessage` is set (via `pushNotice` / `NoticeToasts`, which outlive a disposed emitter and a room switch).
  - A **user-initiated** action that fails with **no other visible feedback** → pass a short, friendly `userMessage`.
  - Anything else → omit `userMessage`; it stays console-only. That covers both **background noise** (best-effort work, expected quirks like the `turnServer` 404) **and** actions that already have their own failure surface (see next point).
- Don't double-signal. Most user actions here already surface failure inline - not just dialogs, but the timeline's optimistic-echo Retry / Discard affordances (send / react / edit / delete), per-panel `lastError` (pins, room-state saves via `useOptimisticState`), poll `failedVote` / `endFailed`, search `error`, `useCopyLink` state. When one of those exists, a toast is a redundant second surface - stay console-only. Only reach for `userMessage` where none of them fire (e.g. removing your own reaction, which has no inline affordance - `useMessageActions.onReact`).
- Don't stack toasts for a batch - collect the outcome and push one.

---

## File / folder layout

Explore `src/` for the current tree (top-level: `app/` shell, `client/` SDK wrapper, `components/` shared primitives, `features/` feature-scoped code, `stores/`, `lib/`, `styles/`, `types/`, `test/` shared test utils, plus the `index.tsx`/`sw.ts` entries). Rules:
- A component in `components/` knows nothing about Matrix.
- Matrix SDK access is centralized in `client/`; features consume it via `useClient()`.
- A component in `features/` may use `client/`, `components/`, `stores/`, and `lib/`. It may also compose another feature's **public component** (e.g. `RoomList` renders `space/SpaceDiscoverList`) - that is normal cross-feature composition. What it must NOT do is reach into another feature's *internals*: its hooks, or non-component modules. Share that kind of logic via `stores`/events, or promote it to `lib/`/`client/`.
- Hooks are colocated with the feature that owns them (e.g. `useTimeline.ts`, `useMemberList.ts`) and stay private to it. Promote to `lib/` only when broadly reused. If another feature needs a hook's behaviour, wrap it in a component that feature owns and compose that instead.

---

## Accessibility baseline

- All interactive elements are real `<button>` / `<a>` / form controls, or have `role` + keyboard handlers.
- Modals and popovers trap focus and restore it on close. Use a headless library (`@kobalte/core` recommended for Solid) — don't reinvent.
- Color contrast ≥ 4.5:1 for body text, ≥ 3:1 for large/UI. Verify against the dark token values.
- All icons that aren't purely decorative get an `aria-label`. Decorative icons get `aria-hidden="true"`.
- Live regions: typing indicators and new-message announcements use `aria-live="polite"`.

---

## Commands

This repo uses **pnpm**; the scripts live in `package.json` (the source of truth - don't trust any doc's enumeration of them). Gotchas: `pnpm build` does NOT type-check (run `pnpm typecheck` separately), and it wraps the CSP-sync and vendor-chunk check scripts around Vite - `build:vite` is the bare Vite build.

CI runs `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, and `pnpm build` (with the `*.browser.test.tsx` suite in a separate `browser-tests` job). Run all four before declaring any task complete (add `pnpm test:browser` when you've touched layout/browser-dependent code).

### Local code review is required before every agent push

Run the code-review skill, address its findings, then push. Every push means
every push - fix commits answering a review comment are the ones most often
skipped, and they are how findings leak through to the (paid) PR bot that a
local pass would have caught for free.

This is a convention, not a mechanism - two enforcement attempts (a stamp-file
`pre-push` hook and a transcript-reading `PreToolUse` hook) were removed
deliberately. Read `docs/review-gate-history.md` for why before proposing a new
gate. The failure being prevented is an accidental skip, so: remember to run
the review.

This covers the review only; `lint`/`typecheck`/`test` are covered by CI and by
the review flow.

**On a clone that predates this change**, run `git config --unset
core.hooksPath` once. The deleted `prepare` script pointed git at `.githooks/`,
which no longer exists, and git silently ignores `.git/hooks` while that
setting survives - so any hook added later would never run, with no error.

---

## Known server quirks (Conduwuity)

- `/_matrix/client/v3/voip/turnServer` returns 404. Expected. Don't surface as user-visible error.
- Some unstable MSCs aren't implemented; check `unstable_features` in `/_matrix/client/versions` before using them.
- Voice/video is LiveKit-based. Discovery tries MSC4519 `/_matrix/client/unstable/org.matrix.msc4143/rtc/transports` first, which Continuwuity serves (v26.8+). That MSC advertises no `unstable_features` flag, so it is the one exception to the check-`unstable_features`-first rule above: the gate is attempt-once-and-remember (`M_UNRECOGNIZED` / `M_NOT_FOUND`, per `lib/endpointUnsupported.ts`, is remembered per client; a bare 404, timeout or 5xx is not), and falls back to `org.matrix.msc4143.rtc_foci` in `.well-known/matrix/client`, kept published for older clients. JWT comes from the `lk-jwt-service` sidecar.

---

## Always do

- Optimistic updates for any user action that has a network round-trip.
- Virtualize any list that can exceed ~50 items (rooms, members, timeline, search results).
- Honor `prefers-reduced-motion`.
- Use design tokens for color, spacing, radii, shadows.
- Provide a `focus-visible` ring on every focusable element.
- Use `<Show when={}>` rather than `&&` in JSX (better reactivity, no falsy-render footguns).
- Give every Kobalte `*.Portal`'s Content the `portal-scale` class. The UI zoom lives on `#root` (never `<html>` - it breaks floating-ui portal positioning, #487/#485); body-portaled surfaces re-apply the user's scale via that class, and forgetting it renders the surface at 100% scale.
- Surface a failed user action outside a dialog with `reportError(err, { userMessage })` (see "Error handling").

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
