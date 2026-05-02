import type { MatrixClient } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import {
	createMockClient,
	createMockRoom,
	encryptedMessage,
	textMessage,
} from "../../../test/mockClient";
import { useTimeline } from "./useTimeline";

/** Run a test inside createRoot with proper error propagation. */
function withRoot(fn: (dispose: () => void) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			try {
				await fn(dispose);
				dispose();
				resolve();
			} catch (e) {
				dispose();
				reject(e);
			}
		});
	});
}

describe("useTimeline", () => {
	it("loads events for the initial room", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			textMessage("!roomA:test", "$2", "@bob:test", "world", 2000),
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();

			expect(events.length).toBe(2);
			expect(events[0].body).toBe("hello");
			expect(events[1].body).toBe("world");
			expect(loading()).toBe(false);
		});
	});

	it("returns empty events for unknown room", async () => {
		const client = createMockClient(new Map());

		await withRoot(async (_dispose) => {
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				() => "!unknown:test",
			);

			await Promise.resolve();

			expect(events.length).toBe(0);
			expect(loading()).toBe(false);
		});
	});

	it("replaces events completely when room changes", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "room A msg", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B msg", 2000),
			textMessage("!roomB:test", "$b2", "@bob:test", "room B msg 2", 3000),
		]);

		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async (_dispose) => {
			const [roomId, setRoomId] = createSignal("!roomA:test");

			const { events } = useTimeline(client as unknown as MatrixClient, roomId);

			// Allow initial reactive effect to run
			await Promise.resolve();

			// Initial load: room A
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");
			expect(events[0].eventId).toBe("$a1");

			// Switch to room B
			setRoomId("!roomB:test");

			// Allow reactive effect to run
			await Promise.resolve();

			expect(events.length).toBe(2);
			expect(events[0].body).toBe("room B msg");
			expect(events[0].eventId).toBe("$b1");
			expect(events[1].body).toBe("room B msg 2");

			// No events from room A should remain
			const allBodies = Array.from(
				{ length: events.length },
				(_, i) => events[i].body,
			);
			expect(allBodies).not.toContain("room A msg");
		});
	});

	it("handles switching to a room with fewer events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$a2", "@alice:test", "msg 2", 2000),
			textMessage("!roomA:test", "$a3", "@alice:test", "msg 3", 3000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "only msg", 4000),
		]);

		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async (_dispose) => {
			const [roomId, setRoomId] = createSignal("!roomA:test");

			const { events } = useTimeline(client as unknown as MatrixClient, roomId);

			await Promise.resolve();
			expect(events.length).toBe(3);

			setRoomId("!roomB:test");
			await Promise.resolve();

			// Must be exactly 1 event, not 3 with stale trailing items
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("only msg");
		});
	});

	it("filters out non-displayable events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "visible", 1000),
			{
				eventId: "$2",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 2000,
			},
			{
				eventId: "$3",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "edit target",
					"m.relates_to": { rel_type: "m.replace", event_id: "$1" },
				},
				ts: 3000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();

			expect(events.length).toBe(1);
			expect(events[0].body).toBe("visible");
		});
	});

	it("includes encrypted events as displayable", async () => {
		const roomA = createMockRoom("!roomA:test", [
			encryptedMessage("!roomA:test", "$1", "@alice:test", 1000, true),
			textMessage("!roomA:test", "$2", "@bob:test", "normal", 2000),
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();

			expect(events.length).toBe(2);
			expect(events[0].isDecryptionFailure).toBe(true);
			expect(events[1].body).toBe("normal");
		});
	});

	it("loads events when room appears after initial empty load", async () => {
		// Room doesn't exist initially
		const client = createMockClient(new Map());

		await withRoot(async (_dispose) => {
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();

			// No room yet — empty
			expect(events.length).toBe(0);
			expect(loading()).toBe(false);

			// Room appears with messages
			const roomA = createMockRoom("!roomA:test", [
				textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			]);
			client.__setRooms(new Map([["!roomA:test", roomA]]));
			client.__emit("Room", roomA);

			await Promise.resolve();

			// Events should now be loaded
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("hello");
		});
	});

	it("does not reload when onRoomAppeared fires for an already-loaded room", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			// Spy on getRoom to count reload attempts
			let getRoomCalls = 0;
			const originalGetRoom = client.getRoom;
			client.getRoom = (roomId: string) => {
				getRoomCalls++;
				return originalGetRoom(roomId);
			};

			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();
			expect(events.length).toBe(1);
			const callsAfterInitialLoad = getRoomCalls;

			// Emit Room event again — should NOT reload (events already loaded)
			client.__emit("Room", roomA);
			await Promise.resolve();

			// getRoom should not have been called again
			expect(getRoomCalls).toBe(callsAfterInitialLoad);
			expect(events.length).toBe(1);
		});
	});

	it("reloads empty room when non-live timeline event arrives", async () => {
		// Room exists but has no events initially
		const roomA = createMockRoom("!roomA:test", []);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();
			expect(events.length).toBe(0);

			// Simulate backfill: room now has events, non-live event arrives
			const updatedRoom = createMockRoom("!roomA:test", [
				textMessage("!roomA:test", "$1", "@alice:test", "backfilled", 1000),
			]);
			client.__setRooms(new Map([["!roomA:test", updatedRoom]]));

			// Emit a non-live timeline event
			const fakeEvent = {
				getId: () => "$1",
				getRoomId: () => "!roomA:test",
				getSender: () => "@alice:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "backfilled" }),
				getTs: () => 1000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", fakeEvent, updatedRoom, false, false, {
				liveEvent: false,
			});

			await Promise.resolve();

			expect(events.length).toBe(1);
			expect(events[0].body).toBe("backfilled");
		});
	});

	it("non-live events do not cause reload when room already has events", async () => {
		// Room has displayable events
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "existing", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			let getRoomCalls = 0;
			const originalGetRoom = client.getRoom;
			client.getRoom = (roomId: string) => {
				getRoomCalls++;
				return originalGetRoom(roomId);
			};

			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();
			expect(events.length).toBe(1);
			const callsAfterLoad = getRoomCalls;

			// Emit a non-live timeline event for a room that already has events
			// The guard should skip reload (events.length > 0)
			const fakeEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@alice:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "backfilled" }),
				getTs: () => 500,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", fakeEvent, roomA, false, false, {
				liveEvent: false,
			});

			await Promise.resolve();

			// getRoom should NOT have been called — non-live event skipped
			expect(getRoomCalls).toBe(callsAfterLoad);
			// Events unchanged
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("existing");
		});
	});

	it("does not repeatedly reload on multiple non-live events for empty room", async () => {
		// Room has only non-displayable events
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 1000,
			},
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			let getRoomCalls = 0;
			const originalGetRoom = client.getRoom;
			client.getRoom = (roomId: string) => {
				getRoomCalls++;
				return originalGetRoom(roomId);
			};

			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await Promise.resolve();
			expect(events.length).toBe(0);
			const callsAfterLoad = getRoomCalls;

			const makeFakeEvent = (id: string, ts: number) => ({
				getId: () => id,
				getRoomId: () => "!roomA:test",
				getSender: () => "@alice:test",
				getType: () => "m.room.member",
				getContent: () => ({ membership: "join" }),
				getTs: () => ts,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			});

			// Emit 5 non-live events — should only reload once (not 5 times)
			for (let i = 0; i < 5; i++) {
				client.__emit(
					"Room.timeline",
					makeFakeEvent(`$evt${i}`, 2000 + i),
					roomA,
					false,
					false,
					{ liveEvent: false },
				);
			}

			await Promise.resolve();

			// Only 1 additional getRoom call (from the single backfill reload)
			expect(getRoomCalls - callsAfterLoad).toBe(1);
			expect(events.length).toBe(0);
		});
	});
});
