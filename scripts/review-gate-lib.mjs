// Shared logic for the "local code review before push" gate.
//
// A local code review is an agent action (the `code-review` workflow), not a
// scriptable CI step, so the gate can't run the review itself. Instead it
// checks an attestation: `pnpm review:stamp` records the reviewed commit
// SHA into `<git-dir>/local-review-passed`, and the git pre-push hook refuses
// to push any commit whose SHA isn't the stamped one. Any new or amended
// commit changes the tip and thus invalidates the stamp, so "review before
// push" can't be silently skipped.
//
// The marker lives inside the git dir so it is never committed and is per-clone.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Run git with the given args and return trimmed stdout. Throws on non-zero
 *  exit. Uses execFileSync (no shell) so args like `sha^{commit}` aren't mangled
 *  by cmd.exe's `^` escaping on Windows and nothing needs shell-quoting. Accepts
 *  a string (split on whitespace - our args never contain spaces) or an array. */
export function git(args) {
	const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
	return execFileSync("git", argv, { encoding: "utf8" }).trim();
}

/** Absolute path to the review-stamp marker file. */
export function markerPath() {
	// --absolute-git-dir resolves worktrees and nested checkouts correctly.
	return join(git("rev-parse --absolute-git-dir"), "local-review-passed");
}

/** The stamped (reviewed) SHA, or "" if nothing is stamped. */
export function stampedSha() {
	try {
		return readFileSync(markerPath(), "utf8").trim();
	} catch {
		return "";
	}
}

/** @returns {{ ok: boolean, head: string, marker: string }} */
export function reviewStatus() {
	const head = git("rev-parse HEAD");
	const marker = stampedSha();
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
		"  Run the local code review, then stamp it:  pnpm review:stamp\n"
	);
}
