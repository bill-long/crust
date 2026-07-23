import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedMessageRow } from "./PinnedMessageRow";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

// The row under test owns resolution + jump wiring; body rendering has
// its own suite.
vi.mock("../../emoji/MessageBody", () => ({
	MessageBody: (props: { body: string }) => <span>{props.body}</span>,
}));

afterEach(() => {
	cleanup();
});

interface RawEvent {
	type: string;
	event_id: string;
	room_id: string;
	sender: string;
	origin_server_ts: number;
	content: Record<string, unknown>;
}

function rawMessage(
	eventId: string,
	content: Record<string, unknown>,
): RawEvent {
	return {
		type: "m.room.message",
		event_id: eventId,
		room_id: "!r:hs",
		sender: "@alice:hs",
		origin_server_ts: 1000,
		content,
	};
}

function makeRoom(overrides?: Partial<Room>): Room {
	return {
		roomId: "!r:hs",
		findEventById: () => undefined,
		getMember: () => ({ name: "Alice" }),
		getUnfilteredTimelineSet: () => ({}),
		...overrides,
	} as unknown as Room;
}

function makeClient(overrides?: Partial<MatrixClient>): MatrixClient {
	return {
		// Resolves without caching anything - the SDK's behavior for a
		// thread reply on a room timeline set (warn + null, no throw).
		getEventTimeline: vi.fn().mockResolvedValue(null),
		fetchRoomEvent: vi.fn().mockRejectedValue(new Error("not found")),
		decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as MatrixClient;
}

function renderRow(client: MatrixClient, room: Room, onJump = vi.fn()) {
	render(() => (
		<PinnedMessageRow
			client={client}
			room={room}
			eventId="$pinned:hs"
			canPin={false}
			shortcodeLookup={new Map()}
			tabIndex={0}
			onJump={onJump}
			onUnpin={() => {}}
		/>
	));
	return onJump;
}

describe("PinnedMessageRow", () => {
	it("falls back to a standalone fetch for a pinned thread reply and jumps with its root", async () => {
		const client = makeClient({
			fetchRoomEvent: vi.fn().mockResolvedValue(
				rawMessage("$pinned:hs", {
					msgtype: "m.text",
					body: "reply in a thread",
					"m.relates_to": {
						rel_type: "m.thread",
						event_id: "$root:hs",
						is_falling_back: true,
						"m.in_reply_to": { event_id: "$root:hs" },
					},
				}),
			) as MatrixClient["fetchRoomEvent"],
		});
		const onJump = renderRow(client, makeRoom());
		expect(await screen.findByText("reply in a thread")).toBeTruthy();
		fireEvent.click(screen.getByText("Jump to"));
		expect(onJump).toHaveBeenCalledWith("$root:hs");
	});

	it("jumps without a root for a cached main-timeline event", async () => {
		const cached = {
			getId: () => "$pinned:hs",
			getSender: () => "@alice:hs",
			getContent: () => ({ msgtype: "m.text", body: "plain pin" }),
			getTs: () => 1000,
			isRelation: () => false,
		} as unknown as MatrixEvent;
		const onJump = renderRow(
			makeClient(),
			makeRoom({ findEventById: () => cached }),
		);
		expect(await screen.findByText("plain pin")).toBeTruthy();
		fireEvent.click(screen.getByText("Jump to"));
		expect(onJump).toHaveBeenCalledWith(undefined);
	});

	it("shows the unavailable state when both resolution paths fail", async () => {
		renderRow(makeClient(), makeRoom());
		expect(await screen.findByText("(message unavailable)")).toBeTruthy();
	});
});
