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

vi.mock("./keyBackupSetup", () => ({
	ensureKeyBackup: (...args: unknown[]) => ensureKeyBackup(...args),
	activateExistingKeyBackup: (...args: unknown[]) =>
		activateExistingKeyBackup(...args),
	fetchServerKeyBackup: (...args: unknown[]) => fetchServerKeyBackup(...args),
}));

const clearSecretStorageCache = vi.fn();

vi.mock("../../../client/client", () => ({
	useClient: () => ({
		client: {
			getCrypto: () => ({
				createRecoveryKeyFromPassphrase: vi.fn(async () => ({
					privateKey: new Uint8Array(),
					encodedPrivateKey: "new-key",
				})),
			}),
		},
		cryptoStatus: { refresh: vi.fn(async () => undefined) },
		clearSecretStorageCache,
	}),
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
});
