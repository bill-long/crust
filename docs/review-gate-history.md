# Why the pre-push review gate is a convention, not a mechanism

The rule (see AGENTS.md "Local code review is required before every agent push"):
run the code-review skill, address its findings, then push - every push,
including fix commits answering a review comment.

Two attempts at enforcing it mechanically were removed, and the reasons are
worth keeping:

- A git `pre-push` hook checking a marker file written by `pnpm review:stamp`.
  The agent both performed the action and wrote the evidence, so "review before
  push" collapsed into "type the stamp command" - and the review was skipped
  twice anyway. An attestation you can forge is not a gate.
- A Claude Code `PreToolUse` hook that read the session transcript (which the
  harness writes and the agent cannot) for a completed review postdating HEAD.
  The evidence was sound; the trigger was not. A `PreToolUse` hook sees only a
  command *string*, so deciding "is this a push?" meant approximating git's and
  the shell's grammar - quoted spans, env-var prefixes, `-C`, `--git-dir`,
  subshells, line continuations in two shells. Every round of review found the
  next spelling it had missed. Tools that gate on command strings for real
  (claude-code-auto-approve, the aihero guardrails) parse a bash AST; tools that
  gate pushes for real (`pre-commit`, `husky`, `lefthook`) hook where git hands
  them the refs on stdin. This did neither, and the parser was more code, and
  more bug, than the feature it guarded.

So: remember to run the review. The failure being prevented is an accidental
skip, and nothing here defends against a determined bypass by an agent with
shell access anyway.
