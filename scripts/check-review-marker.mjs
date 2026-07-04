#!/usr/bin/env node
// Exits 0 if the current HEAD has passed local code review, else exits 1 with
// an explanatory message on stderr. Used by the git pre-push hook and runnable
// directly via `npm run review:check`.

import { reviewStatus, unreviewedMessage } from "./review-gate-lib.mjs";

const status = reviewStatus();
if (status.ok) {
	process.exit(0);
}
process.stderr.write(`\n${unreviewedMessage(status)}\n`);
process.exit(1);
