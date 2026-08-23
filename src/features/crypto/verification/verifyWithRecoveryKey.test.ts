import type { CrossSigningStatus } from "matrix-js-sdk/lib/crypto-api";
import { describe, expect, it, vi } from "vitest";
import { verifySessionWithRecoveryKey } from "./verifyWithRecoveryKey";

type Crypto = Parameters<typeof verifySessionWithRecoveryKey>[0];

function makeCrypto(
	overrides: Partial<{
		inSecretStorage: boolean;
		crossSigningVerified: boolean;
	}> = {},
) {
	const status: CrossSigningStatus = {
		publicKeysOnDevice: true,
		privateKeysInSecretStorage: overrides.inSecretStorage ?? true,
		privateKeysCachedLocally: {
			masterKey: false,
			selfSigningKey: false,
			userSigningKey: false,
		},
	};
	const crypto = {
		getCrossSigningStatus: vi.fn(async () => status),
		bootstrapCrossSigning: vi.fn(
			async (_opts?: Parameters<Crypto["bootstrapCrossSigning"]>[0]) => {},
		),
		getDeviceVerificationStatus: vi.fn(async () => ({
			crossSigningVerified: overrides.crossSigningVerified ?? true,
		})),
		crossSignDevice: vi.fn(async () => {}),
	};
	return crypto as unknown as Crypto & typeof crypto;
}

describe("verifySessionWithRecoveryKey", () => {
	it("imports the keys via bootstrap and leaves an already-signed device alone", async () => {
		const crypto = makeCrypto();
		await verifySessionWithRecoveryKey(crypto, "@u:hs", "DEV");
		expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(1);
		// Bootstrap's import path signed the device; no second signature.
		expect(crypto.crossSignDevice).not.toHaveBeenCalled();
	});

	it("signs the device explicitly when bootstrap did not", async () => {
		// Keys already cached locally: bootstrap's "nothing to do" path skips
		// the device signature, so the helper must sign rather than report a
		// verification that did not happen.
		const crypto = makeCrypto({ crossSigningVerified: false });
		await verifySessionWithRecoveryKey(crypto, "@u:hs", "DEV");
		expect(crypto.crossSignDevice).toHaveBeenCalledWith("DEV");
	});

	it("refuses to run when the keys are not in secret storage", async () => {
		// Bootstrap would otherwise create a NEW identity and orphan every
		// other session.
		const crypto = makeCrypto({ inSecretStorage: false });
		await expect(
			verifySessionWithRecoveryKey(crypto, "@u:hs", "DEV"),
		).rejects.toThrow(/not in secret storage/);
		expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
		expect(crypto.crossSignDevice).not.toHaveBeenCalled();
	});

	it("hands bootstrap an upload callback that refuses to publish a new identity", async () => {
		const crypto = makeCrypto();
		await verifySessionWithRecoveryKey(crypto, "@u:hs", "DEV");
		const opts = crypto.bootstrapCrossSigning.mock.calls[0][0];
		await expect(
			opts?.authUploadDeviceSigningKeys?.(async () => {}),
		).rejects.toThrow(/Refusing to replace/);
	});

	it("propagates a failed import (cancelled or wrong recovery key)", async () => {
		const crypto = makeCrypto();
		crypto.bootstrapCrossSigning.mockRejectedValueOnce(
			new Error("getSecretStorageKey callback returned falsey"),
		);
		await expect(
			verifySessionWithRecoveryKey(crypto, "@u:hs", "DEV"),
		).rejects.toThrow(/falsey/);
		expect(crypto.crossSignDevice).not.toHaveBeenCalled();
	});
});
