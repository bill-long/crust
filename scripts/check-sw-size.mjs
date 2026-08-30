// The service worker must not pull the app's dependency graph in with it.
//
// `src/sw.ts` imports the notification-copy helpers, which import `lib/` -
// and any one of those importing something SDK-shaped drags the whole graph
// into a bundle that is fetched on every install and update. This caught a
// real 6.6x regression: `lib/displayName.ts` briefly imported
// `matrix-js-sdk/lib/utils` for a two-character regex, and `dist/sw.js` went
// from 25.6 kB to 168.9 kB. `check-vendor-chunks.mjs` did not see it, because
// it inspects the main entry's chunks and the service worker is a separate
// build.
//
// The ceiling is generous on purpose: it is a tripwire for an accidental
// dependency, not a byte budget. Raise it deliberately if the worker gains
// real functionality.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SW = join(process.cwd(), "dist", "sw.js");
// Tight enough that any accidental dependency shows, loose enough for real
// growth in the worker itself. It sits at ~25 kB; the regression this exists
// for took it to 169 kB. Raise deliberately, never to make a build pass.
const CEILING = 35 * 1024;
// Markers for SDK code actually inlined into the worker.
//
// These have to survive minification, which rules out identifiers: the build
// mangles names and erases import bindings, so "unhomoglyph" and
// "removeHiddenChars" appear in NO built chunk - not even the one that
// provably contains that function's body. A marker that can never match is
// worse than none, because the script then prints "no barred dependencies"
// and means nothing by it.
//
// Regex literals do survive. These two escapes are from the SDK's
// `removeHiddenCharsRegex` and appear nowhere in Crust's own source. Note
// `⠀` would NOT work as a marker despite being in the same regex -
// `lib/displayName.ts` legitimately contains it.
const BARRED = ["u2062", "u061C"];

let size;
try {
	size = statSync(SW).size;
} catch {
	process.stderr.write("\nService-worker check failed: dist/sw.js missing\n\n");
	process.exit(1);
}

const source = readFileSync(SW, "utf8");
const found = BARRED.filter((marker) => source.includes(marker));
const failures = [];
if (size > CEILING) {
	failures.push(
		`dist/sw.js is ${(size / 1024).toFixed(1)} kB, over the ${(CEILING / 1024).toFixed(0)} kB ceiling - ` +
			`something pulled a dependency into the worker graph`,
	);
}
for (const marker of found) {
	failures.push(`dist/sw.js contains "${marker}", which must not reach it`);
}

if (failures.length > 0) {
	process.stderr.write(
		`\nService-worker assertion failed:\n${failures.map((f) => `  - ${f}\n`).join("")}\n`,
	);
	process.exit(1);
}

console.log(
	`Service-worker assertion passed: dist/sw.js ${(size / 1024).toFixed(1)} kB ` +
		`under the ${(CEILING / 1024).toFixed(0)} kB ceiling, no barred dependencies.`,
);
