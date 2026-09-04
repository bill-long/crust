import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupSetupDialog } from "./BackupSetupDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const ensureKeyBackup = vi.fn();
const activateExistingKeyBackup = vi.fn();
const fetchServerKeyBackup = vi.fn();
const bootstrapSecretStorage = vi.fn();

vi.mock("./keyBackupSetup", () => ({
	ensureKeyBackup: (...args: unknown[]) => ensureKeyBackup(...args),
	activateExistingKeyBackup: (...args: unknown[]) =>
		activateExistingKeyBackup(...args),
	fetchServerKeyBackup: (...args: unknown[]) => fetchServerKeyBackup(...args),
}));

const clearSecretStorageCache = vi.fn();
const refresh = vi.fn(async () => undefined);

vi.mock("../../../client/client", () => ({
	useClient: () => ({
		client: {
			getCrypto: () => ({
				createRecoveryKeyFromPassphrase: vi.fn(async () => ({
					privateKey: new Uint8Array(),
					encodedPrivateKey: "new-key",
				})),
				bootstrapSecretStorage: (...args: unknown[]) =>
					bootstrapSecretStorage(...args),
				checkKeyBackupAndEnable: vi.fn(async () => undefined),
				getActiveSessionBackupVersion: vi.fn(async () => null),
			}),
		},
		cryptoStatus: { refresh },
		clearSecretStorageCache,
	}),
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface BootstrapOpts {
	createSecretStorageKey: () => Promise<unknown>;
}

interface TrackedCrypto {
	bootstrapSecretStorage: (opts: BootstrapOpts) => Promise<void>;
}

const runBootstrap = (
	crypto: TrackedCrypto,
	createSecretStorageKey: () => Promise<unknown>,
): Promise<void> => crypto.bootstrapSecretStorage({ createSecretStorageKey });

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("BackupSetupDialog", () => {
	it("routes a needs-restore outcome to the unlock flow, not a false success", async () => {
		ensureKeyBackup.mockResolvedValue({ outcome: "needs-restore" });
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await flush();

		expect(screen.getByText("Unlock your key backup")).toBeTruthy();
		expect(screen.queryByText("Key backup is set up")).toBeNull();
	});

	it("reaches done when restoring an existing backup succeeds", async () => {
		ensureKeyBackup.mockResolvedValue({ outcome: "needs-restore" });
		activateExistingKeyBackup.mockResolvedValue(true);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await flush();
		fireEvent.click(screen.getByText("Unlock backup"));
		await flush();

		expect(screen.getByText("Key backup is set up")).toBeTruthy();
	});

	it("stays in restore-needed with an alert when unlock fails", async () => {
		ensureKeyBackup.mockResolvedValue({ outcome: "needs-restore" });
		activateExistingKeyBackup.mockResolvedValue(false);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await flush();
		fireEvent.click(screen.getByText("Unlock backup"));
		await flush();

		expect(screen.getByText("Unlock your key backup")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain(
			"Couldn't unlock the existing key backup",
		);
		expect(clearSecretStorageCache).toHaveBeenCalled();
	});

	it("shows a freshly minted recovery key before routing to restore", async () => {
		// Backup exists but 4S didn't: a new recovery key is minted AND the
		// backup still needs unlocking. The key must be shown first.
		ensureKeyBackup.mockImplementation(
			async (
				_crypto: unknown,
				createKey: () => Promise<unknown>,
			): Promise<{ outcome: string }> => {
				await createKey();
				return { outcome: "needs-restore" };
			},
		);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await flush();

		// Recovery key is surfaced (not skipped) even though a restore is pending.
		expect(screen.getByText("Save your recovery key")).toBeTruthy();

		fireEvent.click(screen.getByText("I've saved my key"));
		await flush();

		// After saving the key, the user is routed to unlock — not a false done.
		expect(screen.getByText("Unlock your key backup")).toBeTruthy();
	});

	it("keeps the 4S cache when bootstrap fails after the dialog is gone", async () => {
		// bootstrapSecretStorage can cache a recovery key before it fails, and
		// it can settle long after a logout or route change unmounted the dialog.
		// The cached key is validated against the offered/current key before its
		// next reuse, so this opaque failure does not justify a broad drop.
		let failBootstrap: ((e: Error) => void) | undefined;
		bootstrapSecretStorage.mockImplementation(async (opts: BootstrapOpts) => {
			await opts.createSecretStorageKey();
			return new Promise((_resolve, reject) => {
				failBootstrap = reject;
			});
		});
		ensureKeyBackup.mockImplementation(
			(crypto: TrackedCrypto, createKey: () => Promise<unknown>) =>
				runBootstrap(crypto, createKey),
		);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await vi.waitFor(() => expect(failBootstrap).toBeTypeOf("function"));

		cleanup();
		failBootstrap?.(new Error("network died"));
		await flush();
		expect(clearSecretStorageCache).not.toHaveBeenCalled();
	});

	it("keeps the 4S cache when setup fails before bootstrap starts", async () => {
		// A transient backup-discovery failure occurs before ensureKeyBackup
		// calls bootstrapSecretStorage, so the cached key is still current.
		ensureKeyBackup.mockRejectedValue(new Error("network died"));
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

		expect(bootstrapSecretStorage).not.toHaveBeenCalled();
		expect(clearSecretStorageCache).not.toHaveBeenCalled();
	});

	it("shows a key minted before bootstrap fails", async () => {
		bootstrapSecretStorage.mockImplementation(async (opts: BootstrapOpts) => {
			await opts.createSecretStorageKey();
			throw new Error("network died");
		});
		ensureKeyBackup.mockImplementation(
			(crypto: TrackedCrypto, createKey: () => Promise<unknown>) =>
				runBootstrap(crypto, createKey),
		);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await vi.waitFor(() =>
			expect(screen.getByText("Save your recovery key")).toBeTruthy(),
		);

		expect(screen.getByText("new-key")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain(
			"Setup did not finish completely",
		);
		expect(clearSecretStorageCache).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByText("I've saved my key"));
		expect(screen.getByText("Backup setup failed")).toBeTruthy();
		expect(screen.queryByText("Key backup is set up")).toBeNull();
	});

	it("keeps the 4S cache when setup fails after bootstrap finishes", async () => {
		bootstrapSecretStorage.mockImplementation(async (opts: BootstrapOpts) => {
			await opts.createSecretStorageKey();
		});
		ensureKeyBackup.mockImplementation(
			async (crypto: TrackedCrypto, createKey: () => Promise<unknown>) => {
				await runBootstrap(crypto, createKey);
				throw new Error("activation died");
			},
		);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await vi.waitFor(() =>
			expect(screen.getByText("Save your recovery key")).toBeTruthy(),
		);

		expect(bootstrapSecretStorage).toHaveBeenCalledOnce();
		expect(clearSecretStorageCache).not.toHaveBeenCalled();
	});

	it("drops the 4S cache when an unlock is refused after the dialog is gone", async () => {
		// A backup that stays inactive resolves `false` rather than throwing,
		// so this is a separate site from the catch above.
		ensureKeyBackup.mockResolvedValue({ outcome: "needs-restore" });
		let finishActivate: ((activated: boolean) => void) | undefined;
		activateExistingKeyBackup.mockReturnValue(
			new Promise((resolve) => {
				finishActivate = resolve;
			}),
		);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await flush();
		fireEvent.click(screen.getByText("Unlock backup"));
		await vi.waitFor(() =>
			expect(activateExistingKeyBackup).toHaveBeenCalled(),
		);

		cleanup();
		finishActivate?.(false);
		await vi.waitFor(() => expect(clearSecretStorageCache).toHaveBeenCalled());
	});

	it("drops the 4S cache when an unlock throws after the dialog is gone", async () => {
		ensureKeyBackup.mockResolvedValue({ outcome: "needs-restore" });
		let failActivate: ((e: Error) => void) | undefined;
		activateExistingKeyBackup.mockReturnValue(
			new Promise((_resolve, reject) => {
				failActivate = reject;
			}),
		);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await flush();
		fireEvent.click(screen.getByText("Unlock backup"));
		await vi.waitFor(() =>
			expect(activateExistingKeyBackup).toHaveBeenCalled(),
		);

		cleanup();
		failActivate?.(new Error("network died"));
		await vi.waitFor(() => expect(clearSecretStorageCache).toHaveBeenCalled());
	});

	it("keeps the cache when an unlock succeeds after the dialog is gone", async () => {
		// The mirror of the two cases above, and why the drop is keyed on the
		// outcome rather than on the dialog being gone: an activated backup
		// means the cached key is the working one.
		ensureKeyBackup.mockResolvedValue({ outcome: "needs-restore" });
		let finishActivate: ((activated: boolean) => void) | undefined;
		activateExistingKeyBackup.mockReturnValue(
			new Promise((resolve) => {
				finishActivate = resolve;
			}),
		);
		render(() => <BackupSetupDialog onClose={() => {}} />);

		fireEvent.click(screen.getByText("Continue"));
		await flush();
		fireEvent.click(screen.getByText("Unlock backup"));
		await vi.waitFor(() =>
			expect(activateExistingKeyBackup).toHaveBeenCalled(),
		);

		cleanup();
		finishActivate?.(true);
		// Give the settled restore a macrotask to (wrongly) clear.
		await flush();
		expect(clearSecretStorageCache).not.toHaveBeenCalled();
	});
});
