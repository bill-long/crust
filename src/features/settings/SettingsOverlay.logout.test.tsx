import { cleanup, render, screen } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../client/summaries";
import { createMockClient } from "../../test/mockClient";
import { SettingsOverlay } from "./SettingsOverlay";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

vi.mock("@solidjs/router", () => ({
	useNavigate: () => vi.fn(),
	useLocation: () => ({
		pathname: "/settings",
		search: "",
		hash: "",
		state: null,
	}),
	useParams: () => ({}),
}));

/** Minimal ClientContext provider, mirroring lazyOverlayBoundaries.test.tsx. */
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
				optimisticallyMarkJoined: vi.fn(),
				optimisticallyMarkKnocked: vi.fn(),
				optimisticallyMarkLeft: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

afterEach(cleanup);

function logoutButton(): HTMLButtonElement {
	return screen.getByRole("button", {
		name: /log ?out|logging out/i,
	}) as HTMLButtonElement;
}

function renderOverlay(opts: {
	onLogout: () => void;
	loggingOut?: () => boolean;
}) {
	const client = createMockClient(new Map());
	// AccountTab (the rendered tab) reads the local user's profile; the shared
	// mock client doesn't implement getUser.
	(client as unknown as { getUser: () => unknown }).getUser = () => ({
		userId: "@me:example.com",
		displayName: "Me",
		avatarUrl: null,
	});
	render(() => (
		<ClientWrapper client={client}>
			<SettingsOverlay
				activeTab="account"
				onTabChange={() => {}}
				onClose={() => {}}
				onLogout={opts.onLogout}
				loggingOut={opts.loggingOut}
			/>
		</ClientWrapper>
	));
}

describe("SettingsOverlay logout button", () => {
	it("is enabled and fires onLogout when idle", () => {
		const onLogout = vi.fn();
		renderOverlay({ onLogout });

		const btn = logoutButton();
		expect(btn.disabled).toBe(false);
		btn.click();
		expect(onLogout).toHaveBeenCalledTimes(1);
	});

	it("shows a pending state while the logout is in flight", () => {
		// Logout awaits the call teardown (#474), so it is no longer instant
		// and must not look idle while it runs.
		const [loggingOut, setLoggingOut] = createSignal(false);
		const onLogout = vi.fn();
		renderOverlay({ onLogout, loggingOut });

		expect(logoutButton().getAttribute("aria-disabled")).toBe("false");

		setLoggingOut(true);
		const btn = logoutButton();
		expect(btn.getAttribute("aria-disabled")).toBe("true");
		expect(btn.textContent).toContain("Logging out");
	});

	it("is inert while pending, as its aria-disabled advertises", () => {
		// The button stays focusable (see below), so it has to honour the
		// disabled state itself rather than rely on the caller's guard.
		const [loggingOut] = createSignal(true);
		const onLogout = vi.fn();
		renderOverlay({ onLogout, loggingOut });

		logoutButton().click();
		expect(onLogout).not.toHaveBeenCalled();
	});

	it("stays focusable while pending so the modal keeps its focus trap", () => {
		// Using `disabled` here would blur the just-clicked button onto
		// <body>, dropping focus out of the overlay's trap and past its
		// delegated keydown handler — Escape would stop closing the modal for
		// the whole logout. Re-entry is prevented at the source instead.
		const [loggingOut] = createSignal(true);
		renderOverlay({ onLogout: vi.fn(), loggingOut });

		const btn = logoutButton();
		expect(btn.disabled).toBe(false);
		btn.focus();
		expect(document.activeElement).toBe(btn);
	});
});
