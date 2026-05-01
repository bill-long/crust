# Code Review Prompt Guidelines

When running local code reviews (via the code-review agent), use these prompt
templates. They encode lessons learned from prior review rounds on this project.

## MANDATORY: Local Code Review Before Every Push

**No code may be pushed to a PR branch without a full 4-pass local code review
first.** This applies to ALL changes — including "trivial" one-liners, formatting
fixes, documentation updates, and Copilot review comment fixes. No exceptions.

The 4 passes are:
1. **Scoped (Claude)** — describes intent, lists verification items
2. **Scoped (GPT)** — same context, different model
3. **Scope-blind (Claude)** — cold read, full category sweep
4. **Scope-blind (GPT)** — same template, different model

All 4 models must agree with no substantive findings before pushing. If any
model finds an issue, fix it and re-run ALL 4 passes.

**Why this is non-negotiable:** Each skipped local review causes a Copilot
round-trip that costs 5+ minutes of wall time. Issues caught by Copilot that
the local review should have caught waste the user's time waiting for the
review cycle. Two skips in one session is unacceptable.

## Checking for Copilot PR Review Comments

After pushing fixes and requesting a re-review from `copilot-pull-request-reviewer`,
use this GraphQL query to reliably detect unaddressed comments. **Do NOT rely on
REST API comment counts or timestamp comparisons** — comments can arrive at the
same timestamp as the review entry and will be missed.

```bash
gh api graphql -f query='{
  repository(owner: "bill-long", name: "crust") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(last: 50) {
        nodes {
          isOutdated
          path
          line
          comments(last: 1) {
            nodes { author { login } createdAt body }
          }
        }
      }
    }
  }
}' --jq '[
  .data.repository.pullRequest.reviewThreads.nodes[]
  | select(.isOutdated == false)
  | select(.comments.nodes[-1].author.login | test("copilot"))
] | length'
```

- **0** = clean review, all comments addressed
- **>0** = unaddressed comments; pipe through the jq filter
  `.[] | {path, line, body: .comments.nodes[-1].body[0:120]}` to see them

Always run this check after confirming a new Copilot review exists (check
`gh api /repos/.../pulls/N/reviews` for latest commit). A review with 0
REST API "new comments" can still have new threads visible only via GraphQL.

## Scoped Pass

Describe what changed, then include:

1. **Data flow tracing** — explicitly list the path data takes across files.
   Example: "user input → discoverHomeserver → baseUrl → loginRequest →
   well_known → resolvedUrl → saveSession → localStorage → loadSession →
   isSession → createClient". Ask reviewers to verify each step handles all
   possible outputs from the previous step.

2. **Edge case inputs** — enumerate specific inputs for any user-facing parsing
   or external data ingestion code. Include three categories:
   - **Valid unusual**: IPv6 (`[::1]:8008`), custom ports, Unicode domains
   - **Degenerate**: empty string, whitespace, partial input (`@user:` with no
     server), `@` alone, `null`
   - **Malicious/malformed**: `javascript:` URLs, `file://` paths, URLs with
     paths/query/fragments, non-http schemes

3. **Cross-file interactions** — when file A produces a value consumed by file B,
   explicitly ask: "if A returns X, does B handle it gracefully?" Include
   validation mismatch scenarios (e.g., save validates differently than load).

4. **Caller impact of validation failures** — when validation rejects data or
   throws, trace what the caller shows the user. Generic "something failed"
   messages indicate a gap.

## Scope-Blind Pass

Use the standard template from the project's custom instructions, plus these
additions at the end of the category list:

```
- Input validation edge cases: for any code parsing user input, URLs, or
  external data (API responses, localStorage, config files), mentally test
  degenerate inputs (empty, whitespace, partial, malformed) AND unusual-but-
  valid inputs (IPv6, unicode, special characters, boundary values). Flag any
  input that produces incorrect behavior.
- Cross-file data flow: if file A produces a value consumed by file B, verify
  B handles all possible outputs from A. Read related files beyond the diff
  when needed (list them in the prompt).
- Dead code and unused definitions: flag union type variants that are never
  assigned, exported functions/types never imported, interface fields never
  read, and enum members never referenced. Also flag stored data fields that
  are computed but never consumed by any UI component.
- Intra-file duplication: when the same logic (3+ lines) appears in multiple
  places within one file, flag it for extraction into a shared helper.
- CSS positioning: when an element uses `position: absolute` (or Tailwind
  `absolute`), verify there is a `position: relative` (or `relative`) ancestor
  within the same component. Missing positioning context causes elements to
  escape their intended container.
- ARIA completeness: when using `role="separator"`, verify all required ARIA
  attributes are present (aria-valuenow, aria-valuemin, aria-valuemax). When
  adding one ARIA attribute, check what others the role requires. Interactive
  ARIA widgets must be keyboard-operable (not just focusable).
- Reactive hooks: when a Solid hook receives a signal accessor (e.g.,
  `roomId: () => string`), verify the hook tracks changes via `createEffect`.
  A one-time read misses subsequent updates. Also verify that component state
  (scroll position, flags) resets when the driving signal changes.
- Event-type coverage: when handling SDK events incrementally, verify ALL
  event types that affect the rendered state are handled — not just the
  obvious ones. For timeline: messages, reactions, AND redactions. For
  encrypted events: pending-decryption needs a distinct placeholder from
  decryption-failure.
- Browser compatibility: when using regex features (lookbehind `(?<=)`,
  `(?<!)`), `structuredClone`, `Array.at()`, or other modern JS APIs,
  verify they are supported by the project's browser baseline. Lookbehind
  is unsupported in Safari <16.4 (March 2023). Prefer equivalent rewrites
  (e.g., capture-and-reinsert instead of lookbehind) unless the baseline
  explicitly excludes older browsers.
- Sentinel/placeholder safety: when using sentinel characters or strings
  to protect regions of text from transformation (e.g., code blocks during
  markdown processing), verify the sentinel cannot appear in user input.
  Pre-escape or replace any existing occurrences before inserting sentinels.
- Focus management in async flows: when re-focusing an element after an
  async operation (network request, setTimeout), verify the user hasn't
  moved focus elsewhere. Check `document.activeElement` before calling
  `.focus()` to avoid stealing focus from another control.
- Prototype pollution: when using plain objects (`{}`) as maps keyed by
  external/untrusted data (e.g., reaction emoji from other users, room
  names, event types), use `Object.create(null)` to prevent prototype
  pollution via keys like `__proto__`, `constructor`, `toString`. Also
  prefer `Object.hasOwn(obj, key)` over `key in obj` — the `in` operator
  matches inherited prototype properties.
- HTML construction safety: when building HTML strings (e.g., Matrix
  `formatted_body`, `<mx-reply>` fallbacks), verify ALL interpolated
  values are escaped. Common misses: user IDs in `<a href>` and link
  text, message body used as HTML fallback when `formatted_body` is null,
  and newlines not converted to `<br>` in HTML context. Trace every path
  that sets `formatted_body` and confirm no raw user text reaches it.
- Conditional UI reachability: when a trigger control (button, link) is
  inside a conditional block (`<Show>`, `v-if`, `{condition && ...}`),
  verify the control is reachable in ALL relevant states. A common bug:
  wrapping both the trigger and its popover/picker in the same conditional
  makes the trigger unreachable when the condition is initially false
  (e.g., "+" reaction button gated on reactions.length > 0).
- Keyboard event handler placement: when adding keyboard handlers (e.g.,
  Escape to close a popover), verify the handler fires when the focused
  element receives the key event. If focus is on element A but the
  handler is on sibling element B, the event won't reach B. Place
  handlers on the focused element or a common ancestor.
- Code duplication across files: when the same utility function appears
  in multiple files (e.g., `escapeHtml`), flag it for extraction into a
  shared module. Duplicates diverge on the next edit and create
  inconsistent behavior.
- Type safety over `any`: when SDK types are too restrictive for valid
  usage, prefer `as unknown as TargetType` over `as any`. The double
  cast preserves type checking for the rest of the expression while
  working around the specific incompatibility.
```

## Lessons Learned

- **NEVER skip local code review before pushing.** This is the most
  expensive mistake in the workflow. "It's just a one-liner" and "this is
  an obvious fix" have both led to Copilot catching issues that wasted 5+
  minutes per round-trip. The local review exists to catch these before
  the push. Every commit, every time, no exceptions.
- **Per-file review misses cross-file interactions.** The scoped pass must
  describe data flow across files, not just what each file does.
- **"Unusual but valid" misses degenerate inputs.** Always include empty,
  whitespace, and partial inputs alongside IPv6/ports/unicode.
- **Fixes introduce regressions.** When tightening validation (e.g., adding
  type guards), verify the new checks don't reject previously-accepted valid
  inputs (e.g., empty-string regression when switching from truthiness to
  typeof checks).
- **Validation at consumption ≠ validation at production.** If you validate on
  load, also validate on save. Mismatches cause phantom failures on reload.
- **External data needs scheme validation.** Any URL from an external source
  (well-known responses, login responses, config files) must be validated for
  http/https scheme before use. Apply this at every ingestion point, not just
  one.
- **SDK domain knowledge matters.** For matrix-js-sdk specifically: verify
  sync state transition ordering, use non-deprecated APIs (loginRequest not
  login, initRustCrypto not initCrypto), and check that event callback
  signatures match the SDK version.
- **Dead type variants are a code smell.** If a union type has a variant
  that's never assigned anywhere in the diff, remove it. Speculative variants
  invite consumers that never work.
- **Intra-file duplication drifts.** When the same logic is copied within a
  file (e.g., space-children extraction), extract a helper immediately.
  Duplicates invariably diverge on the next edit.
- **Initial vs incremental paths must agree.** When a field is populated in
  both an initial-load path and an incremental-update path, verify they apply
  the same filtering, transformation, and fallback rules. Divergent logic for
  the same field is a consistency bug waiting to happen.
- **Prefer canonical type imports.** When a library exports a named type
  (e.g., `SetStoreFunction<T>`), use it instead of deriving types with
  `ReturnType<typeof ...>`. Derived types are fragile and non-idiomatic.
- **A11y goes beyond keyboard nav.** Icon-only buttons need `aria-label`,
  not just `title`. Color-only distinctions (e.g., red vs grey badges) need
  text alternatives. Selected/current states need `aria-current` or
  `aria-pressed`. Emoji used as icons need `aria-label` on the container.
- **Display data can be degenerate too.** SDK room names can be empty strings
  or whitespace-only. Always use `.trim()` before testing — `||` alone does
  not catch whitespace-only strings. Apply this to names, labels, titles,
  aria-labels, and any text rendered in the UI.
- **When fixing a guard in one function, audit siblings.** Selector functions
  that share a contract (e.g., getSpaceRooms, getSpaceUnreadRollup,
  getOrphanRooms) must apply the same precondition checks. When you add a
  guard to one, scan for related functions that need the same fix.
- **Reactive signals must be tracked, not just read once.** When a Solid
  hook receives `() => string`, wrap reads in `createEffect` for reactivity.
  Also reset derived state (scroll position, atBottom flags, loading states)
  when the driving signal changes — component reuse across param changes is
  common in SPA routers.
- **Absolute positioning needs a relative ancestor.** Always check that CSS
  `absolute` elements have a `relative` parent within the same component.
- **ARIA attributes come in sets.** When a role requires multiple ARIA props
  (e.g., separator needs valuenow + valuemin + valuemax), adding one without
  the others is incomplete. Check the WAI-ARIA spec for required attributes
  per role.
- **Handle all event types that affect rendered state.** For timelines:
  messages, reactions, redactions, and pending-decryption all produce
  distinct visual states. Missing any one creates stale UI.
- **Data stored but never rendered is waste.** If a field is computed in
  the data model but no UI component reads it, remove it. It adds
  allocation overhead and maintenance surface for no benefit.
- **Regex lookbehind breaks older Safari.** `(?<!\w)` and `(?<=\w)` throw
  SyntaxError in Safari <16.4. Vite/esbuild do not transpile regex syntax.
  Rewrite with capture-and-reinsert: `(^|[^\w])` + `$1` in replacement.
- **Sentinel characters must not collide with user input.** When using
  placeholder tokens (e.g., U+FFFD) to protect text regions, pre-escape
  any existing occurrences of the sentinel before inserting placeholders.
  An index guard on restoration is not enough — it prevents `undefined`
  but still allows wrong-block substitution.
- **Don't steal focus after async operations.** `element.focus()` in a
  `finally` block runs even when the user has clicked elsewhere during the
  await. Guard with `document.activeElement` check before re-focusing.
- **Plain objects are not safe maps.** When keys come from untrusted
  sources (reaction emoji, event content, user input), `__proto__` or
  `toString` keys cause prototype pollution. Use `Object.create(null)`
  for any object used as a key-value map with external keys. Pair with
  `Object.hasOwn()` instead of the `in` operator for property checks.
- **Trace every path that builds HTML.** When constructing `formatted_body`
  or similar HTML strings, it's not enough to escape the "obvious" values.
  Trace every code path: the no-markdown fallback, the reply fallback, the
  edit path. Each one must escape ALL interpolated user text. A single
  missed path is a stored XSS vulnerability.
- **Conditional UI must not hide its own trigger.** When a `<Show>`/`v-if`
  wraps both a trigger button and its popover content, the trigger becomes
  unreachable when the condition is false. Always render triggers
  unconditionally (or gate them on a different condition than their content).
- **Keyboard handlers must be on the focused element.** An `onKeyDown` on
  a sibling element won't fire when focus is elsewhere. Place escape/close
  handlers on the element that actually has focus (or on a common ancestor).
- **Don't duplicate utility functions across files.** When the same helper
  (e.g., `escapeHtml`) appears in two files, extract to a shared module
  immediately. Duplicates will diverge on the next edit.
- **Prefer typed casts over `any`.** When SDK types are too restrictive,
  use `as unknown as TargetType` instead of `as any`. The double cast
  preserves type checking for the rest of the expression.
