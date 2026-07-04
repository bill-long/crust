#!/usr/bin/env node
// git `pre-push` hook logic - the authoritative local-review gate.
//
// git runs pre-push for EVERY push regardless of how it was invoked
// (`git push`, `git -c ... push`, `git push origin a:b`, etc.) and pipes the
// refs being pushed on stdin, one per line:
//     <local ref> <local sha> <remote ref> <remote sha>
// so the gate checks the ACTUAL commits being pushed - not the command string
// (unparseable) and not merely HEAD (which the pushed ref need not equal).
//
// Blocks (exit 1) unless every non-delete pushed commit equals the stamped
// reviewed SHA. Pushed OIDs are resolved to the commit they name (`^{commit}`)
// so an annotated tag - whose OID is the tag object, not the commit - is
// compared by the commit it points at (and `git push --follow-tags` of a tag on
// the reviewed tip passes). Fail-closed: any internal error blocks rather than
// allows. The only escape hatch is git's own `--no-verify`.
//
// Note: a push touching several refs with genuinely distinct tips is blocked -
// only the single stamped commit is reviewed. Push one reviewed branch at a
// time (stamp its tip), or use --no-verify deliberately.

import { git, stampedSha } from "./review-gate-lib.mjs";

const isAllZeros = (sha) => /^0+$/.test(sha);

async function readStdin() {
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;
	return input;
}

/** Resolve OIDs to the commits they name (identity for commits, deref for
 *  annotated tags) in a single git process. Throws (-> fail-closed) if any OID
 *  doesn't name a commit or the result count doesn't line up. */
function toCommits(oids) {
	const out = git(["rev-parse", ...oids.map((o) => `${o}^{commit}`)]);
	const commits = out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (commits.length !== oids.length) {
		throw new Error(
			`resolved ${commits.length} commits for ${oids.length} pushed OIDs`,
		);
	}
	return commits;
}

async function main() {
	const input = await readStdin();
	const stamped = stampedSha();

	// Each line: "<localRef> <localSha> <remoteRef> <remoteSha>". A deletion has
	// an all-zeros localSha (40 or 64 chars) - nothing is pushed, so skip it.
	const pushedOids = [
		...new Set(
			input
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.map((l) => l.split(/\s+/)[1])
				.filter((sha) => sha && !isAllZeros(sha)),
		),
	];

	// Nothing to push (e.g. only deletions) -> allow.
	if (pushedOids.length === 0) process.exit(0);

	const pushedCommits = toCommits(pushedOids);
	const unreviewed = pushedCommits.filter((sha) => sha !== stamped);
	if (stamped && unreviewed.length === 0) process.exit(0);

	const short = (s) => s.slice(0, 8);
	process.stderr.write(
		"\nLocal code-review gate (pre-push): the commit(s) being pushed have not passed local review.\n" +
			(stamped
				? `  Stamped (reviewed): ${short(stamped)}\n`
				: "  No local review has been recorded for this repo yet.\n") +
			`  Pushing commit(s):  ${pushedCommits.map(short).join(", ")}\n` +
			"  Check out that commit, run the local code review, then:  pnpm review:stamp\n" +
			"  (Deliberate override, discouraged: git push --no-verify.)\n\n",
	);
	process.exit(1);
}

main().catch((err) => {
	process.stderr.write(
		`\nLocal code-review gate (pre-push): internal error - blocking to be safe.\n  ${err?.message ?? err}\n\n`,
	);
	process.exit(1); // fail-closed
});
