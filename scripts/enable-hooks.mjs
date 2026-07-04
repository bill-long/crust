#!/usr/bin/env node
// Point git at .githooks so the local-review pre-push gate runs. Invoked two ways:
//   - `prepare` (automatic, on install): guarded - skips CI and refuses to
//     clobber a pre-existing different core.hooksPath (husky, shared hooks dir).
//   - `npm run hooks:enable` (explicit, passes --force): the user is asking for
//     it, so bypass those guards and set it, noting any value being overridden.
//
// A silently-unset gate is worse than a visible failure, so a genuine
// `git config` failure WARNS loudly rather than being swallowed.

import { execFileSync } from "node:child_process";

const force = process.argv.includes("--force");

if (!force && process.env.CI) {
	process.exit(0);
}

function gitConfig(args) {
	return execFileSync("git", ["config", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

// Nothing to enable outside a git work tree (this runs on every install,
// including contexts without a .git) - stay quiet.
try {
	execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
	process.exit(0);
}

let current = "";
try {
	current = gitConfig(["--get", "core.hooksPath"]);
} catch {
	// non-zero exit == key unset; leave `current` empty.
}

if (current && current !== ".githooks") {
	if (!force) {
		// Automatic path: don't silently disable the user's other hooks.
		console.warn(
			`[review-gate] core.hooksPath is already '${current}'; leaving it untouched.\n` +
				`[review-gate] To enable the review gate anyway (overrides '${current}'): npm run hooks:enable`,
		);
		process.exit(0);
	}
	// Explicit path: the user asked; override, but say what we replaced.
	console.warn(
		`[review-gate] Overriding existing core.hooksPath '${current}'.`,
	);
}

// Enable. A failure here means the gate would be silently off, so surface it -
// but don't fail the install.
try {
	gitConfig(["core.hooksPath", ".githooks"]);
} catch (err) {
	console.warn(
		"[review-gate] WARNING: could not set core.hooksPath - the local-review push gate is NOT active.\n" +
			`[review-gate]   ${err?.message ?? err}\n` +
			"[review-gate]   Enable it manually with: npm run hooks:enable",
	);
}
