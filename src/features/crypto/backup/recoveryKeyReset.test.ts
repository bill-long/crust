import type {
	CrossSigningStatus,
	GeneratedSecretStorageKey,
	KeyBackupInfo,
} from "matrix-js-sdk/lib/crypto-api";
import { describe, expect, it, vi } from "vitest";
import {
	canConsolidateRecoveryKey,
	getConsolidationReadiness,
	secretStorageResetOpts,
} from "./recoveryKeyReset";

const createKey = async (): Promise<GeneratedSecretStorageKey> => ({
	privateKey: new Uint8Array(),
	encodedPrivateKey: "key",
});

function crossSigningStatus(allCached: boolean): CrossSigningStatus {
	return {
		publicKeysOnDevice: true,
		privateKeysInSecretStorage: true,
		privateKeysCachedLocally: {
			masterKey: allCached,
			selfSigningKey: allCached,
			userSigningKey: allCached,
		},
	};
}

type ReadinessCrypto = Parameters<typeof getConsolidationReadiness>[0];

function mockCrypto(overrides: Partial<ReadinessCrypto>): ReadinessCrypto {
	return {
		getCrossSigningStatus: vi.fn(async () => crossSigningStatus(true)),
		getKeyBackupInfo: vi.fn(async () => null),
		isKeyBackupTrusted: vi.fn(async () => ({
			trusted: true,
			matchesDecryptionKey: true,
		})),
		...overrides,
	} as ReadinessCrypto;
}

describe("canConsolidateRecoveryKey", () => {
	it("requires both cross-signing and backup keys to be local", () => {
		expect(
			canConsolidateRecoveryKey({
				crossSigningLocal: true,
				backupKeyLocal: true,
			}),
		).toBe(true);
		expect(
			canConsolidateRecoveryKey({
				crossSigningLocal: false,
				backupKeyLocal: true,
			}),
		).toBe(false);
		expect(
			canConsolidateRecoveryKey({
				crossSigningLocal: true,
				backupKeyLocal: false,
			}),
		).toBe(false);
	});
});

describe("getConsolidationReadiness", () => {
	it("requires all three cross-signing private keys cached locally", async () => {
		const ready = await getConsolidationReadiness(
			mockCrypto({
				getCrossSigningStatus: vi.fn(async () => crossSigningStatus(true)),
			}),
		);
		expect(ready.crossSigningLocal).toBe(true);

		const notReady = await getConsolidationReadiness(
			mockCrypto({
				getCrossSigningStatus: vi.fn(async () => ({
					publicKeysOnDevice: true,
					privateKeysInSecretStorage: true,
					privateKeysCachedLocally: {
						masterKey: true,
						selfSigningKey: false, // one missing → not local
						userSigningKey: true,
					},
				})),
			}),
		);
		expect(notReady.crossSigningLocal).toBe(false);
	});

	it("treats backup as local when there is no server backup", async () => {
		const ready = await getConsolidationReadiness(
			mockCrypto({ getKeyBackupInfo: vi.fn(async () => null) }),
		);
		expect(ready.backupKeyLocal).toBe(true);
	});

	it("requires an existing server backup to match the local decryption key", async () => {
		const matching = await getConsolidationReadiness(
			mockCrypto({
				getKeyBackupInfo: vi.fn(async () => ({}) as KeyBackupInfo),
				isKeyBackupTrusted: vi.fn(async () => ({
					trusted: true,
					matchesDecryptionKey: true,
				})),
			}),
		);
		expect(matching.backupKeyLocal).toBe(true);

		// A backup exists on the server but its key isn't local (e.g. created on
		// another device) → must block the reset, even though it isn't active
		// on this session.
		const mismatch = await getConsolidationReadiness(
			mockCrypto({
				getKeyBackupInfo: vi.fn(async () => ({}) as KeyBackupInfo),
				isKeyBackupTrusted: vi.fn(async () => ({
					trusted: false,
					matchesDecryptionKey: false,
				})),
			}),
		);
		expect(mismatch.backupKeyLocal).toBe(false);
	});
});

describe("secretStorageResetOpts", () => {
	it("forces new secret storage and preserves the backup version", () => {
		const opts = secretStorageResetOpts(createKey);
		expect(opts.setupNewSecretStorage).toBe(true);
		// Backup version must be preserved (not reset) during consolidation.
		expect("setupNewKeyBackup" in opts).toBe(false);
		expect(opts.createSecretStorageKey).toBe(createKey);
	});
});
