import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type UiaCallback, uia401 } from "../../test/uiaFixtures";
import { CrossSigningSetup } from "./CrossSigningSetup";
import { UiaCancelledError } from "./uiaFlow";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const bootstrapCrossSigning = vi.fn();
const clearSecretStorageCache = vi.fn();
const refresh = vi.fn(async () => undefined);
// The UIA preflight probe (the empty signing-key upload), given the
// request's auth dict (if any).
const probe = vi.fn();

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {
			getUserId: () => "@test:example.com",
			getCrypto: () => ({ bootstrapCrossSigning }),
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
});

const PASSWORD_FLOW = [["m.login.password"]];
const OAUTH_FLOW = [["m.oauth"]];
const OAUTH_PARAMS = { "m.oauth": { url: "https://hs.example/account/reset" } };

/** Server that never challenges: probe 200s, upload succeeds unauthed. */
function mockBootstrapNoUia(): void {
	probe.mockResolvedValue({});
	bootstrapCrossSigning.mockImplementation(
		async (opts: { authUploadDeviceSigningKeys: UiaCallback }) => {
			await opts.authUploadDeviceSigningKeys(async () => {});
		},
	);
}

function mockBootstrapPasswordUia(): void {
	probe.mockImplementation(async (auth) => {
		if (!auth) throw uia401("probe-sess", PASSWORD_FLOW);
	});
	bootstrapCrossSigning.mockImplementation(
		async (opts: { authUploadDeviceSigningKeys: UiaCallback }) => {
			await opts.authUploadDeviceSigningKeys(async (authData) => {
				if (authData === null) {
					throw uia401("op-sess", PASSWORD_FLOW);
				}
			});
		},
	);
}

function mockBootstrapOauthUia(): void {
	probe.mockImplementation(async (auth) => {
		if (!auth) throw uia401("probe-sess", OAUTH_FLOW, OAUTH_PARAMS);
	});
	bootstrapCrossSigning.mockImplementation(
		async (opts: { authUploadDeviceSigningKeys: UiaCallback }) => {
			await opts.authUploadDeviceSigningKeys(async (authData) => {
				if (authData === null) {
					throw uia401("op-sess", OAUTH_FLOW, OAUTH_PARAMS);
				}
			});
		},
	);
}

function start(): void {
	render(() => <CrossSigningSetup onClose={() => {}} />);
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("CrossSigningSetup", () => {
	it("completes without any identity prompt when the server needs no auth", async () => {
		mockBootstrapNoUia();
		start();
		await waitFor(() =>
			expect(screen.getByText("Secure messaging is set up")).toBeTruthy(),
		);
		expect(screen.queryByLabelText("Password")).toBeNull();
		expect(refresh).toHaveBeenCalled();
	});

	it("collects the password up front on an m.login.password challenge", async () => {
		mockBootstrapPasswordUia();
		start();
		// The prompt comes from the preflight probe - the bootstrap hasn't
		// started yet.
		fireEvent.input(await screen.findByLabelText("Password"), {
			target: { value: "hunter2" },
		});
		expect(bootstrapCrossSigning).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		await waitFor(() =>
			expect(screen.getByText("Secure messaging is set up")).toBeTruthy(),
		);
	});

	it("routes an m.oauth challenge to the account-approval prompt", async () => {
		mockBootstrapOauthUia();
		start();
		await screen.findByText("Approve in your account settings");
		const link = screen.getByRole("link", { name: "Open account settings" });
		expect(link.getAttribute("href")).toBe("https://hs.example/account/reset");
		// The panel owns focus while it shows.
		await waitFor(() => expect(document.activeElement).toBe(link));

		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));
		await waitFor(() =>
			expect(screen.getByText("Secure messaging is set up")).toBeTruthy(),
		);
	});

	it("cancelling an identity prompt returns to the intro without starting", async () => {
		mockBootstrapOauthUia();
		start();
		await screen.findByText("Approve in your account settings");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() =>
			expect(
				screen.getByText(/Cross-signing lets you verify your devices/),
			).toBeTruthy(),
		);
		expect(screen.queryByText("Setup failed")).toBeNull();
		expect(bootstrapCrossSigning).not.toHaveBeenCalled();
		// The cancelled prompt unmounted what held focus - the overlay
		// reclaims it so Escape keeps working.
		const overlay = screen.getByRole("dialog", {
			name: "Set up secure messaging",
		});
		await waitFor(() => expect(document.activeElement).toBe(overlay));
	});

	it("unmounting mid-prompt aborts the flow without leaving a suspended op", async () => {
		// The bootstrap only starts after preflight; capture its promise via
		// a wrapper so the unmount-cancel can be observed settling it.
		probe.mockImplementation(async (auth) => {
			if (!auth) throw uia401("probe-sess", OAUTH_FLOW, OAUTH_PARAMS);
		});
		let bootstrapPromise: Promise<void> | undefined;
		bootstrapCrossSigning.mockImplementation(
			(opts: { authUploadDeviceSigningKeys: UiaCallback }) => {
				bootstrapPromise = opts.authUploadDeviceSigningKeys(
					async (authData) => {
						if (authData === null) {
							throw uia401("op-sess", OAUTH_FLOW, OAUTH_PARAMS);
						}
						// First submission refused - forces a mid-op re-prompt.
						throw uia401("op-sess", OAUTH_FLOW, OAUTH_PARAMS);
					},
				);
				return bootstrapPromise;
			},
		);

		start();
		await screen.findByText("Approve in your account settings");
		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"hasn't seen an approval yet",
			),
		);

		cleanup();
		await expect(bootstrapPromise).rejects.toBeInstanceOf(UiaCancelledError);
		// Even with the dialog gone, the stale 4S cache must be dropped.
		await vi.waitFor(() => expect(clearSecretStorageCache).toHaveBeenCalled());
	});

	it("unmounting during the preflight probe never starts the bootstrap", async () => {
		let resolveProbe: ((v: unknown) => void) | undefined;
		probe.mockReturnValue(
			new Promise((r) => {
				resolveProbe = r;
			}),
		);

		start();
		cleanup();
		resolveProbe?.({});
		await new Promise((r) => setTimeout(r, 0));
		expect(bootstrapCrossSigning).not.toHaveBeenCalled();
	});

	it("a mid-operation cancel surfaces as interrupted and drops the cached 4S key", async () => {
		// The refused-upload re-prompt comes after bootstrap has already
		// minted local keys (and may have cached secret-storage material) -
		// backing out is not a clean no-op and must say so.
		probe.mockImplementation(async (auth) => {
			if (!auth) throw uia401("probe-sess", OAUTH_FLOW, OAUTH_PARAMS);
		});
		bootstrapCrossSigning.mockImplementation(
			async (opts: { authUploadDeviceSigningKeys: UiaCallback }) => {
				await opts.authUploadDeviceSigningKeys(async () => {
					// Both the unauthenticated try and every submission refuse.
					throw uia401("op-sess", OAUTH_FLOW, OAUTH_PARAMS);
				});
			},
		);

		start();
		await screen.findByText("Approve in your account settings");
		fireEvent.click(screen.getByRole("button", { name: "I've approved it" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain(
				"hasn't seen an approval yet",
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() =>
			expect(screen.getByText(/Setup was interrupted/)).toBeTruthy(),
		);
		expect(clearSecretStorageCache).toHaveBeenCalled();
	});

	it("surfaces a bootstrap failure on the error step", async () => {
		mockBootstrapNoUia();
		bootstrapCrossSigning.mockRejectedValue(new Error("upload rejected"));
		start();
		await waitFor(() => expect(screen.getByText("Setup failed")).toBeTruthy());
		expect(screen.getByText("upload rejected")).toBeTruthy();
		expect(clearSecretStorageCache).toHaveBeenCalled();
	});

	it("shows the curated fallback for raw platform exceptions", async () => {
		mockBootstrapNoUia();
		bootstrapCrossSigning.mockRejectedValue(
			new DOMException(
				"The operation failed for some reason",
				"OperationError",
			),
		);
		start();
		await waitFor(() => expect(screen.getByText("Setup failed")).toBeTruthy());
		expect(screen.getByText("Setup failed. Please try again.")).toBeTruthy();
	});
});
