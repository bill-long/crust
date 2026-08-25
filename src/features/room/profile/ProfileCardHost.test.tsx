import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type JSX, type ParentComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../../client/client";
import { ClientContext } from "../../../client/client";
import {
	createSummariesStore,
	type SummariesStore,
} from "../../../client/summaries";
import {
	clearMentionIntent,
	mentionIntent,
} from "../../../stores/composerIntents";
import {
	_resetIgnoredUsersForTests,
	initIgnoredUsers,
} from "../../../stores/ignoredUsers";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { MemberList } from "../MemberList";
import { ProfileCardHost } from "./ProfileCardHost";
import { closeProfileCard } from "./profileCard";

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

const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
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
				optimisticallySetMarkedUnread: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function setup(options?: { myPower?: number; ignored?: string[] }) {
	const myPower = options?.myPower ?? 0;
	const room = createMockRoom(
		"!room:example.com",
		[],
		[
			{ userId: "@test:example.com", name: "Me", powerLevel: myPower },
			{ userId: "@alice:example.com", name: "Alice", powerLevel: 0 },
		],
	);
	room.__setStateEvent("m.room.power_levels", "", {
		users: { "@test:example.com": myPower },
		users_default: 0,
		kick: 50,
		ban: 50,
	});
	const client = createMockClient(new Map([["!room:example.com", room]]));
	client.getIgnoredUsers.mockReturnValue(options?.ignored ?? []);
	initIgnoredUsers(client as never);
	render(() => (
		<Wrapper client={client}>
			<MemberList roomId="!room:example.com" />
			<ProfileCardHost />
		</Wrapper>
	));
	return { client, room };
}

async function openCard(displayName: string): Promise<void> {
	fireEvent.click(screen.getByLabelText(`View profile of ${displayName}`));
	await waitFor(() =>
		expect(document.querySelector('[role="dialog"]')).toBeTruthy(),
	);
}

function card(): HTMLElement {
	const el = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!el) throw new Error("profile card not open");
	return el;
}

afterEach(() => {
	cleanup();
	closeProfileCard();
	clearMentionIntent();
	_resetIgnoredUsersForTests();
	navigateMock.mockReset();
});

beforeEach(() => {
	// Kobalte's scroll-prevention cleanup calls window.scrollTo, which
	// jsdom doesn't implement; stub it to keep the test output clean.
	window.scrollTo = vi.fn();
});

describe("ProfileCardHost (#444)", () => {
	it("opens from a member row with name, MXID and role", async () => {
		setup();
		await openCard("Alice");
		expect(card().textContent).toContain("Alice");
		expect(card().textContent).toContain("@alice:example.com");
		expect(card().textContent).toContain("Member");
	});

	it("toggles closed when the trigger row is clicked again", async () => {
		setup();
		await openCard("Alice");
		fireEvent.click(screen.getByLabelText("View profile of Alice"));
		await waitFor(() =>
			expect(document.querySelector('[role="dialog"]')).toBeNull(),
		);
	});

	it("opens an existing joined DM instantly, without a createRoom round-trip", async () => {
		const { client, room } = setup();
		const dmRoom = createMockRoom("!dm:example.com", [], []);
		(dmRoom as unknown as { getMyMembership: () => string }).getMyMembership =
			() => "join";
		client.__setRooms(
			new Map([
				["!room:example.com", room],
				["!dm:example.com", dmRoom],
			]),
		);
		client.__setAccountData("m.direct", {
			"@alice:example.com": ["!dm:example.com"],
		});
		await openCard("Alice");
		fireEvent.click(screen.getByText("Message"));
		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith(
				`/dm/${encodeURIComponent("!dm:example.com")}`,
			),
		);
		expect(client.createRoom).not.toHaveBeenCalled();
	});

	it("surfaces a failed DM start inline and keeps the card open", async () => {
		const { client } = setup();
		client.createRoom.mockRejectedValue(new TypeError("Failed to fetch"));
		await openCard("Alice");
		fireEvent.click(screen.getByText("Message"));
		await waitFor(() =>
			expect(card().querySelector('[role="alert"]')?.textContent).toContain(
				"Couldn't start the conversation",
			),
		);
		expect(navigateMock).not.toHaveBeenCalled();
	});

	it("starts a DM from the Message action and navigates to it", async () => {
		const { client } = setup();
		(client as unknown as { setAccountData: unknown }).setAccountData = vi
			.fn()
			.mockResolvedValue({});
		await openCard("Alice");
		fireEvent.click(screen.getByText("Message"));
		await waitFor(() =>
			expect(navigateMock).toHaveBeenCalledWith(
				`/dm/${encodeURIComponent("!created:example.com")}`,
			),
		);
		expect(client.createRoom).toHaveBeenCalledOnce();
	});

	it("requests a composer mention and closes", async () => {
		setup();
		await openCard("Alice");
		fireEvent.click(screen.getByText("Mention"));
		expect(mentionIntent()).toMatchObject({
			roomId: "!room:example.com",
			threadRootId: null,
			userId: "@alice:example.com",
			name: "Alice",
		});
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("blocks a member and persists the ignore", async () => {
		const { client } = setup();
		await openCard("Alice");
		fireEvent.click(screen.getByText("Block"));
		await waitFor(() =>
			expect(client.setIgnoredUsers).toHaveBeenCalledWith([
				"@alice:example.com",
			]),
		);
	});

	it("offers Unblock for an ignored member", async () => {
		const { client } = setup({ ignored: ["@alice:example.com"] });
		await openCard("Alice");
		fireEvent.click(screen.getByText("Unblock"));
		await waitFor(() =>
			expect(client.setIgnoredUsers).toHaveBeenCalledWith([]),
		);
	});

	it("surfaces a failed block inline and keeps the card open", async () => {
		const { client } = setup();
		client.setIgnoredUsers.mockRejectedValue(new TypeError("Failed to fetch"));
		await openCard("Alice");
		fireEvent.click(screen.getByText("Block"));
		await waitFor(() =>
			expect(card().querySelector('[role="alert"]')?.textContent).toContain(
				"Couldn't block Alice",
			),
		);
	});

	it("hides Message/Block on your own card and shows your profile", async () => {
		setup();
		await openCard("Me");
		expect(card().textContent).toContain("@test:example.com");
		expect(screen.queryByText("Message")).toBeNull();
		expect(screen.queryByText("Block")).toBeNull();
	});

	it("shows no moderation actions to a non-moderator", async () => {
		setup({ myPower: 0 });
		await openCard("Alice");
		expect(screen.queryByText("Kick…")).toBeNull();
		expect(screen.queryByText("Ban…")).toBeNull();
		expect(screen.queryByText("Promote to Moderator")).toBeNull();
	});

	it("lets an admin kick through the confirm dialog", async () => {
		const { client } = setup({ myPower: 100 });
		const kick = vi.fn().mockResolvedValue(undefined);
		(client as unknown as { kick: unknown }).kick = kick;
		await openCard("Alice");
		fireEvent.click(screen.getByText("Kick…"));
		// The popover closes; the host's ConfirmDialog takes over.
		await waitFor(() => expect(screen.getByText("Kick Alice?")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Kick" }));
		await waitFor(() =>
			expect(kick).toHaveBeenCalledWith(
				"!room:example.com",
				"@alice:example.com",
			),
		);
	});
});
