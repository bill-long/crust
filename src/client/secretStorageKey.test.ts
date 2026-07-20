import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";
import { describe, expect, it, vi } from "vitest";
import { resolveSecretStorageKey } from "./secretStorageKey";

const KEY_INFO: SecretStorageKeyDescription = {
	name: "Recovery key",
	algorithm: "m.secret_storage.v1.aes-hmac-sha2",
	iv: "iv==",
	mac: "mac==",
	passphrase: { algorithm: "m.pbkdf2", iterations: 1, salt: "salt" },
};

describe("resolveSecretStorageKey", () => {
	it("uses the default key's fresh description when the offered set is stale", async () => {
		// Issue #420: another client re-keyed 4S; the SDK still offers the
		// OLD key while the account default points at the NEW one. The fresh
		// fetch must win so the genuine new recovery key validates.
		const choice = await resolveSecretStorageKey({
			offeredKeys: { "old-key": KEY_INFO },
			getDefaultKeyId: async () => "new-key",
			fetchKeyInfo: vi.fn(async () => ({ ...KEY_INFO, iv: "fresh-iv==" })),
		});

		expect(choice).toEqual({
			keyId: "new-key",
			keyInfo: { ...KEY_INFO, iv: "fresh-iv==" },
		});
	});

	it("falls back to the offered default when the fresh fetch fails", async () => {
		const choice = await resolveSecretStorageKey({
			offeredKeys: { "default-key": KEY_INFO },
			getDefaultKeyId: async () => "default-key",
			fetchKeyInfo: vi.fn(async () => {
				throw new Error("network down");
			}),
		});

		expect(choice).toEqual({ keyId: "default-key", keyInfo: KEY_INFO });
	});

	it("falls back to the offered default when the fresh description is tombstoned", async () => {
		// A wiped 4S leaves `m.secret_storage.key.*` events with empty
		// content — no iv/mac to validate against.
		const choice = await resolveSecretStorageKey({
			offeredKeys: { "default-key": KEY_INFO },
			getDefaultKeyId: async () => "default-key",
			fetchKeyInfo: vi.fn(async () => ({}) as never),
		});

		expect(choice).toEqual({ keyId: "default-key", keyInfo: KEY_INFO });
	});

	it("uses the first offered key when the default is unknown everywhere", async () => {
		const choice = await resolveSecretStorageKey({
			offeredKeys: { "only-key": KEY_INFO },
			getDefaultKeyId: async () => "deleted-key",
			fetchKeyInfo: vi.fn(async () => null),
		});

		expect(choice).toEqual({ keyId: "only-key", keyInfo: KEY_INFO });
	});

	it("uses the first offered key when there is no default", async () => {
		const choice = await resolveSecretStorageKey({
			offeredKeys: { "only-key": KEY_INFO },
			getDefaultKeyId: async () => null,
			fetchKeyInfo: vi.fn(async () => null),
		});

		expect(choice).toEqual({ keyId: "only-key", keyInfo: KEY_INFO });
	});

	it("returns null when there are no keys at all", async () => {
		const choice = await resolveSecretStorageKey({
			offeredKeys: {},
			getDefaultKeyId: async () => "default-key",
			fetchKeyInfo: vi.fn(async () => null),
		});

		expect(choice).toBeNull();
	});
});
