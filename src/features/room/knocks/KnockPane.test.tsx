import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../../client/client";
import { ClientContext } from "../../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../../client/summaries";
import { createMockClient } from "../../../test/mockClient";
import { TEST_SESSION } from "../../../test/testSession";
import { KnockPane } from "./KnockPane";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const optimisticallyMarkLeft = vi.fn();

const Wrapper: ParentComponent<{
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
				session: TEST_SESSION,
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: summaries as unknown as SummariesStore,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => null,
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
				optimisticallyMarkLeft,
				optimisticallySetMarkedUnread: vi.fn(),
				optimisticallySetRoomTag: vi.fn(),
				optimisticallySetSpaceOrder: vi.fn(),
				forgetRoomLocally: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

afterEach(() => {
	cleanup();
	optimisticallyMarkLeft.mockReset();
});

function setup(leaveImpl?: () => Promise<unknown>) {
	const client = createMockClient();
	if (leaveImpl) {
		(client as unknown as Record<string, unknown>).leave = vi.fn(leaveImpl);
	} else {
		(client as unknown as Record<string, unknown>).leave = vi
			.fn()
			.mockResolvedValue({});
	}
	const onBack = vi.fn();
	const onCancelled = vi.fn();
	render(() => (
		<Wrapper client={client}>
			<KnockPane
				rid="!knocked:example.com"
				roomName="Restricted Club"
				onBack={onBack}
				onCancelled={onCancelled}
			/>
		</Wrapper>
	));
	return {
		client: client as unknown as MatrixClient & {
			leave: ReturnType<typeof vi.fn>;
		},
		onBack,
		onCancelled,
	};
}

describe("KnockPane", () => {
	it("shows the pending-request status", () => {
		setup();
		// Header + card both carry the room name.
		expect(screen.getAllByText("Restricted Club")).toHaveLength(2);
		expect(
			screen.getByText(
				"Your request to join is waiting for a moderator to approve it.",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /^Cancel request$/i }),
		).toBeTruthy();
	});

	it("cancels the request: leaves, navigates, then marks left (in that order)", async () => {
		const { client, onCancelled } = setup();
		fireEvent.click(screen.getByRole("button", { name: /^Cancel request$/i }));

		await waitFor(() => expect(onCancelled).toHaveBeenCalledOnce());
		expect(client.leave).toHaveBeenCalledWith("!knocked:example.com");
		expect(optimisticallyMarkLeft).toHaveBeenCalledWith("!knocked:example.com");
		// Ordering matters: the store flip must come AFTER the navigation so
		// Layout doesn't transiently mount RoomPane for the just-left room
		// (same ordering useInviteActions.decline documents).
		expect(onCancelled.mock.invocationCallOrder[0]).toBeLessThan(
			optimisticallyMarkLeft.mock.invocationCallOrder[0],
		);
	});

	it("shows an inline error and stays put when the leave fails", async () => {
		const { onCancelled } = setup(() =>
			Promise.reject(new Error("M_UNKNOWN: boom")),
		);
		fireEvent.click(screen.getByRole("button", { name: /^Cancel request$/i }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("boom"),
		);
		expect(onCancelled).not.toHaveBeenCalled();
		expect(optimisticallyMarkLeft).not.toHaveBeenCalled();
		// The button is re-enabled for a retry.
		expect(
			(
				screen.getByRole("button", {
					name: /^Cancel request$/i,
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("uses the curated fallback for platform-jargon cancel failures", async () => {
		const { onCancelled } = setup(() =>
			Promise.reject(new TypeError("Failed to fetch")),
		);
		fireEvent.click(screen.getByRole("button", { name: /^Cancel request$/i }));

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Couldn't cancel the join request. Please try again.",
			),
		);
		expect(onCancelled).not.toHaveBeenCalled();
	});
});
