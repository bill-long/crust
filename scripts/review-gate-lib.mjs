// Shared logic for the "local code review before push" gate.
//
// A local code review is an agent action (the `code-review` workflow), not a
// scriptable CI step, so the gate can't run the review itself. Instead it
// checks an attestation: `npm run review:stamp` records the reviewed commit
// SHA into `<git-dir>/local-review-passed`, and the gate refuses to push when
// HEAD doesn't match that SHA. Any new or amended commit changes HEAD and thus
// invalidates the stamp, so "review before push" can't be silently skipped.
//
// The marker lives inside the git dir so it is never committed and is per-clone.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function git(args) {
	return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

/** @returns {{ ok: boolean, head: string, marker: string }} */
export function reviewStatus() {
	const head = git("rev-parse HEAD");
	// --absolute-git-dir resolves worktrees and nested checkouts correctly.
	const gitDir = git("rev-parse --absolute-git-dir");
	let marker = "";
	try {
		marker = readFileSync(join(gitDir, "local-review-passed"), "utf8").trim();
	} catch {
		// no stamp yet
	}
	return { ok: marker !== "" && marker === head, head, marker };
}

/** @param {{ head: string, marker: string }} status */
export function unreviewedMessage({ head, marker }) {
	const short = (s) => (s ? s.slice(0, 8) : "(none)");
	return (
		`Local code-review gate: HEAD ${short(head)} has not passed local review.\n` +
		(marker
			? `  Last reviewed commit: ${short(marker)} (stale - commits changed since).\n`
			: `  No local review has been recorded for this repo yet.\n`) +
		"  Run the local code review, then stamp it:  npm run review:stamp\n"
	);
}
