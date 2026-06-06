import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import {
	ClientEvent,
	EventType,
	JoinRule,
	type MatrixClient,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { JoinRuleSection, normalizeAllow, sameAllow } from "./JoinRuleSection";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

const ROOM = "!room:example.com";
const ALPHA = "!alpha:example.com";
const BETA = "!beta:example.com";

interface ActionClient {
	sendStateEvent: ReturnType<typeof vi.fn>;
}

function setup(options?: {
	join?: Record<string, unknown>;
	canJoinRules?: boolean;
	linkBeta?: boolean;
}) {
	const room = createMockRoom(ROOM, [], [], { name: "Room" });
	room.__setStateEvent("m.room.join_rules", "", {
		join_rule: JoinRule.Restricted,
		allow: [{ room_id: ALPHA, type: "m.room_membership" }],
		...(options?.join ?? {}),
	});
	if (options?.canJoinRules === false) {
		room.__setCanSendStateEvent("m.room.join_rules", false);
	}

	// Alpha and Beta are parent spaces that list this room as a child.
	const alpha = createMockRoom(ALPHA, [], [], { name: "Alpha" });
	alpha.__setIsSpace(true);
	alpha.__setStateEvent("m.space.child", ROOM, { via: ["example.com"] });
	const beta = createMockRoom(BETA, [], [], { name: "Beta" });
	beta.__setIsSpace(true);
	if (options?.linkBeta !== false) {
		beta.__setStateEvent("m.space.child", ROOM, { via: ["example.com"] });
	}

	const client = createMockClient(
		new Map([
			[ROOM, room],
			[ALPHA, alpha],
			[BETA, beta],
		]),
	);
	render(() => (
		<JoinRuleSection client={client as unknown as MatrixClient} roomId={ROOM} />
	));
	return { client: client as unknown as ActionClient, room, beta };
}

afterEach(cleanup);

describe("JoinRuleSection allow list", () => {
	it("lists allowed spaces and offers un-allowed parent spaces to add", () => {
		setup();
		// Alpha is already allowed → shown in the list, not as an add button.
		expect(screen.getByText("Alpha")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "+ Alpha" })).toBeNull();
		// Beta is a parent space not yet allowed → offered as an add button.
		expect(screen.getByRole("button", { name: "+ Beta" })).toBeTruthy();
	});

	it("adds a parent space to the allow list", async () => {
		const { client } = setup();
		fireEvent.click(screen.getByRole("button", { name: "+ Beta" }));
		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			ROOM,
			EventType.RoomJoinRules,
			{
				join_rule: JoinRule.Restricted,
				allow: [
					{ room_id: ALPHA, type: "m.room_membership" },
					{ room_id: BETA, type: "m.room_membership" },
				],
			},
			"",
		);
	});

	it("removes a space from the allow list", async () => {
		const { client } = setup();
		fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
		await waitFor(() => expect(client.sendStateEvent).toHaveBeenCalledTimes(1));
		// Removing the last entry leaves restricted with no allow list.
		expect(client.sendStateEvent).toHaveBeenCalledWith(
			ROOM,
			EventType.RoomJoinRules,
			{ join_rule: JoinRule.Restricted },
			"",
		);
	});

	it("selecting Restricted writes the rule and reveals the editor", async () => {
		const { client } = setup({
			join: { join_rule: JoinRule.Invite, allow: [] },
		});
		// Editor hidden while Invite is selected.
		expect(screen.queryByText("Spaces whose members can join")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Restricted (space)" }));

		await waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledWith(
				ROOM,
				EventType.RoomJoinRules,
				{ join_rule: JoinRule.Restricted },
				"",
			),
		);
		// Optimistic rule flip reveals the editor.
		expect(screen.getByText("Spaces whose members can join")).toBeTruthy();
	});

	it("refreshes the candidate list when a space relationship arrives after mount", async () => {
		const { client, beta } = setup({ linkBeta: false });
		// Beta isn't linked yet → not offered.
		expect(screen.queryByRole("button", { name: "+ Beta" })).toBeNull();

		// Beta links this room as a child and the state event lands.
		beta.__setStateEvent("m.space.child", ROOM, { via: ["example.com"] });
		(
			client as unknown as {
				__emit: (event: string, ...args: unknown[]) => void;
			}
		).__emit(RoomStateEvent.Events, {
			getType: () => "m.space.child",
			getRoomId: () => BETA,
			getStateKey: () => ROOM,
		});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "+ Beta" })).toBeTruthy(),
		);
	});

	it("refreshes candidates when a parent space syncs in (ClientEvent.Room)", async () => {
		const { client, beta } = setup({ linkBeta: false });
		expect(screen.queryByRole("button", { name: "+ Beta" })).toBeNull();

		// Beta becomes a linked parent space and a room-added event fires.
		beta.__setStateEvent("m.space.child", ROOM, { via: ["example.com"] });
		(
			client as unknown as {
				__emit: (event: string, ...args: unknown[]) => void;
			}
		).__emit(ClientEvent.Room, {});

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "+ Beta" })).toBeTruthy(),
		);
	});

	it("resets the optimistic overlay when the target room changes", () => {
		const roomA = createMockRoom("!a:example.com", [], [], { name: "A" });
		roomA.__setStateEvent("m.room.join_rules", "", {
			join_rule: JoinRule.Public,
		});
		const roomB = createMockRoom("!b:example.com", [], [], { name: "B" });
		roomB.__setStateEvent("m.room.join_rules", "", {
			join_rule: JoinRule.Invite,
		});
		const client = createMockClient(
			new Map([
				["!a:example.com", roomA],
				["!b:example.com", roomB],
			]),
		);
		// A write that never resolves keeps the optimistic overlay in flight.
		(
			client as unknown as { sendStateEvent: ReturnType<typeof vi.fn> }
		).sendStateEvent = vi.fn(() => new Promise<never>(() => {}));

		const [rid, setRid] = createSignal("!a:example.com");
		render(() => (
			<JoinRuleSection
				client={client as unknown as MatrixClient}
				roomId={rid()}
			/>
		));

		// Optimistically switch room A to Knock (overlay stays pending).
		fireEvent.click(screen.getByRole("button", { name: "Knock" }));
		expect(
			screen
				.getByRole("button", { name: "Knock" })
				.getAttribute("aria-pressed"),
		).toBe("true");

		// Switching rooms must drop A's overlay, not bleed it into room B.
		setRid("!b:example.com");
		expect(
			screen
				.getByRole("button", { name: "Invite only" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			screen
				.getByRole("button", { name: "Knock" })
				.getAttribute("aria-pressed"),
		).toBe("false");
	});

	it("hides add/remove controls without permission", () => {
		setup({ canJoinRules: false });
		// Allowed spaces still listed, but no edit affordances.
		expect(screen.getByText("Alpha")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Remove Alpha" })).toBeNull();
		expect(screen.queryByRole("button", { name: "+ Beta" })).toBeNull();
		expect(
			screen
				.getByRole("button", { name: "Restricted (space)" })
				.getAttribute("aria-disabled"),
		).toBe("true");
	});

	it("shows a read-only empty message when restricted with no allowed spaces and no permission", () => {
		setup({
			join: { join_rule: JoinRule.Restricted, allow: [] },
			canJoinRules: false,
		});
		expect(screen.getByText("No spaces are allowed to join.")).toBeTruthy();
		expect(screen.queryByText(/add a space below/)).toBeNull();
	});

	it("renders resiliently when the allow list contains malformed entries", () => {
		// null, non-object, and missing-room_id entries must not crash the UI.
		setup({
			join: {
				join_rule: JoinRule.Restricted,
				allow: [
					{ room_id: ALPHA, type: "m.room_membership" },
					null,
					"garbage",
					{ type: "m.room_membership" },
				],
			},
		});
		expect(screen.getByText("Alpha")).toBeTruthy();
		// Only the one well-formed entry is shown.
		expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
	});
});

describe("sameAllow", () => {
	const entry = (room_id: string) => ({
		room_id,
		type: "m.room_membership" as never,
	});

	it("treats order-insensitive equal lists as equal", () => {
		expect(sameAllow([entry("a"), entry("b")], [entry("b"), entry("a")])).toBe(
			true,
		);
	});

	it("distinguishes lists with duplicate room IDs", () => {
		// Regression: a Set-based compare would call [a,a] and [a,b] equal.
		expect(sameAllow([entry("a"), entry("a")], [entry("a"), entry("b")])).toBe(
			false,
		);
	});

	it("distinguishes lists of different length", () => {
		expect(sameAllow([entry("a")], [entry("a"), entry("b")])).toBe(false);
	});
});

describe("normalizeAllow", () => {
	it("drops malformed entries and defaults the type", () => {
		expect(
			normalizeAllow([
				{ room_id: "!a:x", type: "m.room_membership" },
				{ room_id: "!b:x" },
				null,
				"garbage",
				{ type: "m.room_membership" },
				{ room_id: "" },
				// Unrecognized type string is coerced to the valid default.
				{ room_id: "!c:x", type: "bogus" },
			]),
		).toEqual([
			{ room_id: "!a:x", type: "m.room_membership" },
			{ room_id: "!b:x", type: "m.room_membership" },
			{ room_id: "!c:x", type: "m.room_membership" },
		]);
	});

	it("returns an empty array for non-array input", () => {
		expect(normalizeAllow(undefined)).toEqual([]);
		expect(normalizeAllow({})).toEqual([]);
	});

	it("collapses duplicate room IDs to the first occurrence", () => {
		expect(
			normalizeAllow([
				{ room_id: "!a:x", type: "m.room_membership" },
				{ room_id: "!a:x", type: "m.room_membership" },
				{ room_id: "!b:x", type: "m.room_membership" },
			]),
		).toEqual([
			{ room_id: "!a:x", type: "m.room_membership" },
			{ room_id: "!b:x", type: "m.room_membership" },
		]);
	});
});
