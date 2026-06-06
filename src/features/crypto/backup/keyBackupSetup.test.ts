import { ClientPrefix, MatrixError, Method } from "matrix-js-sdk";
import type {
	CreateSecretStorageOpts,
	GeneratedSecretStorageKey,
	KeyBackupInfo,
} from "matrix-js-sdk/lib/crypto-api";
import { describe, expect, it, vi } from "vitest";
import {
	activateExistingKeyBackup,
	ensureKeyBackup,
	fetchServerKeyBackup,
} from "./keyBackupSetup";

const createKey: NonNullable<
	CreateSecretStorageOpts["createSecretStorageKey"]
> = async (): Promise<GeneratedSecretStorageKey> => ({
	privateKey: new Uint8Array(),
	encodedPrivateKey: "key",
});

type EnsureCrypto = Parameters<typeof ensureKeyBackup>[0];

function mockEnsureCrypto(overrides: Partial<EnsureCrypto> = {}): EnsureCrypto {
	return {
		bootstrapSecretStorage: vi.fn(async () => undefined),
		checkKeyBackupAndEnable: vi.fn(async () => null),
		getActiveSessionBackupVersion: vi.fn(async () => "1"),
		...overrides,
	} as EnsureCrypto;
}

const noServerBackup = async (): Promise<KeyBackupInfo | null> => null;
const existingServerBackup = async (): Promise<KeyBackupInfo | null> =>
	({}) as KeyBackupInfo;

describe("ensureKeyBackup", () => {
	it("creates a new backup when the server has none", async () => {
		const crypto = mockEnsureCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => "1"),
		});

		const result = await ensureKeyBackup(crypto, createKey, noServerBackup);

		expect(result).toEqual({ outcome: "created" });
		// Must request a NEW backup only because none exists.
		expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith({
			createSecretStorageKey: createKey,
			setupNewKeyBackup: true,
		});
	});

	it("reuses (does not reset) an existing backup that is active", async () => {
		const crypto = mockEnsureCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => "7"),
		});

		const result = await ensureKeyBackup(
			crypto,
			createKey,
			existingServerBackup,
		);

		expect(result).toEqual({ outcome: "reused" });
		// Critically: never request a new backup when one already exists.
		expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith({
			createSecretStorageKey: createKey,
			setupNewKeyBackup: false,
		});
	});

	it("reports needs-restore when a backup exists but isn't active", async () => {
		const crypto = mockEnsureCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => null),
		});

		const result = await ensureKeyBackup(
			crypto,
			createKey,
			existingServerBackup,
		);

		expect(result).toEqual({ outcome: "needs-restore" });
		expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith({
			createSecretStorageKey: createKey,
			setupNewKeyBackup: false,
		});
	});

	it("reports needs-restore when a freshly-created backup is somehow inactive", async () => {
		const crypto = mockEnsureCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => null),
		});

		const result = await ensureKeyBackup(crypto, createKey, noServerBackup);

		expect(result).toEqual({ outcome: "needs-restore" });
	});

	it("propagates a thrown detection error instead of resetting", async () => {
		const bootstrap = vi.fn(async () => undefined);
		const crypto = mockEnsureCrypto({ bootstrapSecretStorage: bootstrap });
		const detect = vi.fn(async () => {
			throw new Error("network down");
		});

		await expect(ensureKeyBackup(crypto, createKey, detect)).rejects.toThrow(
			"network down",
		);
		// Must NOT have touched secret storage / backup on an uncertain check.
		expect(bootstrap).not.toHaveBeenCalled();
	});

	it("awaits enable before reading the active version (SDK enables async)", async () => {
		// Model the SDK: resetKeyBackup fires checkKeyBackupAndEnable without
		// awaiting, so the backup is inactive until enable resolves.
		let enabled = false;
		const crypto = mockEnsureCrypto({
			checkKeyBackupAndEnable: vi.fn(async () => {
				enabled = true;
				return null;
			}),
			getActiveSessionBackupVersion: vi.fn(async () => (enabled ? "1" : null)),
		});

		const result = await ensureKeyBackup(crypto, createKey, noServerBackup);

		// Without the explicit await, this would be needs-restore.
		expect(result).toEqual({ outcome: "created" });
		expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalled();
	});
});

type FetchClient = Parameters<typeof fetchServerKeyBackup>[0];

function mockFetchClient(authedRequest: () => Promise<unknown>): FetchClient {
	return { http: { authedRequest } } as unknown as FetchClient;
}

describe("fetchServerKeyBackup", () => {
	it("queries GET /room_keys/version on the v3 client prefix", async () => {
		const authedRequest = vi.fn(async () => ({}) as KeyBackupInfo);
		const client = mockFetchClient(authedRequest);

		await fetchServerKeyBackup(client);

		expect(authedRequest).toHaveBeenCalledWith(
			Method.Get,
			"/room_keys/version",
			undefined,
			undefined,
			{ prefix: ClientPrefix.V3 },
		);
	});

	it("returns the backup info when one exists", async () => {
		const info = { version: "3" } as KeyBackupInfo;
		const client = mockFetchClient(async () => info);

		await expect(fetchServerKeyBackup(client)).resolves.toBe(info);
	});

	it("returns null only for a definitive M_NOT_FOUND (no backup)", async () => {
		const client = mockFetchClient(async () => {
			throw new MatrixError({ errcode: "M_NOT_FOUND" }, 404);
		});

		await expect(fetchServerKeyBackup(client)).resolves.toBeNull();
	});

	it("propagates a M_NOT_FOUND that isn't a real 404 (e.g. proxy)", async () => {
		const client = mockFetchClient(async () => {
			throw new MatrixError({ errcode: "M_NOT_FOUND" }, 503);
		});

		await expect(fetchServerKeyBackup(client)).rejects.toBeInstanceOf(
			MatrixError,
		);
	});

	it("propagates any non-404 error (uncertain — never treated as none)", async () => {
		const client = mockFetchClient(async () => {
			throw new MatrixError({ errcode: "M_UNKNOWN" }, 500);
		});

		await expect(fetchServerKeyBackup(client)).rejects.toBeInstanceOf(
			MatrixError,
		);
	});

	it("propagates a non-MatrixError (e.g. network failure)", async () => {
		const client = mockFetchClient(async () => {
			throw new Error("network down");
		});

		await expect(fetchServerKeyBackup(client)).rejects.toThrow("network down");
	});
});

type ActivateCrypto = Parameters<typeof activateExistingKeyBackup>[0];

function mockActivateCrypto(
	overrides: Partial<ActivateCrypto> = {},
): ActivateCrypto {
	return {
		loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => undefined),
		checkKeyBackupAndEnable: vi.fn(async () => null),
		getActiveSessionBackupVersion: vi.fn(async () => "1"),
		...overrides,
	} as ActivateCrypto;
}

describe("activateExistingKeyBackup", () => {
	it("loads the key from secret storage, enables, and reports active", async () => {
		const crypto = mockActivateCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => "1"),
		});

		await expect(activateExistingKeyBackup(crypto)).resolves.toBe(true);
		expect(
			crypto.loadSessionBackupPrivateKeyFromSecretStorage,
		).toHaveBeenCalled();
		expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalled();
	});

	it("reports false when the backup is still inactive afterwards", async () => {
		const crypto = mockActivateCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => null),
		});

		await expect(activateExistingKeyBackup(crypto)).resolves.toBe(false);
	});
});
