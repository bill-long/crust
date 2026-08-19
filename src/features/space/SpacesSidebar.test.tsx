import {
	cleanup,
	fireEvent,
	render,
	screen,
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
	_resetLastChannelsForTests,
	setLastChannel,
} from "../../stores/lastChannel";
import { createMockClient, createMockRoom } from "../../test/mockClient";
import { SpacesSidebar } from "./SpacesSidebar";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const navigateMock = vi.fn();
const paramsState: { spaceId?: string } = {};
vi.mock("@solidjs/router", () => ({
	useNavigate: () => navigateMock,
	useParams: () => paramsState,
}));

function makeSpaceSummary(roomId: string, name: string): RoomSummary {
	return {
		roomId,
		name,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		isSpace: true,
		kind: "text",
		callActive: false,
		children: [],
	};
}

function makeRoomSummary(roomId: string, name: string): RoomSummary {
	return {
		roomId,
		name,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
	};
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
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

afterEach(() => {
	cleanup();
	navigateMock.mockReset();
	paramsState.spaceId = undefined;
	_resetLastChannelsForTests();
});

function setupWithSpace(): {
	client: ReturnType<typeof createMockClient>;
	onOpenSpaceSettings: ReturnType<typeof vi.fn>;
} {
	const client = createMockClient();
	const onOpenSpaceSettings = vi.fn();
	render(() => (
		<Wrapper
			client={client}
			seed={[makeSpaceSummary("!alpha:example.com", "Alpha")]}
		>
			<SpacesSidebar onOpenSpaceSettings={onOpenSpaceSettings} />
		</Wrapper>
	));
	return { client, onOpenSpaceSettings };
}

function setupWithLeave(): {
	client: ReturnType<typeof createMockClient>;
	onOpenSpaceSettings: ReturnType<typeof vi.fn>;
	onLeaveSpace: ReturnType<typeof vi.fn>;
} {
	const client = createMockClient();
	const onOpenSpaceSettings = vi.fn();
	const onLeaveSpace = vi.fn();
	render(() => (
		<Wrapper
			client={client}
			seed={[makeSpaceSummary("!alpha:example.com", "Alpha")]}
		>
			<SpacesSidebar
				onOpenSpaceSettings={onOpenSpaceSettings}
				onLeaveSpace={onLeaveSpace}
			/>
		</Wrapper>
	));
	return { client, onOpenSpaceSettings, onLeaveSpace };
}

function setupWithInvite(opts?: {
	canInvite?: boolean;
	includeSettings?: boolean;
	includeLeave?: boolean;
}): {
	client: ReturnType<typeof createMockClient>;
	onInviteSpace: ReturnType<typeof vi.fn>;
	onOpenSpaceSettings: ReturnType<typeof vi.fn>;
	onLeaveSpace: ReturnType<typeof vi.fn>;
} {
	const room = createMockRoom("!alpha:example.com", [], [], { name: "Alpha" });
	if (opts?.canInvite === false) room.__setCanInvite(false);
	const client = createMockClient(new Map([["!alpha:example.com", room]]));
	const onInviteSpace = vi.fn();
	const onOpenSpaceSettings = vi.fn();
	const onLeaveSpace = vi.fn();
	render(() => (
		<Wrapper
			client={client}
			seed={[makeSpaceSummary("!alpha:example.com", "Alpha")]}
		>
			<SpacesSidebar
				onInviteSpace={onInviteSpace}
				onOpenSpaceSettings={
					opts?.includeSettings === false ? undefined : onOpenSpaceSettings
				}
				onLeaveSpace={opts?.includeLeave === false ? undefined : onLeaveSpace}
			/>
		</Wrapper>
	));
	return { client, onInviteSpace, onOpenSpaceSettings, onLeaveSpace };
}

describe("SpacesSidebar avatar", () => {
	it("clicking the avatar navigates and does NOT open settings", () => {
		const { onOpenSpaceSettings } = setupWithSpace();
		fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!alpha:example.com")}`,
		);
		expect(onOpenSpaceSettings).not.toHaveBeenCalled();
	});

	it("does not render a hover settings gear on the avatar", () => {
		setupWithSpace();
		expect(
			screen.queryByRole("button", { name: /Settings for Alpha/ }),
		).toBeNull();
	});
});

describe("SpacesSidebar right-click context menu", () => {
	function openContextMenu(): void {
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
	}

	it("opens a context menu with Space settings and Leave space items", async () => {
		setupWithLeave();
		openContextMenu();
		expect(await screen.findByText("Space settings")).toBeTruthy();
		expect(screen.getByText("Leave space")).toBeTruthy();
	});

	it("selecting Leave space calls onLeaveSpace", async () => {
		const { onLeaveSpace } = setupWithLeave();
		openContextMenu();
		await screen.findByText("Leave space");
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Leave space") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onLeaveSpace).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("selecting Space settings calls onOpenSpaceSettings", async () => {
		const { onOpenSpaceSettings } = setupWithLeave();
		openContextMenu();
		await screen.findByText("Space settings");
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Space settings") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onOpenSpaceSettings).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("omits the Leave space item when no onLeaveSpace prop is provided", async () => {
		setupWithSpace();
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
		expect(await screen.findByText("Space settings")).toBeTruthy();
		expect(screen.queryByText("Leave space")).toBeNull();
	});

	it("does not mount a ContextMenu when neither handler is provided (avoids empty popover)", () => {
		const client = createMockClient();
		render(() => (
			<Wrapper
				client={client}
				seed={[makeSpaceSummary("!gamma:example.com", "Gamma")]}
			>
				<SpacesSidebar />
			</Wrapper>
		));
		const avatar = screen.getByRole("button", { name: "Gamma" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
		// The popover itself should not mount (not just be empty).
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByRole("menuitem")).toBeNull();
		expect(screen.queryByText("Space settings")).toBeNull();
		expect(screen.queryByText("Leave space")).toBeNull();
	});
});

describe("SpacesSidebar invite", () => {
	function openContextMenu(): void {
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
	}

	it("renders Invite people item when onInviteSpace is provided and user can invite", async () => {
		setupWithInvite();
		openContextMenu();
		expect(await screen.findByText("Invite people")).toBeTruthy();
	});

	it("selecting Invite people calls onInviteSpace with the space id", async () => {
		const { onInviteSpace } = setupWithInvite();
		openContextMenu();
		await screen.findByText("Invite people");
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Invite people") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onInviteSpace).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("hides Invite people when the user lacks invite permission", async () => {
		setupWithInvite({ canInvite: false });
		openContextMenu();
		// Space settings still mounts → wait for the menu, then assert absence.
		await screen.findByText("Space settings");
		expect(screen.queryByText("Invite people")).toBeNull();
	});

	it("mounts a ContextMenu with only Invite people when other handlers are absent", async () => {
		const { onInviteSpace } = setupWithInvite({
			includeSettings: false,
			includeLeave: false,
		});
		openContextMenu();
		expect(await screen.findByText("Invite people")).toBeTruthy();
		expect(screen.queryByText("Space settings")).toBeNull();
		expect(screen.queryByText("Leave space")).toBeNull();
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Invite people") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onInviteSpace).toHaveBeenCalledWith("!alpha:example.com");
	});

	it("does not mount a ContextMenu when canInvite is false and no other handlers are provided", () => {
		setupWithInvite({
			canInvite: false,
			includeSettings: false,
			includeLeave: false,
		});
		const avatar = screen.getByRole("button", { name: "Alpha" });
		fireEvent.contextMenu(avatar, { clientX: 10, clientY: 10 });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByText("Invite people")).toBeNull();
	});
});

describe("SpacesSidebar last-viewed channel (#226)", () => {
	function setupWithChild(): { spaceId: string; childId: string } {
		const spaceId = "!alpha:example.com";
		const childId = "!general:example.com";
		const space = makeSpaceSummary(spaceId, "Alpha");
		space.children = [childId];
		const child = makeRoomSummary(childId, "general");
		const client = createMockClient();
		render(() => (
			<Wrapper client={client} seed={[space, child]}>
				<SpacesSidebar />
			</Wrapper>
		));
		return { spaceId, childId };
	}

	it("navigates to the landing view when no channel is remembered", () => {
		const { spaceId } = setupWithChild();
		fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent(spaceId)}`,
		);
	});

	it("re-opens the remembered channel when it is a joined child", () => {
		const { spaceId, childId } = setupWithChild();
		setLastChannel(spaceId, childId);
		fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent(spaceId)}/${encodeURIComponent(childId)}`,
		);
	});

	it("falls back to landing when the remembered channel is not a child of the space", () => {
		const { spaceId } = setupWithChild();
		setLastChannel(spaceId, "!stale:example.com");
		fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent(spaceId)}`,
		);
	});
});

describe("SpacesSidebar Home unread badge", () => {
	function dm(roomId: string, unread: number, highlight = 0): RoomSummary {
		const s = makeRoomSummary(roomId, roomId);
		s.isDirect = true;
		s.unreadCount = unread;
		s.highlightCount = highlight;
		return s;
	}

	function renderHome(seed: RoomSummary[]): void {
		render(() => (
			<Wrapper client={createMockClient()} seed={seed}>
				<SpacesSidebar />
			</Wrapper>
		));
	}

	function homeBadge(): HTMLElement | null {
		const home = screen.getByRole("button", { name: "Home" });
		return within(home).queryByRole("status");
	}

	it("renders no badge when there are no unread home rooms", () => {
		renderHome([dm("!dm:example.com", 0)]);
		expect(homeBadge()).toBeNull();
	});

	it("sums unread across DMs and orphan rooms", () => {
		const orphan = makeRoomSummary("!orphan:example.com", "orphan");
		orphan.unreadCount = 3;
		renderHome([dm("!dm:example.com", 2), orphan]);
		const badge = homeBadge();
		expect(badge?.textContent).toBe("5");
		expect(badge?.getAttribute("aria-label")).toBe("5 unread");
		expect(badge?.className).toContain("bg-indicator");
		expect(badge?.className).not.toContain("bg-danger");
	});

	it("caps the displayed count at 99+", () => {
		renderHome([dm("!dm:example.com", 150)]);
		expect(homeBadge()?.textContent).toBe("99+");
	});

	it("uses the danger color and a highlighted label when there are highlights", () => {
		renderHome([dm("!dm:example.com", 2, 1)]);
		const badge = homeBadge();
		expect(badge?.getAttribute("aria-label")).toBe("2 unread, 1 highlighted");
		expect(badge?.className).toContain("bg-danger");
	});

	it("does not count space-child rooms (rolled up under their space)", () => {
		const space = makeSpaceSummary("!alpha:example.com", "Alpha");
		space.children = ["!child:example.com"];
		const child = makeRoomSummary("!child:example.com", "child");
		child.unreadCount = 7;
		renderHome([space, child, dm("!dm:example.com", 2)]);
		expect(homeBadge()?.textContent).toBe("2");
	});
});

describe("SpacesSidebar nested subspaces (#443)", () => {
	function renderWith(seed: RoomSummary[]): void {
		render(() => (
			<Wrapper client={createMockClient()} seed={seed}>
				<SpacesSidebar />
			</Wrapper>
		));
	}

	function space(
		roomId: string,
		name: string,
		children: string[] = [],
	): RoomSummary {
		const s = makeSpaceSummary(roomId, name);
		s.children = children;
		return s;
	}

	it("renders a joined subspace indented under its parent, each exactly once", () => {
		renderWith([
			space("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			space("!beta:example.com", "Beta"),
		]);
		const alphas = screen.getAllByRole("button", { name: "Alpha" });
		const betas = screen.getAllByRole("button", { name: "Beta" });
		expect(alphas).toHaveLength(1);
		expect(betas).toHaveLength(1);
		// The nested tile's SidebarItem wrapper carries the depth indent.
		expect(betas[0].closest(".pl-4")).not.toBeNull();
		expect(alphas[0].closest(".pl-4")).toBeNull();
		// Parent renders before its nested child.
		expect(
			alphas[0].compareDocumentPosition(betas[0]) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("clicking the subspace tile navigates to the subspace's space view", () => {
		renderWith([
			space("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			space("!beta:example.com", "Beta"),
		]);
		fireEvent.click(screen.getByRole("button", { name: "Beta" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!beta:example.com")}`,
		);
	});

	it("clicking the subspace tile re-opens its remembered channel (#226 semantics)", () => {
		const child = makeRoomSummary("!general:example.com", "general");
		renderWith([
			space("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			space("!beta:example.com", "Beta", ["!general:example.com"]),
			child,
		]);
		setLastChannel("!beta:example.com", "!general:example.com");
		fireEvent.click(screen.getByRole("button", { name: "Beta" }));
		expect(navigateMock).toHaveBeenCalledWith(
			`/space/${encodeURIComponent("!beta:example.com")}/${encodeURIComponent("!general:example.com")}`,
		);
	});

	it("badges the parent tile with unread from a subspace's room (recursive rollup)", () => {
		const grandchildRoom = makeRoomSummary("!gc:example.com", "gc");
		grandchildRoom.unreadCount = 3;
		renderWith([
			space("!alpha:example.com", "Alpha", ["!beta:example.com"]),
			space("!beta:example.com", "Beta", ["!gc:example.com"]),
			grandchildRoom,
		]);
		const alphaTile = screen.getByRole("button", { name: "Alpha" });
		const badge = within(alphaTile).getByRole("status");
		expect(badge.textContent).toBe("3");
		expect(badge.getAttribute("aria-label")).toBe("3 unread");
		// The subspace tile badges its own subtree too.
		const betaTile = screen.getByRole("button", { name: "Beta" });
		expect(within(betaTile).getByRole("status").textContent).toBe("3");
	});

	it("renders every member of an A<->B space cycle exactly once", () => {
		renderWith([
			space("!a:example.com", "Aaa", ["!b:example.com"]),
			space("!b:example.com", "Bbb", ["!a:example.com"]),
		]);
		expect(screen.getAllByRole("button", { name: "Aaa" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Bbb" })).toHaveLength(1);
	});

	it("keeps a beyond-cap nested space reachable as a root tile", () => {
		renderWith([
			space("!a:example.com", "Aaa", ["!b:example.com"]),
			space("!b:example.com", "Bbb", ["!c:example.com"]),
			space("!c:example.com", "Ccc", ["!d:example.com"]),
			space("!d:example.com", "Ddd"),
		]);
		for (const name of ["Aaa", "Bbb", "Ccc", "Ddd"]) {
			expect(screen.getAllByRole("button", { name })).toHaveLength(1);
		}
	});

	it("renders a subspace shared by two parents exactly once (diamond)", () => {
		renderWith([
			space("!a:example.com", "Aaa", ["!shared:example.com"]),
			space("!b:example.com", "Bbb", ["!shared:example.com"]),
			space("!shared:example.com", "Shared"),
		]);
		expect(screen.getAllByRole("button", { name: "Shared" })).toHaveLength(1);
	});

	it("does not nest subspaces the user has not joined", () => {
		const invitedSub = space("!invited:example.com", "Invited");
		invitedSub.membership = "invite";
		renderWith([
			space("!alpha:example.com", "Alpha", ["!invited:example.com"]),
			invitedSub,
		]);
		// The invited subspace renders as an invited tile (accent ring),
		// not nested under Alpha.
		expect(screen.queryByRole("button", { name: "Invited" })).toBeNull();
		expect(
			screen.getByRole("button", {
				name: "Invited (invitation pending)",
			}),
		).toBeTruthy();
	});
});

describe("SpacesSidebar nested tile branches (#443)", () => {
	function space(
		roomId: string,
		name: string,
		children: string[] = [],
	): RoomSummary {
		const s = makeSpaceSummary(roomId, name);
		s.children = children;
		return s;
	}

	it("renders the nested tile smaller than the root tile", () => {
		render(() => (
			<Wrapper
				client={createMockClient()}
				seed={[
					space("!alpha:example.com", "Alpha", ["!beta:example.com"]),
					space("!beta:example.com", "Beta"),
				]}
			>
				<SpacesSidebar />
			</Wrapper>
		));
		const root = screen.getByRole("button", { name: "Alpha" });
		const nested = screen.getByRole("button", { name: "Beta" });
		expect(root.className).toContain("h-10 w-10");
		expect(nested.className).toContain("h-8 w-8");
	});

	it("marks the selected nested tile with aria-current and the smaller pill", () => {
		paramsState.spaceId = "!beta:example.com";
		render(() => (
			<Wrapper
				client={createMockClient()}
				seed={[
					space("!alpha:example.com", "Alpha", ["!beta:example.com"]),
					space("!beta:example.com", "Beta"),
				]}
			>
				<SpacesSidebar />
			</Wrapper>
		));
		const nested = screen.getByRole("button", { name: "Beta" });
		expect(nested.getAttribute("aria-current")).toBe("page");
		expect(nested.className).toContain("rounded-lg");
		// The selected rail pill on a nested item is the shorter h-8 bar.
		const item = nested.closest(".pl-4");
		expect(item).not.toBeNull();
		const pill = item?.querySelector(".h-8.rounded-r-full");
		expect(pill).not.toBeNull();
	});

	it("indents a depth-2 tile with pl-8", () => {
		render(() => (
			<Wrapper
				client={createMockClient()}
				seed={[
					space("!a:example.com", "Aaa", ["!b:example.com"]),
					space("!b:example.com", "Bbb", ["!c:example.com"]),
					space("!c:example.com", "Ccc"),
				]}
			>
				<SpacesSidebar />
			</Wrapper>
		));
		const depth2 = screen.getByRole("button", { name: "Ccc" });
		expect(depth2.closest(".pl-8")).not.toBeNull();
	});

	it("opens the context menu on a nested tile and fires the handler with the subspace id", async () => {
		const onLeaveSpace = vi.fn();
		render(() => (
			<Wrapper
				client={createMockClient()}
				seed={[
					space("!alpha:example.com", "Alpha", ["!beta:example.com"]),
					space("!beta:example.com", "Beta"),
				]}
			>
				<SpacesSidebar onLeaveSpace={onLeaveSpace} />
			</Wrapper>
		));
		const nested = screen.getByRole("button", { name: "Beta" });
		fireEvent.contextMenu(nested, { clientX: 10, clientY: 10 });
		await screen.findByText("Leave space");
		const item = screen
			.getAllByRole("menuitem")
			.find((el) => el.textContent === "Leave space") as HTMLElement;
		fireEvent(item, new MouseEvent("pointerup", { bubbles: true, button: 0 }));
		expect(onLeaveSpace).toHaveBeenCalledWith("!beta:example.com");
	});
});

describe("SpacesSidebar tile avatar fallback (#443)", () => {
	it("falls back to the space initial when the avatar image errors", () => {
		const space = makeSpaceSummary("!alpha:example.com", "Alpha");
		space.avatarUrl = "https://example.com/broken.png";
		render(() => (
			<Wrapper client={createMockClient()} seed={[space]}>
				<SpacesSidebar />
			</Wrapper>
		));
		const tile = screen.getByRole("button", { name: "Alpha" });
		const img = tile.querySelector("img");
		expect(img).not.toBeNull();
		fireEvent.error(img as HTMLImageElement);
		expect(tile.querySelector("img")).toBeNull();
		// The initial-letter fallback renders in its place.
		expect(within(tile).getByText("A")).toBeTruthy();
	});
});

describe("SpacesSidebar tile avatar fallback (#457)", () => {
	function renderTile(membership: string): void {
		const space = makeSpaceSummary("!pending:example.com", "Pending");
		space.membership = membership;
		space.avatarUrl = "https://example.com/broken.png";
		render(() => (
			<Wrapper client={createMockClient()} seed={[space]}>
				<SpacesSidebar />
			</Wrapper>
		));
	}

	it("falls back to the space initial when a joined tile's avatar errors", () => {
		renderTile("join");
		const tile = screen.getByRole("button", { name: "Pending" });
		const img = tile.querySelector("img");
		expect(img).not.toBeNull();

		fireEvent.error(img as HTMLImageElement);

		expect(tile.querySelector("img")).toBeNull();
		expect(within(tile).getByText("P")).toBeTruthy();
	});

	it("falls back to the space initial when an invited tile's avatar errors", () => {
		renderTile("invite");
		const tile = screen.getByRole("button", {
			name: "Pending (invitation pending)",
		});
		fireEvent.error(tile.querySelector("img") as HTMLImageElement);

		expect(tile.querySelector("img")).toBeNull();
		expect(within(tile).getByText("P")).toBeTruthy();
	});

	it("falls back to the space initial when a knocked tile's avatar errors", () => {
		renderTile("knock");
		const tile = screen.getByRole("button", {
			name: "Pending (join request pending)",
		});
		fireEvent.error(tile.querySelector("img") as HTMLImageElement);

		expect(tile.querySelector("img")).toBeNull();
		expect(within(tile).getByText("P")).toBeTruthy();
	});
});
