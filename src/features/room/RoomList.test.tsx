import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal, type ParentComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState, CryptoState } from "../../client/client";
import { ClientContext } from "../../client/client";
import {
	createSummariesStore,
	type RoomSummary,
	type SummariesStore,
} from "../../client/summaries";
import {
	_resetExploreDialogForTests,
	exploreDialogOpen,
} from "../../stores/exploreDialog";
import {
	_resetLastChannelsForTests,
	setLastChannel,
} from "../../stores/lastChannel";
import { createMockClient } from "../../test/mockClient";
import { RoomList } from "./RoomList";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
const paramsState: { spaceId?: string; roomId?: string } = {};
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useParams: () => paramsState,
}));

function makeRoomSummary(roomId: string, name: string): RoomSummary {
	return {
		roomId,
		name,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread: false,
		isFavourite: false,
		isLowPriority: false,
		spaceOrder: null,
		isMuted: false,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		dmUserId: null,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
	};
}

function makeSpaceSummary(
	roomId: string,
	name: string,
	children: string[] = [],
): RoomSummary {
	return { ...makeRoomSummary(roomId, name), isSpace: true, children };
}

const Wrapper: ParentComponent<{
	client: ReturnType<typeof createMockClient>;
	seed: RoomSummary[];
}> = (props) => {
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const store = createSummariesStore(props.client as unknown as MatrixClient);
	for (const s of props.seed) {
		store.setSummaries(s.roomId, s);
	}
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
				optimisticallySetRoomTag: vi.fn(),
				optimisticallySetSpaceOrder: vi.fn(),
				forgetRoomLocally: vi.fn(),
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

function renderRoomList(seed: RoomSummary[]): void {
	render(() => (
		<Wrapper client={createMockClient()} seed={seed}>
			<RoomList />
		</Wrapper>
	));
}

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	paramsState.spaceId = undefined;
	paramsState.roomId = undefined;
	_resetExploreDialogForTests();
	_resetLastChannelsForTests();
});

describe("RoomList subspace rows (#443)", () => {
	it("renders joined subspaces above the space's rooms, with the Space icon", () => {
		paramsState.spaceId = "!alpha:example.com";
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", [
				"!beta:example.com",
				"!general:example.com",
			]),
			makeSpaceSummary("!beta:example.com", "Beta"),
			makeRoomSummary("!general:example.com", "general"),
		]);

		const beta = screen.getByRole("button", { name: "Space Beta" });
		const general = screen.getByRole("button", {
			name: "Text channel general",
		});
		expect(within(beta).getByRole("img", { name: "Space" })).toBeTruthy();
		expect(
			beta.compareDocumentPosition(general) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("clicking a subspace row navigates to the subspace's space view", () => {
		paramsState.spaceId = "!alpha:example.com";
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			makeSpaceSummary("!beta:example.com", "Beta"),
		]);

		fireEvent.click(screen.getByRole("button", { name: "Space Beta" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!beta:example.com")}`,
		);
	});

	it("clicking a subspace row re-opens its remembered channel (#226 semantics)", () => {
		paramsState.spaceId = "!alpha:example.com";
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			makeSpaceSummary("!beta:example.com", "Beta", ["!general:example.com"]),
			makeRoomSummary("!general:example.com", "general"),
		]);
		setLastChannel("!beta:example.com", "!general:example.com");

		fireEvent.click(screen.getByRole("button", { name: "Space Beta" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!beta:example.com")}/${encodeURIComponent("!general:example.com")}`,
		);
	});

	it("badges the subspace row with its subtree's unread rollup", () => {
		paramsState.spaceId = "!alpha:example.com";
		const grandchild = makeRoomSummary("!gc:example.com", "gc");
		grandchild.unreadCount = 4;
		grandchild.highlightCount = 1;
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			makeSpaceSummary("!beta:example.com", "Beta", ["!gc:example.com"]),
			grandchild,
		]);

		const beta = screen.getByRole("button", { name: /Space Beta/ });
		const badge = within(beta).getByRole("status");
		expect(badge.textContent).toBe("4");
		expect(badge.getAttribute("aria-label")).toBe("4 unread, 1 highlighted");
		expect(badge.className).toContain("bg-danger");
	});

	it("suppresses the empty state when the space has only a joined subspace", async () => {
		paramsState.spaceId = "!alpha:example.com";
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			makeSpaceSummary("!beta:example.com", "Beta"),
		]);

		// Presence first (the absence assertion below is meaningless without it).
		expect(screen.getByRole("button", { name: "Space Beta" })).toBeTruthy();
		// Let the hierarchy fetch settle, then the empty state must NOT appear.
		await waitFor(() => {
			expect(screen.queryByText("No rooms in this space")).toBeNull();
		});
	});

	it("still shows the empty state for a space with nothing at all (control)", async () => {
		paramsState.spaceId = "!empty:example.com";
		renderRoomList([makeSpaceSummary("!empty:example.com", "Empty")]);

		expect(await screen.findByText("No rooms in this space")).toBeTruthy();
	});
});

describe("RoomList SubspaceEntry badge branches (#443)", () => {
	it("falls back to 'Unnamed space' for a whitespace-only name", () => {
		paramsState.spaceId = "!alpha:example.com";
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			makeSpaceSummary("!beta:example.com", "   "),
		]);
		expect(
			screen.getByRole("button", { name: "Space Unnamed space" }),
		).toBeTruthy();
	});

	it("renders no badge when the subspace subtree has no unread", () => {
		paramsState.spaceId = "!alpha:example.com";
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			makeSpaceSummary("!beta:example.com", "Beta", ["!gc:example.com"]),
			makeRoomSummary("!gc:example.com", "gc"),
		]);
		const beta = screen.getByRole("button", { name: "Space Beta" });
		// Presence of the row first, so the badge absence is meaningful.
		expect(beta).toBeTruthy();
		expect(within(beta).queryByRole("status")).toBeNull();
	});

	it("caps the badge at 99+ and uses the indicator color without highlights", () => {
		paramsState.spaceId = "!alpha:example.com";
		const grandchild = makeRoomSummary("!gc:example.com", "gc");
		grandchild.unreadCount = 150;
		renderRoomList([
			makeSpaceSummary("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			makeSpaceSummary("!beta:example.com", "Beta", ["!gc:example.com"]),
			grandchild,
		]);
		const beta = screen.getByRole("button", { name: /Space Beta/ });
		const badge = within(beta).getByRole("status");
		expect(badge.textContent).toBe("99+");
		expect(badge.getAttribute("aria-label")).toBe("150 unread");
		expect(badge.className).toContain("bg-indicator");
		expect(badge.className).not.toContain("bg-danger");
	});
});

describe("RoomList directory browse (#304)", () => {
	it("opens the Explore dialog from the Home header button", () => {
		renderRoomList([makeRoomSummary("!general:example.com", "general")]);
		expect(exploreDialogOpen()).toBe(false);
		fireEvent.click(
			screen.getByRole("button", { name: "Explore public rooms" }),
		);
		expect(exploreDialogOpen()).toBe(true);
	});

	it("hides the Explore button inside a space", () => {
		paramsState.spaceId = "!alpha:example.com";
		renderRoomList([makeSpaceSummary("!alpha:example.com", "Alpha")]);
		// Positive anchor: the list rendered in space context (Create room
		// is space-visible), so the Explore absence below is meaningful.
		expect(screen.getByRole("button", { name: "Create room" })).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Explore public rooms" }),
		).toBeNull();
	});
});

describe("RoomList mark as unread (#446)", () => {
	function renderWithClient(
		seed: RoomSummary[],
	): ReturnType<typeof createMockClient> {
		const client = createMockClient();
		render(() => (
			<Wrapper client={client} seed={seed}>
				<RoomList />
			</Wrapper>
		));
		return client;
	}

	it("renders a dot (not a count) for a room that is only marked unread", () => {
		const marked = makeRoomSummary("!general:example.com", "general");
		marked.markedUnread = true;
		renderWithClient([marked]);
		const row = screen.getByRole("button", { name: /general/ });
		const dot = within(row).getByRole("img", { name: "Marked unread" });
		expect(dot.textContent).toBe("");
	});

	it("prefers the numeric badge when the room also has unread messages", () => {
		const marked = makeRoomSummary("!general:example.com", "general");
		marked.markedUnread = true;
		marked.unreadCount = 3;
		renderWithClient([marked]);
		const row = screen.getByRole("button", { name: /general/ });
		expect(within(row).getByRole("status", { name: "3 unread" })).toBeTruthy();
		expect(
			within(row).queryByRole("status", { name: "Marked unread" }),
		).toBeNull();
	});

	it("right-click 'Mark as unread' writes m.marked_unread account data", async () => {
		const client = renderWithClient([
			makeRoomSummary("!general:example.com", "general"),
		]);
		const row = screen.getByRole("button", { name: /general/ });
		fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
		const item = await screen.findByRole("menuitem", {
			name: "Mark as unread",
		});
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(client.setRoomAccountData).toHaveBeenCalledWith(
			"!general:example.com",
			"m.marked_unread",
			{ unread: true },
		);
	});

	it("disables the item when the room is already unread", async () => {
		const unread = makeRoomSummary("!general:example.com", "general");
		unread.unreadCount = 2;
		const client = renderWithClient([unread]);
		const row = screen.getByRole("button", { name: /general/ });
		fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
		// The menu still opens on a room row (Discord's grayed-out
		// treatment); only the non-actionable item disables.
		const item = await screen.findByRole("menuitem", {
			name: "Mark as unread",
		});
		expect(item.getAttribute("aria-disabled")).toBe("true");
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(client.setRoomAccountData).not.toHaveBeenCalled();
	});

	it("does not open the menu for a press outside a room row", () => {
		renderWithClient([makeRoomSummary("!general:example.com", "general")]);
		// Aim at a row first so a stale target exists, then right-click the
		// empty list area below the rows: the capture-phase reset must
		// un-aim before the trigger decides.
		const row = screen.getByRole("button", { name: /general/ });
		fireEvent.pointerDown(row, { button: 2 });
		const region = row.closest(
			"[data-expanded], div.flex.min-h-0",
		) as HTMLElement;
		fireEvent.contextMenu(region, { clientX: 10, clientY: 400 });
		expect(screen.queryByRole("menuitem")).toBeNull();
	});
});

describe("RoomList tag sections and toggles (#449)", () => {
	function renderTagList(
		seed: RoomSummary[],
	): ReturnType<typeof createMockClient> {
		const client = createMockClient();
		render(() => (
			<Wrapper client={client} seed={seed}>
				<RoomList />
			</Wrapper>
		));
		return client;
	}

	it("renders Favorites above DMs/Rooms and Low priority at the bottom", () => {
		const fav = makeRoomSummary("!fav:example.com", "starred");
		fav.isFavourite = true;
		const low = makeRoomSummary("!low:example.com", "background");
		low.isLowPriority = true;
		renderTagList([
			fav,
			low,
			makeRoomSummary("!general:example.com", "general"),
		]);

		const labels = ["Favorites", "Rooms", "Low priority"].map(
			(t) => screen.getByText(t) as HTMLElement,
		);
		expect(
			labels[0].compareDocumentPosition(labels[1]) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			labels[1].compareDocumentPosition(labels[2]) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// The tagged rooms render once, in their sections, not under Rooms.
		expect(screen.getAllByRole("button", { name: /starred/ })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: /background/ })).toHaveLength(
			1,
		);
	});

	it("the context menu's Favorite toggle writes the m.favourite tag", async () => {
		const client = renderTagList([
			makeRoomSummary("!general:example.com", "general"),
		]);
		const row = screen.getByRole("button", { name: /general/ });
		fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
		const item = await screen.findByRole("menuitemcheckbox", {
			name: "Favorite",
		});
		expect(item.getAttribute("aria-checked")).toBe("false");
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(client.setRoomTag).toHaveBeenCalledWith(
			"!general:example.com",
			"m.favourite",
			{},
		);
	});

	it("the Low priority toggle deletes the tag when already set", async () => {
		const low = makeRoomSummary("!general:example.com", "general");
		low.isLowPriority = true;
		const client = renderTagList([low]);
		const row = screen.getByRole("button", { name: /general/ });
		fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
		const item = await screen.findByRole("menuitemcheckbox", {
			name: "Low priority",
		});
		expect(item.getAttribute("aria-checked")).toBe("true");
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(client.deleteRoomTag).toHaveBeenCalledWith(
			"!general:example.com",
			"m.lowpriority",
		);
	});
});
