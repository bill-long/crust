import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

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
			crossSigningStatus: () => undefined,
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
vi.mock("./verification/useVerification", () => ({
	useVerification: () => ({
		state: () => "idle",
		emoji: () => undefined,
		error: () => "",
		isSelfVerification: () => true,
		otherUserId: () => "",
		requestSelfVerification: async () => {},
		requestDeviceVerification: async () => {},
		acceptIncoming: () => {},
		confirmSas: async () => {},
		rejectSas: () => {},
		cancel: () => {},
		reset: () => {},
	}),
}));

import { triggerCryptoAction } from "../../stores/cryptoActions";
import { CryptoStatusBanner } from "./CryptoStatusBanner";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("CryptoStatusBanner action wiring", () => {
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
				{ timeout: 5000 },
			),
		).toBeTruthy();
	});
});
