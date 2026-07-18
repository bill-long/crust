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
import { createMockClient, createMockRoom } from "../../test/mockClient";

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
	useLocation: () => ({
		pathname: "/settings",
		search: "",
		hash: "",
		state: null,
	}),
	useParams: () => ({}),
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
					backupTrusted: () => true,
					secretStorageReady: () => true,
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
 * Code-splitting smoke tests (#307): the three overlay boundaries introduced
 * in src/app/Layout.tsx must resolve their dynamic imports and mount through
 * Suspense. Each lazy() declaration mirrors the production one so a dropped
 * boundary or renamed export fails here instead of at runtime.
 */
describe("lazy Layout overlay boundaries (#307)", () => {
	afterEach(cleanup);

	it("SettingsOverlay lazy chunk resolves and mounts", async () => {
		// Mirrors src/app/Layout.tsx.
		const SettingsOverlay = lazy(() =>
			import("./SettingsOverlay").then((m) => ({
				default: m.SettingsOverlay,
			})),
		);
		const client = createMockClient();
		render(() => (
			<ClientWrapper client={client}>
				<Suspense
					fallback={
						<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/60" />
					}
				>
					<SettingsOverlay
						activeTab="general"
						onTabChange={() => {}}
						onClose={() => {}}
						onLogout={() => {}}
					/>
				</Suspense>
			</ClientWrapper>
		));
		// Lazy chunk resolution under full-suite parallel load can exceed the
		// findBy default 1s timeout; allow headroom (still fails fast if the
		// import is actually broken).
		expect(
			await screen.findByRole("dialog", {}, { timeout: 5000 }),
		).toBeTruthy();
	});

	it("RoomSettingsOverlay lazy chunk resolves and mounts", async () => {
		// Mirrors src/app/Layout.tsx.
		const RoomSettingsOverlay = lazy(() =>
			import("../room/settings/RoomSettingsOverlay").then((m) => ({
				default: m.RoomSettingsOverlay,
			})),
		);
		const room = createMockRoom("!room:example.com", [], [], {
			name: "Test Room",
		});
		room.__setStateEvent("m.room.name", "", { name: "Test Room" });
		room.__setStateEvent("m.room.power_levels", "", {});
		const client = createMockClient(new Map([["!room:example.com", room]]));
		render(() => (
			<ClientWrapper client={client}>
				<Suspense
					fallback={
						<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/60" />
					}
				>
					<RoomSettingsOverlay
						client={client as unknown as MatrixClient}
						roomId="!room:example.com"
						isSpace={false}
						activeTab="general"
						onTabChange={() => {}}
						onClose={() => {}}
						onLeft={() => {}}
					/>
				</Suspense>
			</ClientWrapper>
		));
		expect(
			await screen.findByRole("dialog", {}, { timeout: 5000 }),
		).toBeTruthy();
	});
});
