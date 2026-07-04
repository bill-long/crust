#!/usr/bin/env node
// Exits 0 if the current HEAD has passed local code review, else exits 1 with
// an explanatory message on stderr. A convenience for humans (`npm run
// review:check`) - the authoritative push gate is scripts/pre-push-gate.mjs.
// Fail-closed: if git errors (unborn HEAD, git not on PATH, ...), exit 1.

import { reviewStatus, unreviewedMessage } from "./review-gate-lib.mjs";

try {
	const status = reviewStatus();
	if (status.ok) {
		process.exit(0);
	}
	process.stderr.write(`\n${unreviewedMessage(status)}\n`);
	process.exit(1);
} catch (err) {
	process.stderr.write(
		`\nLocal code-review gate: could not determine review state (${err?.message ?? err}).\n\n`,
	);
	process.exit(1);
}
