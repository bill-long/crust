import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
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

// Mutable so individual tests can simulate missing crypto / missing user.
const clientState: {
	userId: string | null;
	crypto: unknown;
} = {
	userId: "@test:example.com",
	crypto: undefined, // set in beforeEach-equivalent below via resetClientState
};

function resetClientState(): void {
	clientState.userId = "@test:example.com";
	clientState.crypto = {
		resetEncryption,
		createRecoveryKeyFromPassphrase: vi.fn(async () => ({
			privateKey: new Uint8Array(),
			encodedPrivateKey: "brand-new-key",
		})),
	};
}
resetClientState();

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => clientState.userId,
			getCrypto: () => clientState.crypto,
		},
		cryptoStatus: { refresh },
		clearSecretStorageCache,
	}),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	resetClientState();
});

async function runThroughPassword(
	onClose: () => void = () => {},
): Promise<void> {
	render(() => <ResetEncryptionDialog onClose={onClose} />);
	fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
	fireEvent.input(await screen.findByLabelText("Password"), {
		target: { value: "hunter2" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
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
		await waitFor(() =>
			expect(screen.getByText("Save your new recovery key")).toBeTruthy(),
		);

		expect(resetEncryption).toHaveBeenCalledOnce();
		expect(ensureKeyBackup).toHaveBeenCalledOnce();
		expect(screen.getByText("brand-new-key")).toBeTruthy();
	});

	it("reaches done without a key step when no new key was minted", async () => {
		resetEncryption.mockResolvedValue(undefined);
		ensureKeyBackup.mockResolvedValue({ outcome: "reused" });

		await runThroughPassword();
		await waitFor(() =>
			expect(screen.getByText("Encryption was reset")).toBeTruthy(),
		);
	});

	it("warns of an incomplete setup when the backup reports needs-restore", async () => {
		// Non-exception partial path: a key was minted but the new backup
		// still needs a restore before it fully protects history.
		resetEncryption.mockResolvedValue(undefined);
		ensureKeyBackup.mockImplementation(
			async (
				_crypto: unknown,
				createKey: () => Promise<unknown>,
			): Promise<{ outcome: string }> => {
				await createKey();
				return { outcome: "needs-restore" };
			},
		);

		await runThroughPassword();
		await waitFor(() =>
			expect(screen.getByText("Save your new recovery key")).toBeTruthy(),
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"may not have finished completely",
		);
	});

	it("surfaces a reset failure and clears the cached 4S key", async () => {
		resetEncryption.mockRejectedValue(new Error("UIA failed"));

		await runThroughPassword();
		await waitFor(() => expect(screen.getByText("Reset failed")).toBeTruthy());

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
		await waitFor(() =>
			expect(screen.getByText("Save your new recovery key")).toBeTruthy(),
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"may not have finished completely",
		);
	});

	it("fails fast when encryption is unavailable on this client", async () => {
		clientState.crypto = undefined;
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		fireEvent.input(await screen.findByLabelText("Password"), {
			target: { value: "hunter2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(screen.getByText("Reset failed")).toBeTruthy());
		expect(screen.getByRole("alert").textContent).toContain(
			"Encryption is not available.",
		);
		expect(resetEncryption).not.toHaveBeenCalled();
	});

	it("fails fast when the user id cannot be determined", async () => {
		clientState.userId = null;
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		fireEvent.input(await screen.findByLabelText("Password"), {
			target: { value: "hunter2" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(screen.getByText("Reset failed")).toBeTruthy());
		expect(screen.getByRole("alert").textContent).toContain(
			"Unable to determine user ID.",
		);
		expect(resetEncryption).not.toHaveBeenCalled();
	});

	it("cancelling the password step returns to the intro", async () => {
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		await screen.findByLabelText("Password");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() =>
			expect(
				screen.getByText(
					/Your account's encryption identity can't be recovered/,
				),
			).toBeTruthy(),
		);
		expect(resetEncryption).not.toHaveBeenCalled();
	});

	it("moves focus to the password input on the UIA step", async () => {
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });
		expect(document.activeElement).toBe(overlay);

		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByLabelText("Password")),
		);
	});

	it("shows the curated fallback for raw platform exceptions", async () => {
		// A WebCrypto DOMException carries browser jargon — the user gets the
		// fallback, the console keeps the detail.
		resetEncryption.mockRejectedValue(
			new DOMException(
				"The operation failed for some reason",
				"OperationError",
			),
		);

		await runThroughPassword();
		await waitFor(() => expect(screen.getByText("Reset failed")).toBeTruthy());

		expect(screen.getByRole("alert").textContent).toBe(
			"Reset failed. Please try again.",
		);
	});

	it("ignores Escape and backdrop clicks while the reset is in flight", async () => {
		// A dismiss mid-reset would strand the SDK operation with no UI.
		const onClose = vi.fn();
		resetEncryption.mockReturnValue(new Promise(() => {}));

		await runThroughPassword(onClose);
		await waitFor(() =>
			expect(screen.getByText("Resetting encryption…")).toBeTruthy(),
		);
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });

		fireEvent.keyDown(overlay, { key: "Escape" });
		fireEvent.click(overlay);

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText("Resetting encryption…")).toBeTruthy();
	});

	it("ignores Escape and backdrop clicks while the new key is shown", async () => {
		// Dismissing before the user saves the key could lock them out.
		const onClose = vi.fn();
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

		await runThroughPassword(onClose);
		await waitFor(() =>
			expect(screen.getByText("Save your new recovery key")).toBeTruthy(),
		);
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });

		fireEvent.keyDown(overlay, { key: "Escape" });
		fireEvent.click(overlay);

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText("Save your new recovery key")).toBeTruthy();
	});
});
