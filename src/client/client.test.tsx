import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../stores/session";
import { requiredAt } from "../test/assertions";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Capture createClient's options while keeping the rest of the SDK real:
// the OIDC refresh wiring under test (createOidcTokenRefreshFn) runs for
// real, so the test proves the whole hop from session shape to SDK
// options, not a mock's shape.
const createClientMock = vi.hoisted(() => vi.fn());
vi.mock("matrix-js-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("matrix-js-sdk")>();
	return {
		...actual,
		createClient: (...args: unknown[]) => createClientMock(...args),
	};
});

// ClientProvider's crypto boot is out of scope here; resolve it instantly.
vi.mock("./cryptoRecovery", () => ({
	CRYPTO_INIT_TIMEOUT_MS: 1,
	CRYPTO_MODULE_LOAD_TIMEOUT_MS: 1,
	clearCryptoStores: vi.fn(),
	clearRecoveryStage: vi.fn(),
	initCryptoStore: vi.fn(),
	persistRecoveryStage: vi.fn(),
	readRecoveryStage: vi.fn(() => null),
	recoveryIdentity: vi.fn(() => "test-identity"),
	runCryptoInit: vi.fn(async () => "ready"),
}));

vi.mock("../features/crypto/useCryptoStatus", () => ({
	useCryptoStatus: () => ({
		crossSigningReady: () => true,
		thisDeviceVerified: () => true,
		backupVersion: () => "1",
		backupOnServer: () => false,
		backupTrusted: () => true,
		secretStorageReady: () => true,
		crossSigningStatus: () => undefined,
		refresh: async () => {},
	}),
}));

import { ClientProvider, useClient } from "./client";

const mockSdkClient = {
	on: vi.fn(),
	off: vi.fn(),
	removeListener: vi.fn(),
	startClient: vi.fn(),
	stopClient: vi.fn(),
	getHomeserverUrl: () => "https://matrix.example.com",
	// Presence (#445): the provider publishes the share-presence setting and
	// records our own presence, which no event ever delivers.
	getUserId: () => "@alice:example.com",
	setPresence: vi.fn(async () => {}),
	getPresence: vi.fn(async () => ({ presence: "online" })),
	setSyncPresence: vi.fn(),
	secretStorage: {
		getDefaultKeyId: vi.fn(async () => null),
		checkKey: vi.fn(async () => false),
	},
	http: {
		authedRequest: vi.fn(async () => null),
	},
};

const PASSWORD_SESSION: Session = {
	accessToken: "access-old",
	userId: "@alice:example.com",
	deviceId: "DEVICE42",
	homeserverUrl: "https://matrix.example.com",
};

const OIDC_SESSION: Session = {
	...PASSWORD_SESSION,
	refreshToken: "refresh-abc",
	oidc: {
		issuer: "https://auth.example.com/",
		clientId: "client-xyz",
	},
};

const SECRET_STORAGE_KEY_INFO: SecretStorageKeyDescription = {
	name: "Recovery key",
	algorithm: "m.secret_storage.v1.aes-hmac-sha2",
	iv: "iv==",
	mac: "mac==",
	passphrase: { algorithm: "m.pbkdf2", iterations: 1, salt: "salt" },
};

function setup(session: Session): void {
	createClientMock.mockReturnValue(mockSdkClient);
	render(() => (
		<ClientProvider session={session}>
			<div>provider-child</div>
		</ClientProvider>
	));
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	localStorage.clear();
});

describe("ClientProvider session wiring (#460)", () => {
	it("reports unusable secret-storage metadata as a validation failure", async () => {
		let clientContext: ReturnType<typeof useClient> | undefined;
		function ClientCapture() {
			clientContext = useClient();
			return <div>provider-child</div>;
		}

		createClientMock.mockReturnValue(mockSdkClient);
		render(() => (
			<ClientProvider session={PASSWORD_SESSION}>
				<ClientCapture />
			</ClientProvider>
		));
		await screen.findByText("provider-child");
		if (!clientContext) throw new Error("Client context was not captured");
		clientContext.setRecoveryKeyResolver(async (validate) => {
			if (!validate) throw new Error("Expected a recovery-key validator");
			await validate(new Uint8Array([1, 2, 3]));
			return null;
		});

		const opts = requiredAt(
			requiredAt(createClientMock.mock.calls, 0, "createClient call"),
			0,
			"createClient options",
		);
		const getSecretStorageKey = opts.cryptoCallbacks.getSecretStorageKey as (
			options: { keys: Record<string, SecretStorageKeyDescription> },
			name: string,
		) => Promise<[string, Uint8Array<ArrayBuffer>] | null>;

		await expect(
			getSecretStorageKey(
				{
					keys: {
						tombstoned: {},
					} as unknown as Record<string, SecretStorageKeyDescription>,
				},
				"m.cross_signing.master",
			),
		).rejects.toThrow(
			"Your recovery key information is missing or invalid. Try again later, or use another verified session to restore encryption.",
		);

		clientContext.setRecoveryKeyResolver(async () => new Uint8Array([1, 2, 3]));
		await expect(
			getSecretStorageKey(
				{ keys: { valid: SECRET_STORAGE_KEY_INFO } },
				"m.cross_signing.master",
			),
		).rejects.toThrow(
			"Couldn't verify your recovery key. Try again, or use another verified session to restore encryption.",
		);
	});

	it("passes refreshToken and a tokenRefreshFunction for an OIDC session", async () => {
		setup(OIDC_SESSION);

		await screen.findByText("provider-child");
		expect(createClientMock).toHaveBeenCalledTimes(1);
		const opts = requiredAt(
			requiredAt(createClientMock.mock.calls, 0, "createClient call"),
			0,
			"createClient options",
		);
		expect(opts).toMatchObject({
			baseUrl: "https://matrix.example.com",
			accessToken: "access-old",
			userId: "@alice:example.com",
			deviceId: "DEVICE42",
			refreshToken: "refresh-abc",
			// #485: getEventTimeline / TimelineWindow.load(eventId) throw
			// without this - every off-cache pinned message rendered
			// "(message unavailable)" and jump-to-event outside the window
			// failed. Locked here because the row tests mock the client and
			// can never catch the flag regressing.
			timelineSupport: true,
		});
		expect(opts.tokenRefreshFunction).toBeTypeOf("function");
	});

	it("advertises only the verification methods Crust can complete (#452)", () => {
		setup(PASSWORD_SESSION);

		const opts = requiredAt(
			requiredAt(createClientMock.mock.calls, 0, "createClient call"),
			0,
			"createClient options",
		);
		// Locked here because the SDK default also advertises
		// m.qr_code.scan.v1: with no camera capture path, letting the other
		// device show us a code it expects us to read strands the flow with
		// no way forward.
		expect(opts.verificationMethods).toEqual([
			"m.sas.v1",
			"m.qr_code.show.v1",
			"m.reciprocate.v1",
		]);
	});

	it("omits refresh options for a password session", async () => {
		setup(PASSWORD_SESSION);

		await screen.findByText("provider-child");
		const opts = requiredAt(
			requiredAt(createClientMock.mock.calls, 0, "createClient call"),
			0,
			"createClient options",
		);
		expect(opts).not.toHaveProperty("refreshToken");
		expect(opts).not.toHaveProperty("tokenRefreshFunction");
	});

	it("stops a client that was stopped while it was still starting (#551)", async () => {
		// The SDK's own shape, which is the whole reason the guard exists:
		// `startClient` flips `clientRunning` on before it awaits `/versions`
		// (client.js:586) and never re-checks it, and `stopClient` early-returns
		// on that same flag (client.js:668). So a stop that lands mid-start is
		// silently a no-op, and every later stop is too.
		let effectiveStops = 0;
		let finishStart!: () => void;
		const racyClient = {
			...mockSdkClient,
			clientRunning: false,
			startClient: vi.fn(() => {
				racyClient.clientRunning = true;
				return new Promise<void>((resolve) => {
					finishStart = resolve;
				});
			}),
			stopClient: vi.fn(() => {
				if (!racyClient.clientRunning) return;
				racyClient.clientRunning = false;
				effectiveStops += 1;
			}),
		};
		createClientMock.mockReturnValue(racyClient);
		render(() => (
			<ClientProvider session={PASSWORD_SESSION}>
				<div>provider-child</div>
			</ClientProvider>
		));
		await waitFor(() => expect(racyClient.startClient).toHaveBeenCalled());

		// The boot escape: stop the client while `/versions` is still pending.
		racyClient.stopClient();
		expect(effectiveStops).toBe(1);

		// `/versions` finally answers and `startClient` builds its sync API.
		finishStart();
		await waitFor(() => expect(effectiveStops).toBe(2));
	});

	it("puts clientRunning back even when the mid-start stop throws (#551)", async () => {
		// `stopClient` clears the flag itself, but only AFTER `cryptoBackend.stop()`
		// (client.js:696), which runs first and can throw. Left stuck on, the flag
		// makes `clearStores` throw synchronously for the life of the document -
		// so the account wipe this escape depends on would fail permanently.
		let finishStart!: () => void;
		let stopCalls = 0;
		const throwingClient = {
			...mockSdkClient,
			clientRunning: false,
			startClient: vi.fn(() => {
				throwingClient.clientRunning = true;
				return new Promise<void>((resolve) => {
					finishStart = resolve;
				});
			}),
			// Throws on the mid-start stop only; the unmount's stop has to work, or
			// the failure would be the harness's rather than the code's.
			stopClient: vi.fn(() => {
				stopCalls += 1;
				if (stopCalls === 1) throw new Error("cryptoBackend.stop() failed");
			}),
		};
		createClientMock.mockReturnValue(throwingClient);
		render(() => (
			<ClientProvider session={PASSWORD_SESSION}>
				<div>provider-child</div>
			</ClientProvider>
		));
		await waitFor(() => expect(throwingClient.startClient).toHaveBeenCalled());

		throwingClient.clientRunning = false; // the stop that landed mid-start
		finishStart();

		// Retried, not abandoned: the first attempt threw before it could reach
		// the sync API it had just built, and the flag is about to be cleared -
		// which would make every later stop early-return and leave that loop
		// running for the life of the document.
		await waitFor(() =>
			expect(throwingClient.stopClient).toHaveBeenCalledTimes(2),
		);
		expect(throwingClient.clientRunning).toBe(false);
	});

	it("still reports the session as logged out when the stop throws (#551)", async () => {
		// `setSyncState("logged-out")` is what `SyncGate`'s expired-session
		// cleanup keys on. If the stop can take it down, a revoked session is
		// never wiped, never cleared and never redirected away from.
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let throwOnStop = true;
		const revokedClient = {
			...mockSdkClient,
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(String(event), handler);
			}),
			startClient: vi.fn(async () => {}),
			stopClient: vi.fn(() => {
				if (throwOnStop) throw new Error("cryptoBackend.stop() failed");
			}),
		};
		createClientMock.mockReturnValue(revokedClient);
		render(() => (
			<ClientProvider session={PASSWORD_SESSION}>
				<div>provider-child</div>
			</ClientProvider>
		));
		await screen.findByText("provider-child");

		const onLoggedOut = handlers.get("Session.logged_out");
		expect(onLoggedOut).toBeTypeOf("function");
		// The SDK emits this from its own error handling, so a throw would land
		// back inside `HttpApi` rather than anywhere that could recover.
		expect(() => onLoggedOut?.()).not.toThrow();
		// Only the call under test throws; the unmount's stop must succeed, or the
		// failure would be the harness's rather than the code's.
		throwOnStop = false;
	});

	it("starts the client once crypto init resolves", async () => {
		setup(OIDC_SESSION);

		await waitFor(() =>
			expect(mockSdkClient.startClient).toHaveBeenCalledWith({
				initialSyncLimit: 20,
				threadSupport: true,
			}),
		);
	});
});

describe("presence wiring (#445)", () => {
	it("publishes presence on start, per the share-presence setting", async () => {
		setup(PASSWORD_SESSION);
		// The publish reads the current status first (a presence PUT that
		// omits status_msg clears it), so the write lands a tick later.
		await new Promise((r) => setTimeout(r, 0));

		// Defaults on, matching Element - and both halves are needed: the
		// state write, and the sync parameter that stops the next poll
		// asserting the opposite.
		expect(mockSdkClient.setPresence).toHaveBeenCalledWith({
			presence: "online",
			status_msg: "",
		});
		expect(mockSdkClient.setSyncPresence).toHaveBeenCalledWith("online");
	});
});
