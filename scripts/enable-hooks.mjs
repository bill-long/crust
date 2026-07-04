#!/usr/bin/env node
// Point git at .githooks so the local-review pre-push gate runs. Invoked by the
// `prepare` npm lifecycle script on install, and by `npm run hooks:enable`.
//
// Guards:
//  - Skip in CI: automated push pipelines have no reviewer to stamp, and a
//    fail-closed gate would break them.
//  - Don't clobber a different core.hooksPath (husky, a shared hooks dir) - warn
//    and leave it, so the user opts in explicitly instead of losing other hooks.
//  - Tolerate non-git contexts (e.g. tarball install): do nothing.

import { execSync } from "node:child_process";

if (process.env.CI) {
	process.exit(0);
}

try {
	const current = execSync("git config --get core.hooksPath", {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	if (current && current !== ".githooks") {
		console.warn(
			`[review-gate] core.hooksPath is already '${current}'; leaving it untouched.\n` +
				"[review-gate] To enable the local-review push gate: npm run hooks:enable",
		);
		process.exit(0);
	}
} catch {
	// `git config --get` exits non-zero when the key is unset - that's the
	// common case; fall through and set it.
}

try {
	execSync("git config core.hooksPath .githooks", { stdio: "ignore" });
} catch {
	// Not a git repo (or git unavailable) - nothing to enable.
}
