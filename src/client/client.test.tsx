import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../stores/session";

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

import { ClientProvider } from "./client";

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
	setSyncPresence: vi.fn(),
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
	it("passes refreshToken and a tokenRefreshFunction for an OIDC session", async () => {
		setup(OIDC_SESSION);

		await screen.findByText("provider-child");
		expect(createClientMock).toHaveBeenCalledTimes(1);
		const opts = createClientMock.mock.calls[0][0];
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

		const opts = createClientMock.mock.calls[0][0];
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

	it("leaves refresh options undefined for a password session", async () => {
		setup(PASSWORD_SESSION);

		await screen.findByText("provider-child");
		const opts = createClientMock.mock.calls[0][0];
		expect(opts.refreshToken).toBeUndefined();
		expect(opts.tokenRefreshFunction).toBeUndefined();
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
	it("publishes presence on start, per the share-presence setting", () => {
		setup(PASSWORD_SESSION);

		// Defaults on, matching Element - and both halves are needed: the
		// state write, and the sync parameter that stops the next poll
		// asserting the opposite.
		expect(mockSdkClient.setPresence).toHaveBeenCalledWith({
			presence: "online",
		});
		expect(mockSdkClient.setSyncPresence).toHaveBeenCalledWith("online");
	});
});
