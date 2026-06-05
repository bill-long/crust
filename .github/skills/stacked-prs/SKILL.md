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

## The workflow

### 1. Plan the chain

Query open issues, decide order, and track the chain. The CLI runtime
provides a per-session SQL database via the `sql` tool — using it as a
tracking table is recommended because rows can be updated as the chain
progresses without re-reading prose. If `sql` is unavailable, a
markdown checklist with the same columns (`ord | issue | branch | base
| title | status`) is a fine substitute.

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

### 2. Per-issue loop

For each row in `issue_chain`:

1. **Read the issue** — `gh issue view N` — and any linked context.
2. **Plan the implementation.**
3. **Rubber-duck non-trivial plans** — use the rubber-duck agent for
   anything involving multiple files, new state, or architectural choices.
   Adopt findings that prevent bugs; set aside ones that bloat scope.
4. **Implement.**
5. **Pre-push gate via the `code-review` skill** — `pnpm typecheck && pnpm lint && pnpm build`,
   then 4-pass review (scoped + blind × Claude + GPT), iterate until
   all four agree.
6. **Commit, then run the pre-flight check from the "Auto-close failure
   mode" section** to verify the HEAD commit message has a closing or
   `Addresses` keyword. Only push after the check passes — the user
   pre-approved push.
7. **Open the PR** with `--base <previous-branch> --body-file <temp.md>`
   (never inline `--body`; backticks get mangled in PowerShell).
   - **Mention the issue with a closing keyword in BOTH the commit
     message AND the PR body.** GitHub accepts: `close | closes |
     closed | fix | fixes | fixed | resolve | resolves | resolved`,
     each followed (optionally with a colon, e.g. `Closes: #186`) by
     `#N`. Putting the trailer in both places maximizes the likelihood
     that the issue auto-closes regardless of how the chain is ultimately
     merged — closure still depends on the reference surviving into
     default-branch history or the merged PR's metadata (see the
     post-merge audit for the safety net). The pre-flight in step 6
     enforces the commit-message half.
   - When the PR only partially addresses the issue (e.g. deferred tabs),
     use `Addresses #N` in both the commit and the PR body, and list what's
     deferred in an "Out of scope" section. The pre-flight check accepts
     this as the partial-coverage signal.
8. **Request Copilot review** with `[bot]` syntax — see `code-review` skill.
9. **Poll for Copilot review** using the CLI runtime's `manage_schedule`
   tool at 90s intervals — Copilot review submissions do NOT generate
   completion notifications, so a passive wait (e.g. `read_agent`) will
   not return. `manage_schedule` is a CLI built-in for recurring prompts;
   the `code-review` skill itself assumes an interactively-active agent
   and so documents only the REST/GraphQL queries. This skill uses the
   same queries from inside the scheduled poll. If `manage_schedule` is
   unavailable in the current runtime, fall back to a synchronous wait
   loop in this agent's turn (`Start-Sleep -Seconds 90` between the same
   REST/GraphQL polls); this blocks the agent on each PR but still
   completes the workflow. Clean when **either**:
   - A non-empty Copilot summary review on the new HEAD SHA says "generated
     no new comments", OR
   - An empty-body Copilot review exists on the new HEAD SHA AND no
     unreplied Copilot threads appear across 3 consecutive scans (≥10s
     apart).

    If unreplied threads exist: address them, push, reply, re-request
    review, continue polling. See `code-review` skill for the exact GraphQL
    query and reply mechanics. **As soon as the review is clean, call
    `manage_schedule` with `action: "stop"` and the schedule id** —
    otherwise the recurring poll keeps firing across subsequent issues.
10. **Mark the row done** in `issue_chain`.

### 3. Post-chain audit

After all rows are `done` and the user has merged the chain:

1. **Query open issues** — `gh issue list --state open --limit 500`. If
   the result is at the limit, raise it or paginate; a truncated list
   silently leaves stragglers undiagnosed.
2. **For each open issue that should have closed but didn't:** scan all
   commits that landed from the PR (not just the merge commit, since
   non-squash merges preserve implementation commits separately):
   `gh pr view <num> --json commits -q '.commits[] | .messageHeadline, .messageBody'`,
   plus the merge commit body, plus the merged PR body. If no closing
   keyword like `Closes #N` appears in any of these, that's the cause.
3. **Close stragglers** with a brief comment referencing the merged PR.
4. **Comb every PR in the chain for deferred findings:** open separate
   follow-up issues for:
   - Findings the Copilot review raised that were intentionally deferred.
   - Rubber-duck flags marked "out of scope for this PR".
   - Anything the original issue called "optional" that was skipped.
   - Sub-features removed from PR scope (e.g. avatar upload skipped in
     create-room dialog).

   **Default to opening issues for ALL of these.** The repo maintainer has
   explicitly stated: "we can't just skip features." Better to have an open
   tracking issue than a silent gap.

## Auto-close failure mode

GitHub auto-closes an issue when the PR that mentions it with a closing
keyword (`Closes/Fixes/Resolves #N`) is merged into the default branch.
For stacked PRs the safest practice is to put the trailer in **both**
the commit message and the PR body — that way the issue closes whether
the trailer survives via the PR body (after GitHub auto-retargets the
PR), via the commit message (when the commit reaches `main`), or both.

A recent run on this repo: 5 of 8 chain PRs auto-closed (each had
`Closes #N` in both PR body and commit message); 3 of 8 did not (each
had neither). The failure mode is **forgetting the trailer entirely**.

**Pre-flight check before pushing each PR:** verify the closing keyword
is in the most recent commit message on the branch. Accept either a
closing keyword (any of GitHub's nine inflections) or an explicit
`Addresses #N` reference for partial-coverage PRs. The PR body is
written next via `--body-file`; the same trailer should appear there.

```powershell
$commitMsg = git log -1 --pretty=format:"%B"
$closes  = $commitMsg -match '(?i)\b(close[sd]?|fix(es|ed)?|resolve[sd]?)(:\s*|\s+)#\d+\b'
$partial = $commitMsg -match '(?i)\bAddresses(:\s*|\s+)#\d+\b'
if (-not ($closes -or $partial)) {
  throw "HEAD commit message missing 'Closes/Fixes/Resolves #N' or 'Addresses #N' reference"
}
```

**Post-merge audit** (step 3 of the workflow) remains the safety net:
squash-merge, force-push, or rebase flows can drop commit history
before reaching `main`. Always verify open-issue state after the chain
merges and close stragglers manually.

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
