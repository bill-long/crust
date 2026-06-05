import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import {
	EventType,
	JoinRule,
	type MatrixClient,
	RoomStateEvent,
} from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { JoinRuleSection } from "./JoinRuleSection";

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
});
