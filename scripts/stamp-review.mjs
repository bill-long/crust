#!/usr/bin/env node
// Records the current HEAD as having passed a local code review.
// Run this ONLY after a clean local code-review pass - it is the attestation
// the push gate checks (see scripts/review-gate-lib.mjs).

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function git(args) {
	return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

const head = git("rev-parse HEAD");
const gitDir = git("rev-parse --absolute-git-dir");
writeFileSync(join(gitDir, "local-review-passed"), `${head}\n`);
console.log(
	`Recorded local-review pass for ${head.slice(0, 8)}. Push is unlocked for this commit.`,
);
