import type { MatrixClient } from "matrix-js-sdk";
import {
	createEffect,
	createRoot,
	createSignal,
	getOwner,
	runWithOwner,
} from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	createMatrixEvent,
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

/** Wait for pending promise handlers (TimelineWindow.load() and its .then()/.catch()) */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Create a fake SDK-like event for live event emissions in tests */
function createFakeEvent(
	roomId: string,
	eventId: string,
	sender: string,
	body: string,
	ts: number,
	type = "m.room.message",
	content?: Record<string, unknown>,
) {
	return createMatrixEvent({
		eventId,
		roomId,
		sender,
		type,
		content: content ?? { msgtype: "m.text", body },
		ts,
	});
}

/** Append event to mock timeline and emit as live event */
function appendLive(
	client: ReturnType<typeof createMockClient>,
	room: ReturnType<typeof createMockRoom>,
	event: ReturnType<typeof createFakeEvent>,
) {
	const timeline = room.getLiveTimeline();
	timeline.__append(
		event as unknown as Parameters<typeof timeline.__append>[0],
	);
	client.__emit("Room.timeline", event, room, false, false, {
		liveEvent: true,
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

			await flushPromises();

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

			await flushPromises();

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
			await flushPromises();

			// Initial load: room A
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");
			expect(events[0].eventId).toBe("$a1");

			// Switch to room B
			setRoomId("!roomB:test");

			// Allow reactive effect to run
			await flushPromises();

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

			await flushPromises();
			expect(events.length).toBe(3);

			setRoomId("!roomB:test");
			await flushPromises();

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

			await flushPromises();

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

			await flushPromises();

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

			await flushPromises();

			// No room yet — empty
			expect(events.length).toBe(0);
			expect(loading()).toBe(false);

			// Room appears with messages
			const roomA = createMockRoom("!roomA:test", [
				textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			]);
			client.__setRooms(new Map([["!roomA:test", roomA]]));
			client.__emit("Room", roomA);

			await flushPromises();

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

			await flushPromises();
			expect(events.length).toBe(1);
			const callsAfterInitialLoad = getRoomCalls;

			// Emit Room event again — should NOT reload (events already loaded)
			client.__emit("Room", roomA);
			await flushPromises();

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

			await flushPromises();
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

			await flushPromises();

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

			await flushPromises();
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

			await flushPromises();

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

			await flushPromises();
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

			await flushPromises();

			// Only 1 additional getRoom call (from the single backfill reload)
			expect(getRoomCalls - callsAfterLoad).toBe(1);
			expect(events.length).toBe(0);
		});
	});

	it("loadOlderMessages fetches and prepends older events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$3", "@alice:test", "recent", 3000),
		]);
		// Set pagination token before useTimeline initializes
		roomA.getLiveTimeline().getPaginationToken = () => "token-1";

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		// Mock paginateEventTimeline to simulate adding older events
		client.paginateEventTimeline = vi.fn().mockImplementation(async () => {
			const room = client.getRoom("!roomA:test");
			if (room) {
				const timeline = room.getLiveTimeline();
				const olderEvent = {
					getId: () => "$1",
					getRoomId: () => "!roomA:test",
					getSender: () => "@bob:test",
					getType: () => "m.room.message",
					getContent: () => ({ msgtype: "m.text", body: "older msg" }),
					getTs: () => 1000,
					isEncrypted: () => false,
					isDecryptionFailure: () => false,
					replacingEventId: () => null,
					event: { redacts: undefined },
				};
				// Use __prepend to properly track baseIndex for TimelineWindow
				timeline.__prepend(
					olderEvent as unknown as Parameters<typeof timeline.__prepend>[0],
				);
				timeline.getPaginationToken = () => "token-2";
			}
			return true; // hasMore
		});

		await withRoot(async () => {
			const { events, loadOlderMessages, canLoadOlder, loadingOlder } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("recent");
			expect(canLoadOlder()).toBe(true);

			await loadOlderMessages();
			await flushPromises();

			expect(events.length).toBe(2);
			expect(events[0].body).toBe("older msg");
			expect(events[1].body).toBe("recent");
			expect(loadingOlder()).toBe(false);
			expect(canLoadOlder()).toBe(true);
		});
	});

	it("discards stale pagination results after A→B→A room switch", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "room A msg", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B msg", 2000),
		]);
		// Room A has a pagination token
		roomA.getLiveTimeline().getPaginationToken = () => "token-a";

		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		// paginateEventTimeline will resolve after a delay, simulating network.
		// When it resolves, it mutates room A's timeline with an older event.
		let resolvePagination!: (value: boolean) => void;
		client.paginateEventTimeline = vi.fn().mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					resolvePagination = (val: boolean) => {
						// Simulate SDK prepending older events to the timeline
						const timeline = roomA.getLiveTimeline();
						const staleEvent = {
							getId: () => "$stale",
							getRoomId: () => "!roomA:test",
							getSender: () => "@old:test",
							getType: () => "m.room.message",
							getContent: () => ({
								msgtype: "m.text",
								body: "STALE - should not appear",
							}),
							getTs: () => 500,
							isEncrypted: () => false,
							isDecryptionFailure: () => false,
							replacingEventId: () => null,
							event: { redacts: undefined },
						};
						// Use __prepend to properly track baseIndex
						timeline.__prepend(
							staleEvent as unknown as Parameters<typeof timeline.__prepend>[0],
						);
						resolve(val);
					};
				}),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!roomA:test");
			const { events, loadOlderMessages } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");

			// Start pagination for room A (will hang until we resolve)
			const paginationPromise = loadOlderMessages();

			// Switch to room B while pagination is in flight
			setRoomId("!roomB:test");
			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B msg");

			// Switch back to room A (A→B→A)
			setRoomId("!roomA:test");
			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");

			// Now resolve the stale pagination from the first visit to A
			resolvePagination(true);
			await paginationPromise;
			await flushPromises();

			// Events should still be room A's current state — stale pagination
			// result must NOT be applied (generation counter should catch it)
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");
		});
	});

	it("withholds live events when followingLive is false", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(canLoadNewer()).toBe(false);

			// Stop following live (user scrolled up)
			setFollowingLive(false);

			// Simulate a live message arriving
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "new msg" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});

			await flushPromises();

			// Event should NOT be added to the store
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("initial");
			// canLoadNewer should be set
			expect(canLoadNewer()).toBe(true);
		});
	});

	it("canLoadNewer is set for non-displayable skipped events too", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			setFollowingLive(false);

			// Simulate a live reaction (non-displayable) arriving
			const reactionEvent = {
				getId: () => "$r1",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.reaction",
				getContent: () => ({
					"m.relates_to": {
						rel_type: "m.annotation",
						event_id: "$1",
						key: "👍",
					},
				}),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", reactionEvent, roomA, false, false, {
				liveEvent: true,
			});

			await flushPromises();

			// canLoadNewer should still be set (non-displayable events count)
			expect(canLoadNewer()).toBe(true);
			// Store unchanged
			expect(events.length).toBe(1);
		});
	});

	it("jumpToLive reloads from live end and resets state", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, loading, setFollowingLive, jumpToLive } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);

			// Stop following, simulate withheld event
			setFollowingLive(false);
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "new msg" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			// Append to the underlying timeline so it's available after reload
			const timeline = roomA.getLiveTimeline();
			timeline.__append(
				liveEvent as unknown as Parameters<typeof timeline.__append>[0],
			);
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});

			await flushPromises();
			expect(canLoadNewer()).toBe(true);
			expect(events.length).toBe(1);

			// Jump to live
			jumpToLive();
			await flushPromises();

			// Should reload and show both events
			expect(canLoadNewer()).toBe(false);
			expect(loading()).toBe(false);
			expect(events.length).toBe(2);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("new msg");
		});
	});

	it("setFollowingLive(true) auto-jumps when behind live", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			setFollowingLive(false);

			// Simulate withheld live event
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "new msg" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			const timeline = roomA.getLiveTimeline();
			timeline.__append(
				liveEvent as unknown as Parameters<typeof timeline.__append>[0],
			);
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});
			await flushPromises();
			expect(canLoadNewer()).toBe(true);

			// Setting followingLive back to true should trigger jumpToLive
			setFollowingLive(true);
			await flushPromises();

			expect(canLoadNewer()).toBe(false);
			expect(events.length).toBe(2);
			expect(events[1].body).toBe("new msg");
		});
	});

	it("room switch resets followingLive and canLoadNewer", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "room A", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B", 2000),
		]);
		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!roomA:test");
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);

			await flushPromises();
			setFollowingLive(false);

			// Simulate withheld event in room A
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "withheld" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});
			await flushPromises();
			expect(canLoadNewer()).toBe(true);

			// Switch to room B — should reset all forward pagination state
			setRoomId("!roomB:test");
			await flushPromises();

			expect(canLoadNewer()).toBe(false);
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B");
		});
	});

	it("live events resume when followingLive is restored without pending newer", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			// Stop following, then resume without any events arriving
			setFollowingLive(false);
			setFollowingLive(true);
			expect(canLoadNewer()).toBe(false);

			// Now a live event should be handled normally
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$2", "@bob:test", "live msg", 2000),
			);

			await flushPromises();

			// Event should be added normally
			expect(events.length).toBe(2);
			expect(events[1].body).toBe("live msg");
		});
	});

	it("loadNewerMessages paginates forward and shows newer events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$2", "@alice:test", "msg 2", 2000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const {
				events,
				canLoadNewer,
				loadingNewer,
				setFollowingLive,
				loadNewerMessages,
				getWindowEvents,
			} = useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(2);
			expect(canLoadNewer()).toBe(false);

			// Stop following live (user scrolled up)
			setFollowingLive(false);

			// Simulate 3 live events arriving while scrolled up
			for (let i = 3; i <= 5; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$${i}`,
						"@bob:test",
						`msg ${i}`,
						i * 1000,
					),
				);
			}

			await flushPromises();
			expect(events.length).toBe(2); // withheld
			expect(canLoadNewer()).toBe(true);

			// Forward paginate to catch up
			await loadNewerMessages();
			await flushPromises();

			// All 5 events should now be visible
			expect(events.length).toBe(5);
			expect(events[2].body).toBe("msg 3");
			expect(events[3].body).toBe("msg 4");
			expect(events[4].body).toBe("msg 5");
			expect(loadingNewer()).toBe(false);
			expect(canLoadNewer()).toBe(false);
			// Window should contain all events
			expect(getWindowEvents().length).toBe(5);
		});
	});

	it("loadNewerMessages catches up then view restores followingLive for live events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive, loadNewerMessages } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);

			setFollowingLive(false);

			// 2 live events arrive while scrolled up
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$2", "@bob:test", "withheld 1", 2000),
			);
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$3", "@bob:test", "withheld 2", 3000),
			);

			await flushPromises();
			expect(canLoadNewer()).toBe(true);
			expect(events.length).toBe(1);

			// Catch up via forward pagination
			await loadNewerMessages();
			await flushPromises();

			expect(canLoadNewer()).toBe(false);
			expect(events.length).toBe(3);

			// loadNewerMessages does NOT restore followingLive — the view
			// drives that transition via the [atBottom, canLoadNewer] effect.
			// Simulate the view re-enabling following after catch-up.
			setFollowingLive(true);

			// New live events should now appear immediately
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$4",
					"@bob:test",
					"live after catchup",
					4000,
				),
			);

			await flushPromises();

			expect(events.length).toBe(4);
			expect(events[3].body).toBe("live after catchup");
			expect(canLoadNewer()).toBe(false);
		});
	});

	it("loadNewerMessages handles partial catch-up requiring multiple pages", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$0", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive, loadNewerMessages } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);

			setFollowingLive(false);

			// Append 55 events (more than PAGINATION_SIZE=50 in useTimeline.ts)
			for (let i = 1; i <= 55; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$new${i}`,
						"@bob:test",
						`new msg ${i}`,
						2000 + i,
					),
				);
			}

			await flushPromises();
			expect(canLoadNewer()).toBe(true);
			expect(events.length).toBe(1);

			// First forward pagination — picks up 50 of 55 withheld events
			await loadNewerMessages();
			await flushPromises();

			expect(events.length).toBe(51); // 1 initial + 50 paginated
			expect(canLoadNewer()).toBe(true); // 5 remaining

			// Second forward pagination — picks up remaining 5
			await loadNewerMessages();
			await flushPromises();

			expect(events.length).toBe(56); // 1 initial + 55 total
			expect(canLoadNewer()).toBe(false); // fully caught up
		});
	});

	it("loadNewerMessages only includes displayable events after forward pagination", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, setFollowingLive, loadNewerMessages, getWindowEvents } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			setFollowingLive(false);

			// Append displayable events
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$2", "@bob:test", "msg 2", 2000),
			);
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$3", "@bob:test", "msg 3", 3000),
			);

			// Append non-displayable: state event
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$s1",
					"@alice:test",
					"",
					3500,
					"m.room.member",
					{ membership: "join" },
				),
			);

			// Append non-displayable: reaction
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$r1",
					"@bob:test",
					"",
					3600,
					"m.reaction",
					{
						"m.relates_to": {
							rel_type: "m.annotation",
							event_id: "$1",
							key: "👍",
						},
					},
				),
			);

			// Append one more displayable
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$4", "@bob:test", "msg 4", 4000),
			);

			await flushPromises();

			await loadNewerMessages();
			await flushPromises();

			// Window has all 6 events (initial + 3 messages + 1 state + 1 reaction)
			expect(getWindowEvents().length).toBe(6);
			// Store has only displayable events
			expect(events.length).toBe(4);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("msg 2");
			expect(events[2].body).toBe("msg 3");
			expect(events[3].body).toBe("msg 4");
		});
	});

	it("syncStoreEviction trims store events evicted from window", async () => {
		// Use a small windowLimit to make eviction testable with few events.
		// Initial events fill the window; non-displayable live events then
		// trigger eviction, and the store must stay in sync.
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$2", "@alice:test", "msg 2", 2000),
			textMessage("!roomA:test", "$3", "@alice:test", "msg 3", 3000),
			textMessage("!roomA:test", "$4", "@alice:test", "msg 4", 4000),
			textMessage("!roomA:test", "$5", "@alice:test", "msg 5", 5000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, getWindowEvents } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
				{ windowLimit: 5, initialWindowSize: 5 },
			);

			await flushPromises();
			expect(events.length).toBe(5);
			expect(events[0].body).toBe("msg 1");

			// Emit non-displayable live events to trigger eviction.
			// Each extends the window by 1 and evicts 1 from the oldest end.
			for (let i = 1; i <= 3; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$s${i}`,
						"@alice:test",
						"",
						6000 + i,
						"m.room.member",
						{ membership: "join" },
					),
				);
			}

			await flushPromises();

			// Window evicted $1, $2, $3 (replaced by 3 state events).
			// Store must also have trimmed those events.
			expect(events[0].body).toBe("msg 4");
			expect(events[1].body).toBe("msg 5");
			expect(events.length).toBe(2);

			// Every store event must exist in the window
			const windowIds = new Set(getWindowEvents().map((e) => e.getId()));
			for (let i = 0; i < events.length; i++) {
				expect(windowIds.has(events[i].eventId)).toBe(true);
			}
		});
	});

	it("syncStoreEviction is a no-op below window capacity", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$2", "@alice:test", "msg 2", 2000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
				{ windowLimit: 10, initialWindowSize: 10 },
			);

			await flushPromises();
			expect(events.length).toBe(2);

			// Add live events — window is well below capacity, no eviction
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$3", "@bob:test", "msg 3", 3000),
			);

			await flushPromises();

			// All events remain (no eviction, no trimming)
			expect(events.length).toBe(3);
			expect(events[0].body).toBe("msg 1");
			expect(events[2].body).toBe("msg 3");
		});
	});

	it("captures live events arriving during loadRoom() async gap", async () => {
		// Regression test for the microtask race: loadRoom() sets
		// currentTimelineWindow = null before tw.load().then() publishes
		// the window. A live event firing in that gap must not be lost.
		// We use jumpToLive() to trigger loadRoom() after the initial
		// load has completed, creating the null-window gap.
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			// jumpToLive calls loadRoom synchronously, which sets
			// currentTimelineWindow = null and queues .then() as a microtask.
			jumpToLive();

			// Fire a live event during the gap (window is null).
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$live", "@bob:test", "gap msg", 2000),
			);

			await flushPromises();

			// Both the initial event and the gap event must appear
			expect(events.length).toBe(2);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("gap msg");
		});
	});

	it("captures multiple live events during loadRoom() async gap", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			jumpToLive();

			// Fire 3 live events during the gap
			for (let i = 1; i <= 3; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$live${i}`,
						"@bob:test",
						`gap msg ${i}`,
						1000 + i,
					),
				);
			}

			await flushPromises();

			expect(events.length).toBe(4);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("gap msg 1");
			expect(events[2].body).toBe("gap msg 2");
			expect(events[3].body).toBe("gap msg 3");
		});
	});

	it("non-displayable live events during loadRoom() gap do not create bogus store entries", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			jumpToLive();

			// Fire a non-displayable event (state) during the gap
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$state",
					"@alice:test",
					"",
					2000,
					"m.room.member",
					{ membership: "join" },
				),
			);

			await flushPromises();

			// Only the initial displayable event should be in the store
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("initial");
		});
	});

	it("store event IDs match displayable window event IDs after mixed live traffic", async () => {
		// Invariant test: after a burst of mixed displayable and non-displayable
		// live events that trigger eviction, the store must exactly equal the
		// displayable events in the window.
		const initialEvents = [];
		for (let i = 1; i <= 8; i++) {
			initialEvents.push(
				textMessage(
					"!roomA:test",
					`$${i}`,
					"@alice:test",
					`msg ${i}`,
					i * 1000,
				),
			);
		}
		const roomA = createMockRoom("!roomA:test", initialEvents);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, getWindowEvents } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
				{ windowLimit: 8, initialWindowSize: 8 },
			);

			await flushPromises();
			expect(events.length).toBe(8);

			// Mixed burst: 3 displayable + 5 non-displayable = 8 events
			// Window evicts 8 from the oldest end, replacing with new events.
			for (let i = 1; i <= 5; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$state${i}`,
						"@alice:test",
						"",
						10000 + i,
						"m.room.member",
						{ membership: "join" },
					),
				);
			}
			for (let i = 1; i <= 3; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$new${i}`,
						"@bob:test",
						`new msg ${i}`,
						20000 + i,
					),
				);
			}

			await flushPromises();

			// Invariant: store IDs === displayable window IDs
			const windowEvents = getWindowEvents();
			const displayableWindowIds = windowEvents
				.filter(
					(e) => e.getType() === "m.room.message" && e.getContent()?.msgtype,
				)
				.map((e) => e.getId());
			const storeIds = Array.from(
				{ length: events.length },
				(_, i) => events[i].eventId,
			);
			expect(storeIds).toEqual(displayableWindowIds);
		});
	});

	it("canLoadOlder is set before loading becomes false (signal ordering)", async () => {
		// Regression guard: dependents must never observe the transient state
		// (loading=false, canLoadOlder=false, events.length > 0) when the
		// room actually has backward pagination available. loadRoom must set
		// canLoadOlder before setting loading=false.
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			textMessage("!roomA:test", "$2", "@bob:test", "world", 2000),
		]);
		// Simulate a room with older messages available
		roomA.__setPaginationToken("t_backward");
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const owner = getOwner();
			if (!owner) throw new Error("Expected Solid owner inside createRoot");
			const { events, loading, canLoadOlder, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(loading()).toBe(false);
			expect(events.length).toBe(2);
			expect(canLoadOlder()).toBe(true);

			// Capture signal states at every reactive notification during reload.
			// createEffect tracks both signals, so it fires whenever either changes.
			// Use runWithOwner to keep the effect inside the root (avoids leak
			// after await boundaries lose Solid's owner context).
			const states: { loading: boolean; canLoadOlder: boolean }[] = [];
			runWithOwner(owner, () => {
				createEffect(() => {
					states.push({
						loading: loading(),
						canLoadOlder: canLoadOlder(),
					});
				});
			});

			// jumpToLive → loadRoom resets canLoadOlder=false and loading=true,
			// then .then() must set canLoadOlder=true before setting loading=false.
			jumpToLive();
			await flushPromises();

			// Verify the invariant: every state where loading=false must also
			// have canLoadOlder=true (since the room has a pagination token).
			// If the ordering were wrong (loading=false set first), we'd see
			// a transient {loading: false, canLoadOlder: false}.
			const loadDoneStates = states.filter((s) => !s.loading);
			expect(loadDoneStates.length).toBeGreaterThan(0);
			for (const s of loadDoneStates) {
				expect(s.canLoadOlder).toBe(true);
			}
		});
	});

	it("room switch clears events immediately (no stale events during load)", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "room A", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B", 2000),
		]);
		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!roomA:test");
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(loading()).toBe(false);

			// Switch rooms — events must be cleared synchronously so
			// stale room A events are never visible under room B's header.
			setRoomId("!roomB:test");

			// Before promises flush: events cleared, loading true
			expect(events.length).toBe(0);
			expect(loading()).toBe(true);

			await flushPromises();

			// After load: room B events
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B");
			expect(loading()).toBe(false);
		});
	});

	it("jumpToLive preserves events during same-room reload (no spinner flash)", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, loading, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(loading()).toBe(false);

			// jumpToLive reloads the same room — events must stay so the
			// view doesn't flash a spinner.
			jumpToLive();

			// Before promises flush: loading true, but events still present
			expect(loading()).toBe(true);
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("hello");

			await flushPromises();

			expect(loading()).toBe(false);
			expect(events.length).toBe(1);
		});
	});
});
