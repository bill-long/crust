---
name: stacked-prs
description: Workflow for addressing multiple open issues as a chain of stacked PRs, each building on the previous branch, with mandatory per-PR code review and post-merge audit.
---

# Stacked PRs Workflow

Use this skill when the user asks to "address all open issues", "work through
the open issues", "create stacked PRs for the open issues", or similar. The
goal is one PR per issue, branches chained so each diff stays minimal,
all PRs reaching a clean Copilot review state before the user does a
single batched human review at the end of the chain.

## When this skill is the right tool

- There are **multiple open issues** (typically 3+) that can be worked through
  back-to-back without external coordination.
- The user wants to **batch their own review effort** — i.e. they're willing
  to grant push approval up front so the agent doesn't block per-PR.
- Issues are roughly independent or have a clear ordering. If two issues
  conflict (touch the same files in incompatible ways), the chain still
  works, but flag the conflict to the user before starting.

If only one issue is open, just do the normal single-PR flow with the
`code-review` skill — no need to stack.

## MANDATORY: Pre-approved push

Before starting the chain, **confirm with the user that pushes are
pre-approved** for the duration of the run. The whole point of the workflow
is that the agent doesn't block between commit and push waiting for "OK
to push" — that single ack per PR destroys the time savings.

Acceptable user phrasing that grants pre-approval:
- "Push and follow the code-review loop"
- "Don't wait for confirmation, just push"
- "I'm giving you approval right now to push"

If the user did NOT pre-approve, ask once: "Should I push each PR as soon as
the local 4-pass review is clean, without waiting for your approval per PR?
You'll see all the PRs at once when the chain is done."

If the user declines, exit this skill and direct them to run the
`code-review` skill per PR instead — do not start the chain under per-PR
approval, since that defeats the time-saving premise.

## MANDATORY: One PR reaches a clean Copilot review before the next is started

**This is a hard, blocking gate. It is the #1 way this workflow fails.**

The chain is built **strictly one PR at a time, in order**. You may NOT
create the next issue's branch, implement it, push it, or open its PR until
the *current* PR has a **confirmed-clean Copilot review** (per the §2 step-9
definition: a summary saying "generated no new comments", OR an empty-body
review on HEAD with no unreplied Copilot threads across 3 scans).

Non-negotiable rules:

- **"Fix pushed" is NOT "review clean."** After you push fixes and re-request
  review, the loop is *still open*. You must poll the **new** review to a
  terminal state (clean, or a fresh set of comments) before doing anything
  else. Never treat addressing comments + re-requesting as completion.
- **Never have two PRs in a non-clean review state at the same time.** Exactly
  one PR is "in review" at any moment. Its `issue_chain` row stays in a
  `review-<pr>` state until clean, then flips to `done`. Only a `done` row
  permits starting the next issue.
- **Do not end your turn while a review loop is open.** Re-requesting a review
  and moving on (to the next issue, or to "waiting") abandons the loop. Copilot
  reviews send no notification — keep actively polling (see step 9) until the
  current PR is clean. The poll exists to *drive the loop to completion*, not as
  a fire-and-forget backstop you can walk away from.
- **Before starting any new issue, re-verify the previous PR is still clean.**
  A late review round can land after you thought the loop was done; confirm the
  newest review on the newest HEAD has no unreplied Copilot threads.

If you catch yourself about to branch/implement/open the next PR, STOP and ask:
"Is the current PR's Copilot review confirmed clean on its latest commit?" If
you can't point to a clean review, the gate is not satisfied.

## The workflow

### 1. Plan the chain

Query open issues, decide order, and track the chain. The CLI runtime
provides a per-session SQL database via the `sql` tool — using it as a
tracking table is recommended because rows can be updated as the chain
progresses without re-reading prose. If `sql` is unavailable, a
markdown checklist with the same columns
(`ord | issue | branch | base | title | status`) is a fine substitute.

```sql
CREATE TABLE IF NOT EXISTS issue_chain (
  ord INTEGER PRIMARY KEY,
  issue INTEGER NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
);
```

```bash
gh issue list --state open --limit 500 --json number,title
```

Ordering heuristics:
- Smaller / lower-risk changes first (they unblock the chain faster).
- If issue A clearly extends issue B, do B first.
- Otherwise issue-number order is fine.

The first issue branches from `main`. Every subsequent issue branches from
the **previous issue's branch** and targets it as the PR base.

**Gate:** do not create issue N+1's branch until issue N's row is `done`
(its PR's Copilot review is confirmed clean — see the MANDATORY section above).

### 2. Per-issue loop

For each row in `issue_chain` (one at a time — do not begin the next row until
the current row is `done`):

1. **Read the issue** — `gh issue view N` — and any linked context.
2. **Plan the implementation.**
3. **Rubber-duck non-trivial plans** — use the rubber-duck agent for
   anything involving multiple files, new state, or architectural choices.
   Adopt findings that prevent bugs; set aside ones that bloat scope.
4. **Implement.**
5. **Pre-push gate via the `code-review` skill** — `pnpm typecheck && pnpm lint && pnpm build`,
   then 4-pass review (scoped + blind × Claude + GPT), iterate until
   all four agree.
6. **Commit and push** — the user pre-approved push.
7. **Open the PR** with `--base <previous-branch> --body-file <temp.md>`
   (never inline `--body`; backticks get mangled in PowerShell).
   - **The PR body must mention the issue with a closing keyword**
     (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`,
     `resolves`, or `resolved`, followed by `#N`).
   - When the PR only partially addresses the issue (e.g. deferred tabs),
     use `Addresses #N` in the PR body and list what's deferred in an
     "Out of scope" section. `Addresses` is not a closing keyword, so
     the issue stays open as intended.
8. **Request Copilot review** with `[bot]` syntax — see `code-review` skill.
9. **Poll for Copilot review** using the CLI runtime's `manage_schedule`
   tool at 90s intervals — Copilot review submissions do NOT generate
   completion notifications, so a passive wait (e.g. `read_agent`) will
   not return. `manage_schedule` is a CLI built-in for recurring prompts;
   the `code-review` skill itself assumes an interactively-active agent
   and so documents only the REST/GraphQL queries. This skill uses the
   same queries from inside the scheduled poll. **Record the schedule
   id returned by `manage_schedule` with `action: "create"`** — you'll
   need it to stop the poll once the review is clean. If
   `manage_schedule` is unavailable in the current runtime, fall back
   to a synchronous wait loop in this agent's turn (e.g.
   `Start-Sleep -Seconds 90` in PowerShell, or `sleep 90` in
   bash/zsh — adapt to the local shell) between the same REST/GraphQL
   polls; this blocks the agent on each PR but still completes the
   workflow. Clean when **either**:
   - A non-empty Copilot summary review on the new HEAD SHA says "generated
     no new comments", OR
   - An empty-body Copilot review exists on the new HEAD SHA AND no
     unreplied Copilot threads appear across 3 consecutive scans (≥10s
     apart).

   If unreplied threads exist: address them, push, reply, re-request
   review, continue polling. See `code-review` skill for the exact GraphQL
   query and reply mechanics. **As soon as the review is clean, call
   `manage_schedule` with `action: "stop"` and the recorded schedule
   id** — otherwise the recurring poll keeps firing across subsequent
   issues.
10. **Mark the row done** in `issue_chain` — **only** after the Copilot review
    on the PR's latest commit is confirmed clean. A `done` row is the signal
    that you may now start the next issue; do not mark it `done` while any
    Copilot thread is unreplied or a re-requested review is still pending.

### 3. Post-chain audit

After all rows are `done` and the user has merged the chain:

1. **Query open issues** — `gh issue list --state open --limit 500`. If
   the result is at the limit, raise it or paginate.
2. **For each chain issue still open:** if the PR used a closing
   keyword and the issue didn't auto-close, close it manually with a
   comment referencing the merged PR. Skip issues the chain
   intentionally left open (PRs that used `Addresses #N` for partial
   work).
3. **Comb through every PR in the chain for deferred findings:** open separate
   follow-up issues for:
   - Findings the Copilot review raised that were intentionally deferred.
   - Rubber-duck flags marked "out of scope for this PR".
   - Anything the original issue called "optional" that was skipped.
   - Sub-features removed from PR scope (e.g. avatar upload skipped in
     create-room dialog).

   **Default to opening issues for ALL of these.** The repo maintainer has
   explicitly stated: "we can't just skip features." Better to have an open
   tracking issue than a silent gap.

## What this skill explicitly defers to other skills

- The 4-pass local review template lives in `code-review` skill — call it,
  don't duplicate it.
- The Copilot poll-and-reply mechanics live in `code-review` skill.

## What this skill explicitly does NOT cover

- Conflict resolution across PRs in the chain. If PR #N+1 needs files PR #N
  rewrote, just rebase before opening #N+1. If it gets ugly, stop and ask
  the user before continuing.
- Force-pushes to chain branches after they're under review. Each round of
  Copilot fixes is a normal additive push to the chain branch; do not
  rebase a PR's branch while it has open review threads.
