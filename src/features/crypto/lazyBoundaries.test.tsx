import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, lazy, type ParentComponent, Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../client/summaries";
import { createMockClient } from "../../test/mockClient";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useLocation: () => ({ pathname: "/", search: "", hash: "", state: null }),
	useParams: () => ({}),
}));

// Config context stand-in: LoginPage reads useConfig() for the default
// homeserver. Mock the module so the smoke test needs no fetch of config.json.
vi.mock("../../app/ConfigProvider", () => ({
	useConfig: () => ({ defaultHomeserver: "https://matrix.example.com" }),
}));

const optimisticallyMarkJoined = vi.fn();

/** Minimal ClientContext provider, mirroring CreateRoomDialog.test.tsx. */
const ClientWrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const { summaries } = createSummariesStore(
		props.client as unknown as MatrixClient,
	);
	return (
		<ClientContext.Provider
			value={{
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: summaries as unknown as SummariesStore,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => "1",
					backupOnServer: () => false,
					backupTrusted: () => true,
					secretStorageReady: () => true,
					crossSigningStatus: () => undefined,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
				optimisticallyMarkJoined,
				optimisticallyMarkLeft: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

/**
 * Code-splitting smoke tests (#307) for the boundaries owned by this feature
 * area: the /login route (App.tsx) and the four crypto dialogs
 * (CryptoStatusBanner.tsx). The Layout settings overlays are covered in
 * src/features/settings/lazyOverlayBoundaries.test.tsx and FullCallOverlay
 * in src/features/room/call/rtc/FullCallOverlay.lazy.test.tsx.
 *
 * Each test re-declares its production lazy() boundary and asserts it (a)
 * resolves its dynamic import to the named export the
 * .then((m) => ({ default: m.X })) mapping references, and (b) mounts
 * through a Suspense boundary. These guard against a future refactor
 * dropping a boundary or renaming an export, both of which otherwise fail
 * only at runtime when the chunk resolves.
 *
 * Each lazy() declaration mirrors the one in the production file. That is
 * deliberate: the test re-creates the boundary exactly as production uses
 * it, so a broken export mapping or missing module surfaces here.
 */
describe("lazy /login route boundary (#307)", () => {
	afterEach(cleanup);

	it("LoginPage lazy chunk resolves and renders the login form", async () => {
		// Mirrors src/app/App.tsx.
		const LoginPage = lazy(() =>
			import("../auth/LoginPage").then((m) => ({ default: m.LoginPage })),
		);
		render(() => (
			<Suspense fallback={<div class="h-full bg-surface-0" />}>
				<LoginPage />
			</Suspense>
		));
		// The login form's homeserver input is the stable, user-visible marker
		// that the chunk resolved and the component mounted through Suspense.
		expect(
			await screen.findByLabelText(/homeserver/i, {}, { timeout: 5000 }),
		).toBeTruthy();
	});
});

describe("lazy crypto dialog boundaries (#307)", () => {
	afterEach(cleanup);

	const client = createMockClient();

	it("CrossSigningSetup lazy chunk resolves and mounts", async () => {
		// Mirrors src/features/crypto/CryptoStatusBanner.tsx.
		const CrossSigningSetup = lazy(() =>
			import("./CrossSigningSetup").then((m) => ({
				default: m.CrossSigningSetup,
			})),
		);
		render(() => (
			<ClientWrapper client={client}>
				<Suspense fallback={<div data-testid="fallback" />}>
					<CrossSigningSetup onClose={() => {}} />
				</Suspense>
			</ClientWrapper>
		));
		// The dialog's heading is its user-visible marker. Scoped to a heading
		// role: the backdrop div's aria-label carries the same string, so a
		// plain text query would be ambiguous.
		expect(
			await screen.findByRole(
				"heading",
				{ name: "Set up secure messaging" },
				{ timeout: 5000 },
			),
		).toBeTruthy();
	});

	it("BackupSetupDialog lazy chunk resolves and mounts", async () => {
		// Mirrors src/features/crypto/CryptoStatusBanner.tsx.
		const BackupSetupDialog = lazy(() =>
			import("./backup/BackupSetupDialog").then((m) => ({
				default: m.BackupSetupDialog,
			})),
		);
		render(() => (
			<ClientWrapper client={client}>
				<Suspense fallback={<div data-testid="fallback" />}>
					<BackupSetupDialog onClose={() => {}} />
				</Suspense>
			</ClientWrapper>
		));
		// First step of the backup setup wizard.
		expect(
			await screen.findByText("Continue", {}, { timeout: 5000 }),
		).toBeTruthy();
	});

	it("VerificationDialog lazy chunk resolves and mounts", async () => {
		// Mirrors src/features/crypto/CryptoStatusBanner.tsx.
		const VerificationDialog = lazy(() =>
			import("./verification/VerificationDialog").then((m) => ({
				default: m.VerificationDialog,
			})),
		);
		// Minimal VerificationHandle stub in the "requested" state — enough for
		// the dialog to render its waiting view through the lazy boundary.
		const verificationStub = {
			state: () => "requested",
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
		};
		render(() => (
			<Suspense fallback={<div data-testid="fallback" />}>
				<VerificationDialog
					verification={
						verificationStub as unknown as import("./verification/useVerification").VerificationHandle
					}
					onClose={() => {}}
				/>
			</Suspense>
		));
		expect(
			await screen.findByText(
				"Waiting for the other device",
				{},
				{ timeout: 5000 },
			),
		).toBeTruthy();
	});

	it("RecoveryKeyResetDialog lazy chunk resolves and mounts", async () => {
		// Mirrors src/features/crypto/CryptoStatusBanner.tsx.
		const RecoveryKeyResetDialog = lazy(() =>
			import("./backup/RecoveryKeyResetDialog").then((m) => ({
				default: m.RecoveryKeyResetDialog,
			})),
		);
		render(() => (
			<ClientWrapper client={client}>
				<Suspense fallback={<div data-testid="fallback" />}>
					<RecoveryKeyResetDialog onClose={() => {}} />
				</Suspense>
			</ClientWrapper>
		));
		// The dialog's role + accessible name are its stable markers.
		expect(
			await screen.findByRole("dialog", {}, { timeout: 5000 }),
		).toBeTruthy();
	});
});
