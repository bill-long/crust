# Pull request workflow

Local review requirements and project checks live in [AGENTS.md](../AGENTS.md).
Use its command for the current environment. This document covers publishing
and review follow-up; it does not add review passes or a separate skill.

## Create or update a PR

Write the description to a temporary Markdown file and use `--body-file` with
`gh pr create` or `gh pr edit`. Never use inline `--body`: PowerShell can consume
Markdown backticks and alter the text. Remove the temporary file afterward and
do not commit it.

Describe the final behavior and relevant validation. Use `Fixes #N` only when
the issue is fully addressed; otherwise use `Addresses #N` and name what remains.

## Request Copilot review

Use the bot login below, as documented by [GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review). The short `copilot` login has silently dropped requests
in this repository. Replace `PR_NUMBER` in these commands with the PR number.

```sh
gh api repos/bill-long/crust/pulls/PR_NUMBER/requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
gh api repos/bill-long/crust/pulls/PR_NUMBER/requested_reviewers --jq '.users[].login'
```

Verify Copilot was requested. The request list may become empty when work starts.
If it is empty, check the timeline for a recent Copilot `review_requested` event
and check for a completed review on the current HEAD before retrying. A recent
request may still be in progress; allow the polling window below before deciding
it was dropped. Do not depend on undocumented worker event names.

```sh
gh api --paginate repos/bill-long/crust/issues/PR_NUMBER/timeline
```

## Address findings

Read both the summary and individual comments, including actionable findings
listed as suppressed in the summary. For each finding, fix the problem and check
for the same mistake elsewhere, or reply with evidence explaining why no change
is needed. After a fix, complete the checks and local review required by AGENTS.md
before pushing. Reply to each finding with the fix commit and explanation, then
request another Copilot review. Do not treat replies or a pending review request
as proof that the updated code is clean.

## Verify completion on the current HEAD

Record the current head SHA and fetch all review/comment pages:

```sh
gh pr view PR_NUMBER --json headRefOid --jq '.headRefOid'
gh api --paginate repos/bill-long/crust/pulls/PR_NUMBER/reviews
gh api --paginate repos/bill-long/crust/pulls/PR_NUMBER/comments
```

Only a completed Copilot review for that SHA validates the current changes. Read
the actual summary rather than requiring a fixed heading: Copilot has used both
"generated no new comments" and "Comments generated: 0 new". Investigate any
remaining actionable findings even if the new-comment count is zero. Report a
non-green overall verdict separately; do not claim approval from a zero count.

An empty-body review may be either an intermediate comment submission or a final
review with no findings. Treat it as clean only when it has no associated inline
comments, no review request is still pending, and three verification scans at
least 10 seconds apart find no new or unaddressed findings. For a non-empty
summary with zero new findings, use the same verification scans. GitHub's REST
reviews and GraphQL threads can become visible at different times.

Use GraphQL to inspect thread state and replies as well as the REST comments:

```graphql
query($number: Int!, $cursor: String) {
  repository(owner: "bill-long", name: "crust") {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(last: 1) {
            nodes { author { login } body createdAt }
          }
        }
      }
    }
  }
}
```

Follow every `hasNextPage` cursor. Check old threads too: an outdated location
alone does not prove the finding was addressed. A reply alone also does not prove
it was fixed; verify the cited change or rationale. Repeat the scans after every
reply cycle. If a review does not finish within ten minutes of 30-second polling,
report the pending state rather than calling it clean. Resume verification when
it arrives. Leave merging to the user unless they explicitly request it.
