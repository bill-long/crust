import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerificationHandle } from "./verification/useVerification";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// Per-test overrides for the crypto status snapshot the banner reads.
let crossSigningStatus: unknown;

vi.mock("../../client/client", () => ({
	useClient: () => ({
		client: {},
		cryptoStatus: {
			crossSigningReady: () => true,
			thisDeviceVerified: () => true,
			backupVersion: () => "1",
			backupOnServer: () => true,
			backupTrusted: () => true,
			secretStorageReady: () => true,
			crossSigningStatus: () => crossSigningStatus,
			refresh: async () => {},
		},
		setRecoveryKeyResolver: () => {},
		clearSecretStorageCache: () => {},
	}),
}));

// Keep the banner focused on its own wiring; these children have their
// own suites.
vi.mock("./backup/RecoveryKeyInput", () => ({
	RecoveryKeyInput: () => null,
}));
vi.mock("./verification/IncomingVerificationToast", () => ({
	IncomingVerificationToast: () => null,
}));
const requestSelfVerification = vi.fn(async () => {});
const requestDeviceVerification = vi.fn(async (_deviceId: string) => {});
// Annotated with the real handle type: the factory is otherwise structurally
// unchecked, so a new member on VerificationHandle would go missing here and
// only surface as "undefined is not a function" the first time a test drove
// the banner past the idle state.
vi.mock("./verification/useVerification", () => ({
	useVerification: (): VerificationHandle => ({
		state: () => "idle",
		emoji: () => undefined,
		qrBytes: () => undefined,
		error: () => "",
		isSelfVerification: () => true,
		otherUserId: () => "",
		requestSelfVerification: (...a: []) => requestSelfVerification(...a),
		requestDeviceVerification: (id: string) => requestDeviceVerification(id),
		acceptIncoming: () => {},
		startSas: async () => {},
		confirmSas: async () => {},
		rejectSas: () => {},
		confirmQr: () => {},
		rejectQr: () => {},
		cancel: () => {},
		reset: () => {},
	}),
}));

import { triggerCryptoAction } from "../../stores/cryptoActions";
import { CryptoStatusBanner } from "./CryptoStatusBanner";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	crossSigningStatus = undefined;
});

describe("CryptoStatusBanner action wiring", () => {
	// 20s timeout: the lazy dialog chunk pulls in matrix-js-sdk, whose
	// transform under vitest (inlined, see vite.config.ts) can exceed the
	// 5s default when the full suite runs under load.
	it("routes reset-encryption to the ResetEncryptionDialog", async () => {
		// DevicesTab/UserBar trigger this action when the server identity is
		// unreachable; the banner must map it to the reset dialog (the lazy
		// boundary is asserted separately in lazyBoundaries.test.tsx).
		render(() => <CryptoStatusBanner />);

		triggerCryptoAction("reset-encryption");

		expect(
			await screen.findByRole(
				"heading",
				{ name: "Reset encryption" },
				{ timeout: 15000 },
			),
		).toBeTruthy();
	}, 20000);

	it("starts verification of the named device for a verify-device request", async () => {
		render(() => <CryptoStatusBanner />);

		triggerCryptoAction({ action: "verify-device", deviceId: "OTHERDEV" });

		expect(requestDeviceVerification).toHaveBeenCalledWith("OTHERDEV");
		expect(requestSelfVerification).not.toHaveBeenCalled();
		expect(
			await screen.findByRole(
				"dialog",
				{ name: "Device verification" },
				{ timeout: 15000 },
			),
		).toBeTruthy();
	}, 20000);

	it("opens verify-session on the choice when the recovery key can verify", async () => {
		// Keys in secret storage: the dialog must open idle (on the choice),
		// not jump straight into the SAS wait.
		crossSigningStatus = {
			publicKeysOnDevice: true,
			privateKeysInSecretStorage: true,
			privateKeysCachedLocally: {
				masterKey: false,
				selfSigningKey: false,
				userSigningKey: false,
			},
		};
		render(() => <CryptoStatusBanner />);

		triggerCryptoAction("verify-session");

		expect(requestSelfVerification).not.toHaveBeenCalled();
		expect(
			await screen.findByRole(
				"button",
				{ name: "Use recovery key" },
				{ timeout: 15000 },
			),
		).toBeTruthy();
	}, 20000);

	it("starts the SAS request straight away for verify-session without keys in 4S", async () => {
		crossSigningStatus = {
			publicKeysOnDevice: true,
			privateKeysInSecretStorage: false,
			privateKeysCachedLocally: {
				masterKey: true,
				selfSigningKey: true,
				userSigningKey: true,
			},
		};
		render(() => <CryptoStatusBanner />);

		triggerCryptoAction("verify-session");

		expect(requestSelfVerification).toHaveBeenCalledTimes(1);
		expect(
			await screen.findByRole(
				"dialog",
				{ name: "Device verification" },
				{ timeout: 15000 },
			),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Use recovery key" }),
		).toBeNull();
	}, 20000);
});
