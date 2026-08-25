import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@solidjs/testing-library";
import { type MatrixClient, RoomMemberEvent } from "matrix-js-sdk";
import { createSignal, type JSX, type ParentComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../client/summaries";
import {
	_resetIgnoredUsersForTests,
	initIgnoredUsers,
} from "../../stores/ignoredUsers";
import { createMockClient, createMockRoom } from "../../test/mockClient";
import { MemberList } from "./MemberList";

// virtua's Virtualizer requires real layout measurements (ResizeObserver +
// non-zero element sizes) that jsdom doesn't provide. Substitute the same
// transparent renderer the MembersTab tests use so every row mounts.
vi.mock("virtua/solid", async () => {
	const solid = await import("solid-js");
	return {
		Virtualizer: <T,>(props: {
			data: T[];
			children: (item: T, index: number) => unknown;
		}) =>
			solid.createComponent(solid.For, {
				get each() {
					return props.data;
				},
				children: (item: T) => props.children(item, 0) as JSX.Element,
			}),
	};
});

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

vi.mock("@solidjs/router", () => ({
	useNavigate: () => vi.fn(),
}));

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const store = createSummariesStore(props.client as unknown as MatrixClient);
	return (
		<ClientContext.Provider
			value={{
				client: props.client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries: store.summaries as unknown as SummariesStore,
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
				optimisticallyMarkLeft: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function setup() {
	const room = createMockRoom(
		"!room:example.com",
		[],
		[
			{ userId: "@test:example.com", name: "Me", powerLevel: 0 },
			{
				userId: "@alice:example.com",
				name: "Alice",
				powerLevel: 0,
				avatarUrl: "mxc://example.com/broken",
			},
		],
	);
	const client = createMockClient(new Map([["!room:example.com", room]]));
	client.getIgnoredUsers.mockReturnValue([]);
	initIgnoredUsers(client as never);
	render(() => (
		<Wrapper client={client}>
			<MemberList roomId="!room:example.com" />
		</Wrapper>
	));
	return { client, room };
}

function aliceRow(): HTMLElement {
	return screen.getByLabelText("View profile of Alice");
}

afterEach(() => {
	cleanup();
	_resetIgnoredUsersForTests();
});

beforeEach(() => {
	// Kobalte's scroll-prevention cleanup calls window.scrollTo, which
	// jsdom doesn't implement; stub it to keep the test output clean.
	window.scrollTo = vi.fn();
});

describe("MemberList avatar fallback (#457)", () => {
	it("falls back to the member initial when the avatar image errors", async () => {
		setup();
		await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
		expect(document.querySelector("img")).not.toBeNull();

		fireEvent.error(document.querySelector("img") as HTMLImageElement);

		expect(document.querySelector("img")).toBeNull();
		expect(within(aliceRow()).getByText("A")).toBeTruthy();
	});

	it("keeps the fallback when a typing notification remounts the row", async () => {
		const { client, room } = setup();
		await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
		fireEvent.error(document.querySelector("img") as HTMLImageElement);

		// A typing change re-mints this member's entry, and virtua's <For> keys
		// by reference, so the row is discarded and rebuilt. The failed URL is
		// tracked at the list level, so the broken image must not return (#457).
		room.__addMember({
			userId: "@alice:example.com",
			name: "Alice",
			powerLevel: 0,
			avatarUrl: "mxc://example.com/broken",
			typing: true,
		});
		client.__emit(RoomMemberEvent.Typing, {}, { roomId: "!room:example.com" });
		await waitFor(() => expect(screen.getByText("typing…")).toBeTruthy());

		expect(document.querySelector("img")).toBeNull();
		expect(within(aliceRow()).getByText("A")).toBeTruthy();
	});
});
