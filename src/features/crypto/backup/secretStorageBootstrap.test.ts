import { describe, expect, it } from "vitest";
import { secretStorageBootstrapOpts } from "./secretStorageBootstrap";

const createKey = async () =>
	({ encodedPrivateKey: "key" }) as unknown as Awaited<
		ReturnType<NonNullable<Parameters<typeof secretStorageBootstrapOpts>[0]>>
	>;

describe("secretStorageBootstrapOpts", () => {
	it("never forces new secret storage (reuses existing, no extra recovery key)", () => {
		const opts = secretStorageBootstrapOpts(createKey);
		// The whole point of the fix: this flag must never be set, or the SDK
		// mints a fresh recovery key on every run.
		expect("setupNewSecretStorage" in opts).toBe(false);
		expect(opts.createSecretStorageKey).toBe(createKey);
	});

	it("sets up a key backup", () => {
		expect(secretStorageBootstrapOpts(createKey).setupNewKeyBackup).toBe(true);
	});
});
