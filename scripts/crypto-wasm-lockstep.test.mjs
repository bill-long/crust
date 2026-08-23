import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

// src/client/client.tsx imports `@matrix-org/matrix-sdk-crypto-wasm` directly
// (the module-load step of crypto recovery, see src/client/cryptoRecovery.ts)
// while matrix-js-sdk imports it for real. That only works if both resolve to
// ONE installed copy: `initAsync` memoizes per module instance, so a second
// copy would fetch the ~8 MB wasm twice and the app's pre-load would prove
// nothing about the SDK's. pnpm dedupes the two as long as the version ranges
// in package.json (ours) and matrix-js-sdk's package.json overlap - a
// matrix-js-sdk bump that moves to a new major of the wasm package must bump
// ours with it. (A .mjs under scripts/ like csp-lib.test.mjs: the app tsconfig
// has no Node types for node:module.)
describe("@matrix-org/matrix-sdk-crypto-wasm", () => {
	it("resolves to the single copy matrix-js-sdk uses", () => {
		const require = createRequire(import.meta.url);
		const ours = dirname(require.resolve("@matrix-org/matrix-sdk-crypto-wasm"));
		const sdkRequire = createRequire(
			require.resolve("matrix-js-sdk/package.json"),
		);
		const theirs = dirname(
			sdkRequire.resolve("@matrix-org/matrix-sdk-crypto-wasm"),
		);
		expect(theirs).toBe(ours);
	});
});
