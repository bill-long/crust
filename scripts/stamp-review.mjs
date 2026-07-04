#!/usr/bin/env node
// Records the current HEAD as having passed a local code review.
// Run this ONLY after a clean local code-review pass - it is the attestation
// the push gate checks (see scripts/pre-push-gate.mjs).

import { writeFileSync } from "node:fs";
import { git, markerPath } from "./review-gate-lib.mjs";

const head = git("rev-parse HEAD");
writeFileSync(markerPath(), `${head}\n`);
console.log(
	`Recorded local-review pass for ${head.slice(0, 8)}. Push is unlocked for this commit.`,
);
