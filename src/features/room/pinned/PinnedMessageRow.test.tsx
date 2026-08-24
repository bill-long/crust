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
		// The row subscribes to RoomEvent.Timeline to re-resolve when the
		// event arrives later (#485).
		on: vi.fn(),
		off: vi.fn(),
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

	it("still reaches the standalone fetch when getEventTimeline throws (#485)", async () => {
		// The real SDK throws synchronously when timelineSupport is off (the
		// #485 misconfiguration) - and can reject for other reasons too. The
		// row must not let that swallow the standalone fallback.
		const client = makeClient({
			getEventTimeline: vi
				.fn()
				.mockRejectedValue(
					new Error("timeline support is disabled."),
				) as MatrixClient["getEventTimeline"],
			fetchRoomEvent: vi.fn().mockResolvedValue(
				rawMessage("$pinned:hs", {
					msgtype: "m.text",
					body: "resolved despite the throw",
				}),
			) as MatrixClient["fetchRoomEvent"],
		});
		renderRow(client, makeRoom());
		expect(await screen.findByText("resolved despite the throw")).toBeTruthy();
	});

	it("re-resolves an open row when the event later arrives in the timeline (#485)", async () => {
		// Back-pagination while the panel is open used to leave the row on
		// "(message unavailable)" until close/reopen - the sync resolve was a
		// memo over non-reactive SDK state.
		const listeners = new Set<() => void>();
		let cached: unknown;
		const room = makeRoom({
			findEventById: (() => cached) as Room["findEventById"],
			on: vi.fn((_ev: unknown, cb: () => void) => {
				listeners.add(cb);
			}) as unknown as Room["on"],
			off: vi.fn() as unknown as Room["off"],
		});
		renderRow(makeClient(), room);
		expect(await screen.findByText("(message unavailable)")).toBeTruthy();
		// The event lands via back-pagination; the room emits Timeline.
		cached = {
			getSender: () => "@alice:hs",
			getContent: () => ({ msgtype: "m.text", body: "arrived late" }),
			getTs: () => 1000,
			getId: () => "$pinned:hs",
			isRelation: () => false,
		};
		for (const cb of listeners) cb();
		expect(await screen.findByText("arrived late")).toBeTruthy();
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

	it("Enter on the focused row jumps with the row-resolved thread root", async () => {
		const client = makeClient({
			fetchRoomEvent: vi.fn().mockResolvedValue(
				rawMessage("$pinned:hs", {
					msgtype: "m.text",
					body: "reply in a thread",
					"m.relates_to": { rel_type: "m.thread", event_id: "$root:hs" },
				}),
			) as MatrixClient["fetchRoomEvent"],
		});
		const onJump = renderRow(client, makeRoom());
		await screen.findByText("reply in a thread");
		fireEvent.keyDown(screen.getByRole("article"), { key: "Enter" });
		expect(onJump).toHaveBeenCalledWith("$root:hs");
	});

	it("Enter on an unavailable row is a no-op (no doomed main-timeline jump)", async () => {
		const onJump = renderRow(makeClient(), makeRoom());
		await screen.findByText("(message unavailable)");
		fireEvent.keyDown(screen.getByRole("article"), { key: "Enter" });
		expect(onJump).not.toHaveBeenCalled();
	});
});
