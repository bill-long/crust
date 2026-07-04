#!/usr/bin/env node
// Point git at .githooks so the local-review pre-push gate runs. Invoked by the
// `prepare` npm lifecycle script on install, and by `npm run hooks:enable`.
//
// Guards:
//  - Skip in CI: automated push pipelines have no reviewer to stamp, and a
//    fail-closed gate would break them.
//  - Don't clobber a different core.hooksPath (husky, a shared hooks dir) - warn
//    and leave it, so the user opts in explicitly instead of losing other hooks.
//  - Tolerate non-git contexts (e.g. tarball install): do nothing, quietly.
//  - But if enabling genuinely FAILS (config lock, permissions), WARN loudly -
//    a silently-unset gate is worse than a visible failure.

import { execFileSync } from "node:child_process";

if (process.env.CI) {
	process.exit(0);
}

function gitConfig(args) {
	return execFileSync("git", ["config", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

// Are we even in a git work tree? If not, there's nothing to enable - stay quiet
// (this runs on every install, including contexts without a .git).
try {
	execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
	process.exit(0);
}

// Respect a pre-existing, different hooksPath (husky, shared hooks dir).
let current = "";
try {
	current = gitConfig(["--get", "core.hooksPath"]);
} catch {
	// non-zero exit == key unset; leave `current` empty and set it below.
}
if (current && current !== ".githooks") {
	console.warn(
		`[review-gate] core.hooksPath is already '${current}'; leaving it untouched.\n` +
			"[review-gate] To enable the local-review push gate: npm run hooks:enable",
	);
	process.exit(0);
}

// Enable. A failure here is a real problem (the gate would be silently off), so
// surface it - but don't fail the install.
try {
	gitConfig(["core.hooksPath", ".githooks"]);
} catch (err) {
	console.warn(
		`[review-gate] WARNING: could not set core.hooksPath - the local-review push gate is NOT active.\n` +
			`[review-gate]   ${err?.message ?? err}\n` +
			"[review-gate]   Enable it manually with: npm run hooks:enable",
	);
}
