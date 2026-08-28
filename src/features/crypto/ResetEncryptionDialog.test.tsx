import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type UiaCallback, uia401 } from "../../test/uiaFixtures";
import { ResetEncryptionDialog } from "./ResetEncryptionDialog";
import { UiaCancelledError } from "./uiaFlow";

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
// The UIA preflight probe (the empty signing-key upload), given the
// request's auth dict (if any).
const probe = vi.fn();

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
	probe.mockResolvedValue({});
}
resetClientState();

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => clientState.userId,
			getCrypto: () => clientState.crypto,
			getAuthMetadata: async () => {
				throw new Error("no oauth metadata");
			},
			http: {
				authedRequest: (
					_method: unknown,
					_path: unknown,
					_qs: unknown,
					body?: { auth?: unknown },
				) => probe(body?.auth),
			},
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

const PASSWORD_FLOW = [["m.login.password"]];
const OAUTH_FLOW = [["m.oauth"]];
const OAUTH_PARAMS = { "m.oauth": { url: "https://hs.example/account/reset" } };

/**
 * Server challenges with `m.login.password`: the preflight probe 401s, and
 * `resetEncryption` runs its UIA callback against a server that accepts
 * any password, then optionally fails the reset itself with `failWith`.
 */
function mockResetPasswordUia(failWith?: Error): void {
	probe.mockImplementation(async (auth) => {
		if (!auth) throw uia401("probe-sess", PASSWORD_FLOW);
	});
	resetEncryption.mockImplementation(async (cb: UiaCallback) => {
		await cb(async (authData) => {
			if (authData === null) {
				throw uia401("op-sess", PASSWORD_FLOW);
			}
			// Password accepted.
		});
		if (failWith) throw failWith;
	});
}

/**
 * Server challenges with the `m.oauth` stage: the first `refusals` auth
 * submissions are refused (approval not granted at the OP yet), then the
 * stage passes.
 */
function mockResetOauthUia(refusals = 0): void {
	probe.mockImplementation(async (auth) => {
		if (!auth) throw uia401("probe-sess", OAUTH_FLOW, OAUTH_PARAMS);
	});
	let refused = 0;
	resetEncryption.mockImplementation(async (cb: UiaCallback) => {
		await cb(async (authData) => {
			if (authData === null) {
				throw uia401("op-sess", OAUTH_FLOW, OAUTH_PARAMS);
			}
			if (refused < refusals) {
				refused += 1;
				throw uia401("op-sess", OAUTH_FLOW, OAUTH_PARAMS);
			}
			// Approval ticket consumed.
		});
	});
}

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
		mockResetPasswordUia();
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
		mockResetPasswordUia();
		ensureKeyBackup.mockResolvedValue({ outcome: "reused" });

		await runThroughPassword();
		await waitFor(() =>
			expect(screen.getByText("Encryption was reset")).toBeTruthy(),
		);
	});

	it("warns of an incomplete setup when the backup reports needs-restore", async () => {
		// Non-exception partial path: a key was minted but the new backup
		// still needs a restore before it fully protects history.
		mockResetPasswordUia();
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
		mockResetPasswordUia(new Error("UIA failed"));

		await runThroughPassword();
		await waitFor(() => expect(screen.getByText("Reset failed")).toBeTruthy());

		expect(screen.getByRole("alert").textContent).toContain("UIA failed");
		expect(clearSecretStorageCache).toHaveBeenCalled();
	});

	it("shows the minted key with an incomplete warning when post-reset setup fails", async () => {
		mockResetPasswordUia();
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

		await waitFor(() => expect(screen.getByText("Reset failed")).toBeTruthy());
		expect(screen.getByRole("alert").textContent).toContain(
			"Unable to determine user ID.",
		);
		expect(resetEncryption).not.toHaveBeenCalled();
	});

	it("cancelling the password prompt backs out before anything runs", async () => {
		mockResetPasswordUia();
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
		// The prompt is a preflight: nothing destructive ran, so backing out
		// must not have started the reset (or cleared anything).
		expect(resetEncryption).not.toHaveBeenCalled();
		expect(clearSecretStorageCache).not.toHaveBeenCalled();
	});

	it("moves focus to the password input when the server asks for one", async () => {
		mockResetPasswordUia();
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });
		expect(document.activeElement).toBe(overlay);

		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByLabelText("Password")),
		);
	});

	it("focuses the approval deeplink while the oauth prompt shows, the overlay after", async () => {
		mockResetOauthUia();
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));

		await screen.findByText("Approve in your account settings");
		const link = screen.getByRole("link", { name: "Open account settings" });
		// The panel owns focus; the overlay must not steal it back.
		await waitFor(() => expect(document.activeElement).toBe(link));

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });
		await waitFor(() => expect(document.activeElement).toBe(overlay));
	});

	it("routes an m.oauth challenge to the account-approval prompt before the reset", async () => {
		mockResetOauthUia();
		ensureKeyBackup.mockImplementation(
			async (
				_crypto: unknown,
				createKey: () => Promise<unknown>,
			): Promise<{ outcome: string }> => {
				await createKey();
				return { outcome: "reused" };
			},
		);

		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));

		await screen.findByText("Approve in your account settings");
		// Nothing destructive may run while the approval prompt is up.
		expect(resetEncryption).not.toHaveBeenCalled();
		const link = screen.getByRole("link", { name: "Open account settings" });
		expect(link.getAttribute("href")).toBe("https://hs.example/account/reset");

		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));
		await waitFor(() =>
			expect(screen.getByText("Save your new recovery key")).toBeTruthy(),
		);
	});

	it("re-prompts with a notice while the approval hasn't been granted", async () => {
		mockResetOauthUia(1);
		ensureKeyBackup.mockResolvedValue({ outcome: "reused" });

		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));

		await screen.findByText("Approve in your account settings");
		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"hasn't seen an approval yet",
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));
		await waitFor(() =>
			expect(screen.getByText("Encryption was reset")).toBeTruthy(),
		);
	});

	it("surfaces a mid-operation cancel as an interrupted reset, not a silent step back", async () => {
		// Once the reset is running, its teardown has already happened - a
		// cancel in the refusal loop must not pretend nothing did.
		mockResetOauthUia(Number.POSITIVE_INFINITY);

		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		await screen.findByText("Approve in your account settings");
		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));

		// The refused submission re-prompts mid-operation; cancel there.
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"hasn't seen an approval yet",
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(screen.getByText("Reset failed")).toBeTruthy());
		expect(screen.getByRole("alert").textContent).toContain("interrupted");
		expect(clearSecretStorageCache).toHaveBeenCalled();
	});

	it("unmounting during the preflight probe never starts the reset", async () => {
		// On a no-auth server the probe resolves with no prompt to cancel;
		// the disposed guard is what keeps the destructive reset from
		// running headless after the dialog is externally removed.
		let resolveProbe: ((v: unknown) => void) | undefined;
		probe.mockReturnValue(
			new Promise((r) => {
				resolveProbe = r;
			}),
		);

		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		cleanup();
		resolveProbe?.({});
		// Give the resolved preflight a macrotask to (wrongly) continue.
		await new Promise((r) => setTimeout(r, 0));
		expect(resetEncryption).not.toHaveBeenCalled();
	});

	it("unmounting mid-operation aborts the suspended reset", async () => {
		// The dialog's onCleanup cancels the flow so the SDK operation is
		// not left suspended forever on a prompt nothing will answer.
		mockResetOauthUia(Number.POSITIVE_INFINITY);
		let resetPromise: Promise<void> | undefined;
		const impl = resetEncryption.getMockImplementation() as (
			cb: UiaCallback,
		) => Promise<void>;
		resetEncryption.mockImplementation((cb: UiaCallback) => {
			resetPromise = impl(cb);
			return resetPromise;
		});

		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		await screen.findByText("Approve in your account settings");
		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"hasn't seen an approval yet",
			),
		);

		cleanup();
		await expect(resetPromise).rejects.toBeInstanceOf(UiaCancelledError);
		// Even with the dialog gone, the stale 4S cache must be dropped.
		await vi.waitFor(() => expect(clearSecretStorageCache).toHaveBeenCalled());
	});

	it("shows the curated fallback for raw platform exceptions", async () => {
		// A WebCrypto DOMException carries browser jargon — the user gets the
		// fallback, the console keeps the detail.
		mockResetPasswordUia(
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

	it("reclaims focus for the overlay across promptless step transitions", async () => {
		// No-UIA path: the intro button unmounts on click with no prompt
		// ever showing; focus falls to the body and Escape would die with
		// it unless the overlay reclaims it (review round 3 on #543).
		resetEncryption.mockReturnValue(new Promise(() => {}));

		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		const button = screen.getByRole("button", { name: "Reset encryption" });
		button.focus();
		fireEvent.click(button);
		await waitFor(() =>
			expect(screen.getByText("Resetting encryption…")).toBeTruthy(),
		);

		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });
		await waitFor(() => expect(document.activeElement).toBe(overlay));
	});

	it("keeps Tab cycling inside the dialog", async () => {
		render(() => <ResetEncryptionDialog onClose={() => {}} />);
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });
		// jsdom has no layout engine, so offsetParent is always null and
		// trapTabKey's visibility filter would drop every candidate. Force
		// the dialog's focusable elements visible (same trick as
		// JoinRoomDialog.test.tsx / focusTrap.test.ts).
		for (const el of overlay.querySelectorAll("button")) {
			Object.defineProperty(el, "offsetParent", {
				configurable: true,
				get: () => document.body,
			});
		}

		// Intro order: Cancel -> Reset encryption. Tab on the last wraps to
		// the first; Shift+Tab on the first wraps back.
		const resetButton = screen.getByRole("button", {
			name: "Reset encryption",
		});
		const cancelButton = screen.getByRole("button", { name: "Cancel" });
		resetButton.focus();
		fireEvent.keyDown(overlay, { key: "Tab" });
		expect(document.activeElement).toBe(cancelButton);
		fireEvent.keyDown(overlay, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(resetButton);
	});

	it("lets Escape close the dialog while the preflight probe hangs", async () => {
		// Nothing destructive has run during preflight, so a stalled network
		// must not trap the user in an undismissable modal.
		const onClose = vi.fn();
		probe.mockReturnValue(new Promise(() => {}));

		render(() => <ResetEncryptionDialog onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		await waitFor(() =>
			expect(screen.getByText("Resetting encryption…")).toBeTruthy(),
		);
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });
		fireEvent.keyDown(overlay, { key: "Escape" });

		expect(onClose).toHaveBeenCalled();
		expect(resetEncryption).not.toHaveBeenCalled();
	});

	it("ignores Escape and backdrop clicks while the reset is in flight", async () => {
		// A dismiss mid-reset would strand the SDK operation with no UI.
		const onClose = vi.fn();
		resetEncryption.mockReturnValue(new Promise(() => {}));

		render(() => <ResetEncryptionDialog onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
		// The spinner also covers the (dismissable) preflight window - wait
		// until the destructive operation itself is in flight.
		await waitFor(() => expect(resetEncryption).toHaveBeenCalled());
		const overlay = screen.getByRole("dialog", { name: "Reset encryption" });

		fireEvent.keyDown(overlay, { key: "Escape" });
		fireEvent.click(overlay);

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText("Resetting encryption…")).toBeTruthy();
	});

	it("ignores Escape and backdrop clicks while the new key is shown", async () => {
		// Dismissing before the user saves the key could lock them out.
		const onClose = vi.fn();
		mockResetPasswordUia();
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
