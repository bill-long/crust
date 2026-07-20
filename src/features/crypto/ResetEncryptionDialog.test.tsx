import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResetEncryptionDialog } from "./ResetEncryptionDialog";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const ensureKeyBackup = vi.fn();
const fetchServerKeyBackup = vi.fn();

vi.mock("./backup/keyBackupSetup", () => ({
	ensureKeyBackup: (...args: unknown[]) => ensureKeyBackup(...args),
	fetchServerKeyBackup: (...args: unknown[]) => fetchServerKeyBackup(...args),
}));

const resetEncryption = vi.fn();
const clearSecretStorageCache = vi.fn();
const refresh = vi.fn(async () => undefined);

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => "@test:example.com",
			getCrypto: () => ({
				resetEncryption,
				createRecoveryKeyFromPassphrase: vi.fn(async () => ({
					privateKey: new Uint8Array(),
					encodedPrivateKey: "brand-new-key",
				})),
			}),
		},
		cryptoStatus: { refresh },
		clearSecretStorageCache,
	}),
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function runThroughPassword(): Promise<void> {
	render(() => <ResetEncryptionDialog onClose={() => {}} />);
	fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
	await flush();
	fireEvent.input(screen.getByLabelText("Password"), {
		target: { value: "hunter2" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	await flush();
}

describe("ResetEncryptionDialog", () => {
	it("resets, re-establishes 4S, and shows the freshly minted recovery key", async () => {
		resetEncryption.mockResolvedValue(undefined);
		ensureKeyBackup.mockImplementation(
			async (
				_crypto: unknown,
				createKey: () => Promise<unknown>,
			): Promise<{ outcome: string }> => {
				await createKey();
				return { outcome: "reused" };
			},
		);

		await runThroughPassword();

		expect(resetEncryption).toHaveBeenCalledOnce();
		expect(ensureKeyBackup).toHaveBeenCalledOnce();
		expect(screen.getByText("Save your new recovery key")).toBeTruthy();
		expect(screen.getByText("brand-new-key")).toBeTruthy();
	});

	it("reaches done without a key step when no new key was minted", async () => {
		resetEncryption.mockResolvedValue(undefined);
		ensureKeyBackup.mockResolvedValue({ outcome: "reused" });

		await runThroughPassword();

		expect(screen.getByText("Encryption was reset")).toBeTruthy();
	});

	it("surfaces a reset failure and clears the cached 4S key", async () => {
		resetEncryption.mockRejectedValue(new Error("UIA failed"));

		await runThroughPassword();

		expect(screen.getByText("Reset failed")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain("UIA failed");
		expect(clearSecretStorageCache).toHaveBeenCalled();
	});

	it("shows the minted key with an incomplete warning when post-reset setup fails", async () => {
		resetEncryption.mockResolvedValue(undefined);
		ensureKeyBackup.mockImplementation(
			async (
				_crypto: unknown,
				createKey: () => Promise<unknown>,
			): Promise<never> => {
				await createKey();
				throw new Error("bootstrap failed");
			},
		);

		await runThroughPassword();

		expect(screen.getByText("Save your new recovery key")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain(
			"may not have finished completely",
		);
	});

	it("cancelling the password step returns to the intro", async () => {
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		await flush();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await flush();

		// Back at the intro copy, and nothing destructive was invoked.
		expect(
			screen.getByText(/Your account's encryption identity can't be recovered/),
		).toBeTruthy();
		expect(resetEncryption).not.toHaveBeenCalled();
	});
});
