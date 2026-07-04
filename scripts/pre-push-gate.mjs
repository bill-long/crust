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
// Blocks (exit 1) unless every non-delete pushed tip equals the stamped
// reviewed SHA. Fail-closed: any internal error blocks rather than allows.
// The only escape hatch is git's own `--no-verify`, which is a deliberate,
// visible override (don't use it to skip review).

import { stampedSha } from "./review-gate-lib.mjs";

const ZERO = "0".repeat(40);

async function readStdin() {
	let input = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) input += chunk;
	return input;
}

async function main() {
	const input = await readStdin();
	const stamped = stampedSha();

	// Each line: "<localRef> <localSha> <remoteRef> <remoteSha>". A deletion has
	// localSha all-zeros - nothing is being pushed, so skip it.
	const pushedShas = input
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => l.split(/\s+/)[1])
		.filter((sha) => sha && sha !== ZERO);

	// Nothing to push (e.g. only deletions) -> allow.
	if (pushedShas.length === 0) process.exit(0);

	const unreviewed = [...new Set(pushedShas)].filter((sha) => sha !== stamped);
	if (stamped && unreviewed.length === 0) process.exit(0);

	const short = (s) => s.slice(0, 8);
	process.stderr.write(
		"\nLocal code-review gate (pre-push): the commit(s) being pushed have not passed local review.\n" +
			(stamped
				? `  Stamped (reviewed): ${short(stamped)}\n`
				: "  No local review has been recorded for this repo yet.\n") +
			`  Pushing tip(s):     ${[...new Set(pushedShas)].map(short).join(", ")}\n` +
			"  Check out that commit, run the local code review, then:  npm run review:stamp\n" +
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
