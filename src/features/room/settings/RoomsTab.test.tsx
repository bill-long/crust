import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSummariesStore,
	type RoomSummary,
} from "../../../client/summaries";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { TestClientProvider } from "../../../test/TimelineHarness";
import { RoomsTab } from "./RoomsTab";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeSummary(
	partial: Partial<RoomSummary> & { roomId: string },
): RoomSummary {
	return {
		name: partial.roomId,
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
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
		...partial,
	};
}

function setup(opts?: {
	canManage?: boolean;
	registerCandidateRoom?: boolean;
	registerChildRoom?: boolean;
	childAvatarUrl?: string;
}) {
	const space = createMockRoom("!space:x", [], [], { name: "My Space" });
	space.__setStateEvent("m.room.create", "", { type: "m.space" });
	space.__setStateEvent("m.room.power_levels", "", {});
	if (opts?.canManage === false) {
		space.__setCanSendStateEvent("m.space.child", false);
	}
	const rooms = new Map([["!space:x", space]]);
	if (opts?.registerCandidateRoom) {
		// A known child room the user can manage — so the m.space.parent send
		// in the Add flow is attempted (getRoom + maySendStateEvent succeed).
		const cand = createMockRoom("!cand:x", [], [], { name: "Candidate Room" });
		rooms.set("!cand:x", cand);
	}
	if (opts?.registerChildRoom) {
		const child = createMockRoom("!child:x", [], [], { name: "Child Room" });
		rooms.set("!child:x", child);
	}
	const client = createMockClient(rooms);
	const store = createSummariesStore(client as unknown as MatrixClient);
	store.setSummaries(
		"!space:x",
		makeSummary({
			roomId: "!space:x",
			name: "My Space",
			isSpace: true,
			children: ["!child:x"],
		}),
	);
	store.setSummaries(
		"!child:x",
		makeSummary({
			roomId: "!child:x",
			name: "Child Room",
			avatarUrl: opts?.childAvatarUrl ?? null,
		}),
	);
	store.setSummaries(
		"!cand:x",
		makeSummary({ roomId: "!cand:x", name: "Candidate Room" }),
	);

	render(() => (
		<TestClientProvider client={client} summaries={store.summaries}>
			<RoomsTab client={client as unknown as MatrixClient} roomId="!space:x" />
		</TestClientProvider>
	));

	return { client, store };
}

afterEach(() => {
	cleanup();
	// Restore any console spies (e.g. the console.error spies in the
	// write-failure tests) so they don't leak into later tests.
	vi.restoreAllMocks();
});

describe("RoomsTab", () => {
	it("lists current child rooms and add-candidates", () => {
		setup();
		expect(screen.getByText("Child Room")).toBeTruthy();
		// Candidate appears with an Add button; child has a Remove button.
		expect(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", {
				name: "Remove Child Room from this space",
			}),
		).toBeTruthy();
	});

	it("does not list rooms already in the space as candidates", () => {
		setup();
		expect(
			screen.queryByRole("button", { name: "Add Child Room to this space" }),
		).toBeNull();
	});

	it("sends an m.space.child with via on Add", async () => {
		const { client } = setup();
		fireEvent.click(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		);
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!space:x",
			"m.space.child",
			{ via: ["example.com"], suggested: false },
			"!cand:x",
		);
	});

	it("also sends m.space.parent on the child room when permitted (#184)", async () => {
		const { client } = setup({ registerCandidateRoom: true });
		fireEvent.click(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		);
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!cand:x",
			"m.space.parent",
			{ via: ["example.com"], canonical: true },
			"!space:x",
		);
	});

	it("skips m.space.parent when the child room is not known locally", async () => {
		const { client } = setup();
		fireEvent.click(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		);
		await flush();
		expect(client.sendStateEvent).not.toHaveBeenCalledWith(
			"!cand:x",
			"m.space.parent",
			expect.anything(),
			"!space:x",
		);
	});

	it("sends an empty m.space.child on Remove", async () => {
		const { client } = setup();
		fireEvent.click(
			screen.getByRole("button", { name: "Remove Child Room from this space" }),
		);
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!space:x",
			"m.space.child",
			{},
			"!child:x",
		);
	});

	it("also clears m.space.parent on the child when permitted on Remove (#184)", async () => {
		const { client } = setup({ registerChildRoom: true });
		fireEvent.click(
			screen.getByRole("button", { name: "Remove Child Room from this space" }),
		);
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			"!child:x",
			"m.space.parent",
			{},
			"!space:x",
		);
	});

	it("filters candidates by name", () => {
		setup();
		const input = screen.getByPlaceholderText("Search your rooms…");
		fireEvent.input(input, { target: { value: "zzz" } });
		expect(screen.getByText("No matching rooms.")).toBeTruthy();
		expect(
			screen.queryByRole("button", {
				name: "Add Candidate Room to this space",
			}),
		).toBeNull();
	});

	it("hides add/remove controls and shows a notice without permission", () => {
		const { client } = setup({ canManage: false });
		expect(
			screen.queryByRole("button", {
				name: "Remove Child Room from this space",
			}),
		).toBeNull();
		expect(
			screen.getByText(
				"You don't have permission to manage this space's rooms.",
			),
		).toBeTruthy();
		expect(client.sendStateEvent).not.toHaveBeenCalled();
	});

	it("rolls back the optimistic add and surfaces an error when the write fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client } = setup();
		(client.sendStateEvent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("M_FORBIDDEN"),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		);
		await flush();
		// Error surfaced and the candidate is restored (overlay rolled back).
		expect(screen.getByRole("alert").textContent).toContain("M_FORBIDDEN");
		expect(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		).toBeTruthy();
	});

	it("rolls back the optimistic remove and surfaces an error when the write fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client } = setup();
		(client.sendStateEvent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("M_FORBIDDEN"),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Remove Child Room from this space" }),
		);
		await flush();
		expect(screen.getByRole("alert").textContent).toContain("M_FORBIDDEN");
		// The child is restored (overlay rolled back), so Remove is available again.
		expect(
			screen.getByRole("button", { name: "Remove Child Room from this space" }),
		).toBeTruthy();
	});

	it("releases the optimistic overlay so later divergent server state wins", async () => {
		const { client, store } = setup();
		fireEvent.click(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		);
		await flush();
		expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
		// Candidate is optimistically removed from the picker (overlay applied).
		expect(
			screen.queryByRole("button", {
				name: "Add Candidate Room to this space",
			}),
		).toBeNull();
		// The matching sync echo arrives, which should clear the overlay.
		store.setSummaries("!space:x", "children", ["!child:x", "!cand:x"]);
		await flush();
		// A LATER divergent server change (e.g. another client removes the room
		// again) must now win. If the overlay were still pinned to the add-time
		// snapshot, the candidate would stay hidden — so its reappearance proves
		// the overlay was released.
		store.setSummaries("!space:x", "children", ["!child:x"]);
		await flush();
		expect(
			screen.getByRole("button", { name: "Add Candidate Room to this space" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", {
				name: "Remove Candidate Room from this space",
			}),
		).toBeNull();
	});
});

describe("RoomsTab avatar fallback (#457)", () => {
	function childRow(name = "Child Room"): HTMLElement {
		return screen.getByText(name).closest("li") as HTMLElement;
	}

	it("falls back to the room initial when the avatar image errors", () => {
		setup({ childAvatarUrl: "https://example.com/broken.png" });
		const img = childRow().querySelector("img");
		expect(img).not.toBeNull();

		fireEvent.error(img as HTMLImageElement);

		expect(childRow().querySelector("img")).toBeNull();
		expect(within(childRow()).getByText("C")).toBeTruthy();
	});

	it("keeps the fallback when a summaries change rebuilds the row", async () => {
		const { store } = setup({
			childAvatarUrl: "https://example.com/broken.png",
		});
		fireEvent.error(childRow().querySelector("img") as HTMLImageElement);

		// The row list is a memo over the summaries store, so a rename re-mints
		// the display objects and <For> rebuilds the row. The failed URL is
		// tracked at the tab level, so the fallback must stick (#457).
		store.setSummaries(
			"!child:x",
			makeSummary({
				roomId: "!child:x",
				name: "Child Room Renamed",
				avatarUrl: "https://example.com/broken.png",
			}),
		);
		await flush();

		const row = childRow("Child Room Renamed");
		expect(row.querySelector("img")).toBeNull();
		expect(within(row).getByText("C")).toBeTruthy();
	});
});
