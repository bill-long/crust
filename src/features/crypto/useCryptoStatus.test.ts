import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCryptoStatus } from "./useCryptoStatus";

const fetchServerKeyBackup = vi.fn();

vi.mock("./backup/keyBackupSetup", () => ({
	fetchServerKeyBackup: (...args: unknown[]) => fetchServerKeyBackup(...args),
}));

function makeCrypto(overrides: Record<string, unknown> = {}) {
	return {
		isCrossSigningReady: vi.fn(async () => true),
		isSecretStorageReady: vi.fn(async () => true),
		getActiveSessionBackupVersion: vi.fn(async () => "1"),
		getCrossSigningStatus: vi.fn(async () => ({
			publicKeysOnDevice: true,
			privateKeysInSecretStorage: true,
			privateKeysCachedLocally: {
				masterKey: true,
				selfSigningKey: true,
				userSigningKey: true,
			},
		})),
		getDeviceVerificationStatus: vi.fn(async () => ({
			localVerified: true,
			crossSigningVerified: true,
			tofu: false,
			isVerified: () => true,
		})),
		getKeyBackupInfo: vi.fn(async () => ({ version: "1" })),
		isKeyBackupTrusted: vi.fn(async () => ({ trusted: true })),
		...overrides,
	};
}

function makeClient(crypto: ReturnType<typeof makeCrypto>) {
	return {
		getCrypto: () => crypto,
		getUserId: () => "@test:example.com",
		getDeviceId: () => "TESTDEVICE",
		on: vi.fn(),
		removeListener: vi.fn(),
		// biome-ignore lint/suspicious/noExplicitAny: test double for MatrixClient
	} as any;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function createStatus(
	crypto: ReturnType<typeof makeCrypto>,
	serverBackup?: { resolves?: unknown; rejects?: unknown },
): Promise<ReturnType<typeof useCryptoStatus>> {
	fetchServerKeyBackup.mockReset();
	if (serverBackup?.rejects !== undefined) {
		fetchServerKeyBackup.mockRejectedValue(serverBackup.rejects);
	} else {
		fetchServerKeyBackup.mockResolvedValue(serverBackup?.resolves ?? null);
	}
	const client = makeClient(crypto);
	const [syncReady] = createSignal(true);
	let status!: ReturnType<typeof useCryptoStatus>;
	createRoot(() => {
		status = useCryptoStatus(client, syncReady);
	});
	await flush();
	return status;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("useCryptoStatus", () => {
	it("reports the device verified when cross-signed by the current identity", async () => {
		const status = await createStatus(makeCrypto());
		expect(status.thisDeviceVerified()).toBe(true);
	});

	it("does NOT report verified from localVerified alone (issue #420)", async () => {
		// After another client rotates the cross-signing identity, the own
		// device is still locally trusted but no longer cross-signed. The
		// badge must reflect that, not stay green via isVerified().
		const crypto = makeCrypto({
			getDeviceVerificationStatus: vi.fn(async () => ({
				localVerified: true,
				crossSigningVerified: false,
				tofu: false,
				isVerified: () => true, // SDK semantics: localVerified passes
			})),
		});
		const status = await createStatus(crypto);
		expect(status.thisDeviceVerified()).toBe(false);
	});

	it("reports backupOnServer=true when an inactive backup exists on the server", async () => {
		const crypto = makeCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => null),
		});
		const status = await createStatus(crypto, { resolves: { version: "7" } });
		expect(status.backupVersion()).toBeNull();
		expect(status.backupOnServer()).toBe(true);
	});

	it("still refreshes the rest of the status when cross-signing detail fails", async () => {
		// getCrossSigningStatus is best-effort detail for reset-vs-bootstrap
		// routing; a transient failure must not strand the other signals.
		const crypto = makeCrypto({
			getCrossSigningStatus: vi.fn(async () => {
				throw new Error("transient");
			}),
		});
		const status = await createStatus(crypto);
		expect(status.crossSigningReady()).toBe(true);
		expect(status.thisDeviceVerified()).toBe(true);
		expect(status.backupVersion()).toBe("1");
		expect(status.crossSigningStatus()).toBeUndefined();
	});

	it("keeps thisDeviceVerified unknown (not false) when the check fails", async () => {
		// A transient failure must not masquerade as "not verified" — that
		// would misroute the UI into verify-session during refresh errors.
		const crypto = makeCrypto({
			getDeviceVerificationStatus: vi.fn(async () => {
				throw new Error("transient");
			}),
		});
		const status = await createStatus(crypto);
		expect(status.thisDeviceVerified()).toBeUndefined();
		expect(status.crossSigningReady()).toBe(true);
	});

	it("probes the server backup once, re-probing only after a backup event", async () => {
		// refresh() runs on several CryptoEvents; without caching, a sync
		// burst would re-probe /room_keys/version on every one.
		const crypto = makeCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => null),
		});
		const client = makeClient(crypto);
		fetchServerKeyBackup.mockReset();
		fetchServerKeyBackup.mockResolvedValue(null);
		const [syncReady] = createSignal(true);
		let status!: ReturnType<typeof useCryptoStatus>;
		createRoot(() => {
			status = useCryptoStatus(client, syncReady);
		});
		await flush();
		expect(fetchServerKeyBackup).toHaveBeenCalledTimes(1);

		// A second refresh (any non-backup CryptoEvent) reuses the cache.
		await status.refresh();
		expect(fetchServerKeyBackup).toHaveBeenCalledTimes(1);

		// A KeyBackupStatus event invalidates the cache and re-probes.
		const onBackupStatus = client.on.mock.calls.find(
			(call: unknown[]) => call[0] === CryptoEvent.KeyBackupStatus,
		)?.[1] as (() => void) | undefined;
		expect(onBackupStatus).toBeDefined();
		onBackupStatus?.();
		await flush();
		expect(fetchServerKeyBackup).toHaveBeenCalledTimes(2);
	});

	it("reports backupOnServer=false when the server has no backup", async () => {
		const crypto = makeCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => null),
		});
		const status = await createStatus(crypto, { resolves: null });
		expect(status.backupOnServer()).toBe(false);
	});

	it("leaves backupOnServer undefined when the server check is uncertain", async () => {
		const crypto = makeCrypto({
			getActiveSessionBackupVersion: vi.fn(async () => null),
		});
		const status = await createStatus(crypto, { rejects: new Error("500") });
		expect(status.backupOnServer()).toBeUndefined();
	});

	it("does not hit the server backup check when a backup is already active", async () => {
		const status = await createStatus(makeCrypto());
		expect(status.backupOnServer()).toBe(true);
		expect(fetchServerKeyBackup).not.toHaveBeenCalled();
	});

	it("exposes the cross-signing status detail", async () => {
		const status = await createStatus(makeCrypto());
		expect(status.crossSigningStatus()?.publicKeysOnDevice).toBe(true);
	});
});
