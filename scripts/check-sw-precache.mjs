#!/usr/bin/env node
// Post-build assertion: every wasm in dist/assets is in the service worker's
// precache manifest. The crypto wasm (~8 MB) is the one asset the app shell
// cannot run without, and it sits above workbox's default size cap. While it
// was left out, a shell served from an older worker's precache fetched a hash
// the server (or the desktop exe) no longer carried, got index.html back, and
// Rust crypto never initialized - taking the staged recovery's destructive
// store wipe with it (#481). vite-plugin-pwa only WARNS when a file exceeds
// maximumFileSizeToCacheInBytes, so a wasm growing past the cap would bring
// that back silently; this fails the build instead.
//
// Run via `pnpm build` (invoked after vite build) or directly:
//   node scripts/check-sw-precache.mjs

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath rather than import.meta.dirname: see check-vendor-chunks.mjs.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(SCRIPT_DIR, "..", "dist");
const ASSETS_DIR = join(DIST_DIR, "assets");

const failures = [];

let sw;
let wasmFiles;
try {
	sw = readFileSync(join(DIST_DIR, "sw.js"), "utf8");
	wasmFiles = readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".wasm"));
} catch {
	failures.push(
		`dist/sw.js or dist/assets not found - run \`pnpm build\` first.`,
	);
}

if (wasmFiles) {
	if (wasmFiles.length === 0) {
		failures.push(
			`No .wasm in dist/assets. The Rust crypto module is expected there; ` +
				`if it moved, update this check and the injectManifest globPatterns ` +
				`in vite.config.ts together.`,
		);
	}
	for (const file of wasmFiles) {
		if (!sw.includes(file)) {
			failures.push(
				`${file} is not in the service worker's precache manifest. Either ` +
					`injectManifest.globPatterns in vite.config.ts no longer includes ` +
					`wasm, or the file is over maximumFileSizeToCacheInBytes (the ` +
					`plugin skips it with only a warning) - raise the cap.`,
			);
		}
	}
}

if (failures.length > 0) {
	process.stderr.write(
		`\nService-worker precache assertion failed (#481):\n` +
			failures.map((f) => `  - ${f}\n`).join("") +
			`\n`,
	);
	process.exit(1);
}

console.log(
	`Service-worker precache assertion passed: ${wasmFiles.join(", ")} precached.`,
);
