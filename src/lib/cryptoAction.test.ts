import { describe, expect, it } from "vitest";
import { cryptoActionLabel, deriveCryptoAction } from "./cryptoAction";

const HEALTHY = {
	crossSigningReady: true,
	thisDeviceVerified: true,
	backupVersion: "1",
	backupOnServer: true,
	crossSigningStatus: {
		publicKeysOnDevice: true,
		privateKeysInSecretStorage: true,
		privateKeysCachedLocally: {
			masterKey: true,
			selfSigningKey: true,
			userSigningKey: true,
		},
	},
} as const;

describe("deriveCryptoAction", () => {
	it("is hidden when everything is healthy", () => {
		expect(deriveCryptoAction({ ...HEALTHY })).toBe("hidden");
	});

	it("is loading while status is unresolved", () => {
		expect(
			deriveCryptoAction({ ...HEALTHY, crossSigningReady: undefined }),
		).toBe("loading");
		expect(
			deriveCryptoAction({ ...HEALTHY, thisDeviceVerified: undefined }),
		).toBe("loading");
	});

	it("routes first-time setup (no identity anywhere) to bootstrap", () => {
		expect(
			deriveCryptoAction({
				...HEALTHY,
				crossSigningReady: false,
				thisDeviceVerified: false,
				crossSigningStatus: {
					publicKeysOnDevice: false,
					privateKeysInSecretStorage: false,
					privateKeysCachedLocally: {
						masterKey: false,
						selfSigningKey: false,
						userSigningKey: false,
					},
				},
			}),
		).toBe("setup-cross-signing");
	});

	it("routes a recoverable identity (private keys in 4S) to bootstrap, not reset", () => {
		// Another client rotated the identity but stored the private keys in
		// secret storage: bootstrap imports them, so a destructive reset is
		// not needed (issue #420).
		expect(
			deriveCryptoAction({
				...HEALTHY,
				crossSigningReady: false,
				thisDeviceVerified: false,
				crossSigningStatus: {
					publicKeysOnDevice: true,
					privateKeysInSecretStorage: true,
					privateKeysCachedLocally: {
						masterKey: false,
						selfSigningKey: false,
						userSigningKey: false,
					},
				},
			}),
		).toBe("setup-cross-signing");
	});

	it("routes a locally-cached identity (all private keys on device) to bootstrap, not reset", () => {
		// Fail toward the non-destructive flow whenever any private key
		// source exists: bootstrap can reuse locally cached keys.
		expect(
			deriveCryptoAction({
				...HEALTHY,
				crossSigningReady: false,
				thisDeviceVerified: false,
				crossSigningStatus: {
					publicKeysOnDevice: true,
					privateKeysInSecretStorage: false,
					privateKeysCachedLocally: {
						masterKey: true,
						selfSigningKey: true,
						userSigningKey: true,
					},
				},
			}),
		).toBe("setup-cross-signing");
	});

	it("routes an unreachable identity to reset-encryption", () => {
		// Identity exists on the server but no private keys are reachable —
		// plain bootstrap would fail against the existing identity
		// (issue #420).
		expect(
			deriveCryptoAction({
				...HEALTHY,
				crossSigningReady: false,
				thisDeviceVerified: false,
				crossSigningStatus: {
					publicKeysOnDevice: true,
					privateKeysInSecretStorage: false,
					privateKeysCachedLocally: {
						masterKey: false,
						selfSigningKey: false,
						userSigningKey: false,
					},
				},
			}),
		).toBe("reset-encryption");
	});

	it("is loading while cross-signing detail is unresolved", () => {
		expect(
			deriveCryptoAction({
				...HEALTHY,
				crossSigningReady: false,
				thisDeviceVerified: false,
				crossSigningStatus: undefined,
			}),
		).toBe("loading");
	});

	it("routes an unverified device to verify-session", () => {
		expect(deriveCryptoAction({ ...HEALTHY, thisDeviceVerified: false })).toBe(
			"verify-session",
		);
	});

	it("routes no-backup to setup-backup", () => {
		expect(
			deriveCryptoAction({
				...HEALTHY,
				backupVersion: null,
				backupOnServer: false,
			}),
		).toBe("setup-backup");
	});

	it("routes an inaccessible server backup to unlock-backup, not setup", () => {
		// Backup exists on the server but this session has no access to its
		// decryption key (issue #420).
		expect(
			deriveCryptoAction({
				...HEALTHY,
				backupVersion: null,
				backupOnServer: true,
			}),
		).toBe("unlock-backup");
	});

	it("stays in loading while the server-backup probe is unresolved", () => {
		// Offering setup could orphan an existing backup; offering unlock
		// would be wrong when none exists — neither is safe until the probe
		// resolves.
		expect(
			deriveCryptoAction({
				...HEALTHY,
				backupVersion: null,
				backupOnServer: undefined,
			}),
		).toBe("loading");
	});
});

describe("cryptoActionLabel", () => {
	it("labels the new actions", () => {
		expect(cryptoActionLabel("unlock-backup")).toBe("Unlock key backup");
		expect(cryptoActionLabel("reset-encryption")).toBe("Reset encryption");
	});

	it("keeps existing labels", () => {
		expect(cryptoActionLabel("setup-cross-signing")).toBe(
			"Set up secure messaging",
		);
		expect(cryptoActionLabel("verify-session")).toBe("Verify this session");
		expect(cryptoActionLabel("setup-backup")).toBe("Set up key backup");
		expect(cryptoActionLabel("hidden")).toBe("");
	});
});
