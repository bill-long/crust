# Code Review Prompt Guidelines

When running local code reviews (via the code-review agent), use these prompt
templates. They encode lessons learned from prior review rounds on this project.

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
  read, and enum members never referenced.
- Intra-file duplication: when the same logic (3+ lines) appears in multiple
  places within one file, flag it for extraction into a shared helper.
```

## Lessons Learned

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
