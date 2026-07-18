#!/usr/bin/env node
// Post-build assertion for the #307 vendor chunk split. The rolldown
// advancedChunks groups in vite.config.ts match on module-id regexes; if
// rolldown changes its id format, or a dependency resolves through a
// different path (pnpm layout change, aliasing), the regexes would silently
// stop matching and the vendor code would fold back into the app chunk with
// no build failure. This script fails the build loudly instead.
//
// Checks (all against dist/assets after `pnpm build`):
//   1. A matrix-js-sdk-*.js chunk exists (the SDK is out of the app chunk).
//   2. A kobalte-*.js chunk exists (Kobalte is out of the app chunk).
//   3. The main index-*.js chunk stays under a ceiling well below the
//      fold-in size (~1.7 MB pre-split; post-split it is ~520 kB, so
//      800 kB gives generous headroom for app growth while still catching
//      a vendor fold-in).
//
// Run via `pnpm build` (invoked after vite build) or directly:
//   node scripts/check-vendor-chunks.mjs

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ASSETS_DIR = join(import.meta.dirname, "..", "dist", "assets");

/** Bytes. Post-#307 baseline is ~486 kB; fold-in would exceed ~1.6 MB. */
const INDEX_CHUNK_CEILING = 800 * 1024;

const failures = [];

let files;
try {
	files = readdirSync(ASSETS_DIR);
} catch {
	failures.push(
		`dist/assets not found — run \`pnpm build\` before this assertion.`,
	);
}

const findChunk = (prefix) =>
	files?.find((f) => f.startsWith(`${prefix}-`) && f.endsWith(".js"));

if (files) {
	const matrixChunk = findChunk("matrix-js-sdk");
	if (!matrixChunk) {
		failures.push(
			`No matrix-js-sdk-*.js chunk in dist/assets. The advancedChunks ` +
				`group in vite.config.ts (test: /node_modules[\\\\/]matrix-js-sdk/) ` +
				`no longer matches — the SDK has folded back into the app chunk. ` +
				`Fix the regex or the group config.`,
		);
	}

	const kobalteChunk = findChunk("kobalte");
	if (!kobalteChunk) {
		failures.push(
			`No kobalte-*.js chunk in dist/assets. The advancedChunks group in ` +
				`vite.config.ts (test: /node_modules[\\\\/]@kobalte/) no longer ` +
				`matches — Kobalte has folded back into the app chunk. Fix the ` +
				`regex or the group config.`,
		);
	}

	const indexChunk = findChunk("index");
	if (!indexChunk) {
		failures.push(`No index-*.js entry chunk in dist/assets.`);
	} else {
		const size = statSync(join(ASSETS_DIR, indexChunk)).size;
		if (size > INDEX_CHUNK_CEILING) {
			failures.push(
				`Entry chunk ${indexChunk} is ${(size / 1024).toFixed(0)} kB, over ` +
					`the ${(INDEX_CHUNK_CEILING / 1024).toFixed(0)} kB ceiling. A vendor ` +
					`dependency has likely folded back into the app chunk (post-#307 ` +
					`baseline: ~486 kB). Check the advancedChunks groups in ` +
					`vite.config.ts.`,
			);
		}
	}
}

if (failures.length > 0) {
	process.stderr.write(
		`\nVendor-chunk assertion failed (#307):\n` +
			failures.map((f) => `  - ${f}\n`).join("") +
			`\n`,
	);
	process.exit(1);
}

const kb = (name) =>
	`${(statSync(join(ASSETS_DIR, name)).size / 1024).toFixed(0)} kB`;
console.log(
	`Vendor-chunk assertion passed: matrix-js-sdk (${kb(findChunk("matrix-js-sdk"))}), ` +
		`kobalte (${kb(findChunk("kobalte"))}) chunks present, ` +
		`entry chunk ${kb(findChunk("index"))} under ${(INDEX_CHUNK_CEILING / 1024).toFixed(0)} kB ceiling.`,
);
