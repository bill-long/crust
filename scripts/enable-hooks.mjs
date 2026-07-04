#!/usr/bin/env node
// Point git at .githooks so the local-review pre-push gate runs. Invoked two ways:
//   - `prepare` (automatic, on install): guarded - skips CI and refuses to
//     clobber a pre-existing different core.hooksPath (husky, shared hooks dir).
//   - `npm run hooks:enable` (explicit, passes --force): the user is asking for
//     it, so bypass those guards and set it, noting any value being overridden.
//
// A silently-unset gate is worse than a visible failure. The automatic path
// stays quiet in contexts where enabling legitimately doesn't apply (not a git
// work tree); the explicit --force path warns on any failure, because the user
// asked and expects it to take effect.

import { execFileSync } from "node:child_process";

const force = process.argv.includes("--force");

// A CI value of "false"/"0"/"" does NOT mean CI (some shells export CI=false).
const ci = (process.env.CI ?? "").toLowerCase();
const inCI = ci !== "" && ci !== "false" && ci !== "0";
if (!force && inCI) {
	process.exit(0);
}

/** Run git; returns trimmed stdout, throws on failure. stderr is suppressed
 *  (an unset config key exits non-zero, which is normal). */
function git(args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function warn(lines) {
	console.warn(lines.map((l) => `[review-gate] ${l}`).join("\n"));
}

// Must be able to invoke git in a work tree. Failure is quiet on the automatic
// path (prepare runs in many contexts, including ones without a .git) but loud
// on --force (the user explicitly asked to enable it).
try {
	git(["rev-parse", "--git-dir"]);
} catch (err) {
	if (force) {
		warn([
			"WARNING: cannot run git to enable the gate - it is NOT active.",
			`  ${err?.message ?? err}`,
		]);
	}
	process.exit(0);
}

// Don't clobber a pre-existing different hooksPath on the automatic path.
let current = "";
try {
	current = git(["config", "--get", "core.hooksPath"]);
} catch {
	// non-zero exit == key unset; leave `current` empty.
}
if (current && current !== ".githooks") {
	if (!force) {
		warn([
			`core.hooksPath is already '${current}'; leaving it untouched.`,
			"To enable the review gate anyway: npm run hooks:enable",
		]);
		process.exit(0);
	}
	warn([`Overriding existing core.hooksPath '${current}'.`]);
}

// Enable. A failure here means the gate would be silently off, so surface it -
// but don't fail the install.
try {
	git(["config", "core.hooksPath", ".githooks"]);
} catch (err) {
	warn([
		"WARNING: could not set core.hooksPath - the local-review push gate is NOT active.",
		`  ${err?.message ?? err}`,
		"  Enable it manually with: npm run hooks:enable",
	]);
}
