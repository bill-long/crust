import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryKeyResetDialog } from "./RecoveryKeyResetDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const bootstrapSecretStorage = vi.fn();
const getSecretStorageStatus = vi.fn();
const clearSecretStorageCache = vi.fn();

// The readiness gate runs for real: only its inputs are stubbed, so a test
// that reaches the re-key has genuinely passed the local-possession check.
const cryptoApi = {
	getCrossSigningStatus: vi.fn(),
	getKeyBackupInfo: vi.fn(),
	isKeyBackupTrusted: vi.fn(),
	createRecoveryKeyFromPassphrase: vi.fn(),
	bootstrapSecretStorage: (...args: unknown[]) =>
		bootstrapSecretStorage(...args),
	getSecretStorageStatus: (...args: unknown[]) =>
		getSecretStorageStatus(...args),
};

vi.mock("../../../client/client", () => ({
	useClient: () => ({
		client: { getCrypto: () => cryptoApi },
		cryptoStatus: { refresh: vi.fn(async () => undefined) },
		clearSecretStorageCache,
	}),
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const startReset = (): void => {
	render(() => <RecoveryKeyResetDialog onClose={() => {}} />);
	fireEvent.click(screen.getByRole("button", { name: "Reset recovery key" }));
};

beforeEach(() => {
	cryptoApi.getCrossSigningStatus.mockResolvedValue({
		privateKeysCachedLocally: {
			masterKey: true,
			selfSigningKey: true,
			userSigningKey: true,
		},
	});
	cryptoApi.getKeyBackupInfo.mockResolvedValue(null);
	cryptoApi.isKeyBackupTrusted.mockResolvedValue({
		matchesDecryptionKey: true,
	});
	cryptoApi.createRecoveryKeyFromPassphrase.mockResolvedValue({
		privateKey: new Uint8Array(),
		encodedPrivateKey: "new-key",
	});
	bootstrapSecretStorage.mockImplementation(
		async (opts: { createSecretStorageKey: () => Promise<unknown> }) => {
			await opts.createSecretStorageKey();
		},
	);
	getSecretStorageStatus.mockResolvedValue({ ready: true });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("RecoveryKeyResetDialog", () => {
	it("shows the new recovery key when the re-key succeeds", async () => {
		startReset();
		await flush();

		expect(screen.getByText("Save your new recovery key")).toBeTruthy();
		expect(screen.getByText("new-key")).toBeTruthy();
		expect(clearSecretStorageCache).not.toHaveBeenCalled();
	});

	it("drops the 4S cache when the re-key fails after the dialog is gone", async () => {
		// bootstrapSecretStorage caches the new key as it writes it, and can
		// settle long after a logout or route change has unmounted the dialog.
		// Clearing the cache touches no UI, so the drop must not sit behind
		// the mount check (#564).
		let failBootstrap: ((e: Error) => void) | undefined;
		bootstrapSecretStorage.mockReturnValue(
			new Promise((_resolve, reject) => {
				failBootstrap = reject;
			}),
		);
		startReset();
		await vi.waitFor(() => expect(bootstrapSecretStorage).toHaveBeenCalled());

		cleanup();
		failBootstrap?.(new Error("network died"));
		await vi.waitFor(() => expect(clearSecretStorageCache).toHaveBeenCalled());
	});
});
