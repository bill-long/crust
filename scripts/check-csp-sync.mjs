#!/usr/bin/env node
// Build-time guard for the CSP single source of truth (issue #314).
//
// The baseline Content-Security-Policy is the <meta> tag in index.html; the
// copies in docker-nginx.conf and desktop/src-tauri/tauri.conf.json must not
// drift from it (see scripts/csp-lib.mjs for the exact rules and why the
// Tauri copies may only add sources). Fails the build loudly on any drift.
//
// Run via `pnpm build` (invoked before vite build) or directly:
//   node scripts/check-csp-sync.mjs [root]
// The optional root argument points the checker at another checkout layout;
// it exists so the test suite can run the script against drifted fixtures.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	comparePolicies,
	DEV_EXTRA_SOURCES,
	extractHtmlCsp,
	extractNginxCsp,
	extractTauriCsps,
	parseCsp,
} from "./csp-lib.mjs";

// fileURLToPath rather than import.meta.dirname: the latter needs
// Node >= 20.11 and this script runs inside pnpm build for every
// contributor, so it must work on any Node ESM runtime.
const ROOT =
	process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (path) => readFileSync(join(ROOT, path), "utf8");

let failed = false;
const report = (label, problems) => {
	for (const problem of problems) {
		console.error(`check-csp-sync: ${label}: ${problem}`);
		failed = true;
	}
};

// Each target is checked independently so one unreadable/malformed file
// doesn't hide the other targets' drift - a contributor sees every problem
// in one run.
const check = (label, compare) => {
	try {
		report(label, compare());
	} catch (err) {
		report(label, [err instanceof Error ? err.message : String(err)]);
	}
};

let baseline;
try {
	baseline = parseCsp(extractHtmlCsp(read("index.html")));
} catch (err) {
	report("index.html", [err instanceof Error ? err.message : String(err)]);
}

if (baseline) {
	check("docker-nginx.conf", () =>
		comparePolicies(
			baseline,
			parseCsp(extractNginxCsp(read("docker-nginx.conf"))),
		),
	);
	check("tauri.conf.json csp", () =>
		comparePolicies(
			baseline,
			parseCsp(extractTauriCsps(read("desktop/src-tauri/tauri.conf.json")).csp),
		),
	);
	check("tauri.conf.json devCsp", () =>
		comparePolicies(
			baseline,
			parseCsp(
				extractTauriCsps(read("desktop/src-tauri/tauri.conf.json")).devCsp,
			),
			DEV_EXTRA_SOURCES,
		),
	);
}

if (failed) {
	console.error(
		"check-csp-sync: the baseline CSP is the <meta> tag in index.html; " +
			"update docker-nginx.conf / desktop/src-tauri/tauri.conf.json to match.",
	);
	process.exit(1);
}
console.log("check-csp-sync: CSP copies are in sync with index.html.");
