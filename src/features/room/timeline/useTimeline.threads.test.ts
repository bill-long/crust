import type { MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
	createMatrixEvent,
	createMockClient,
	createMockRoom,
	createMockThread,
	textMessage,
	threadReplyEvent,
} from "../../../test/mockClient";
import { threadTimelineSource } from "../threads/timelineSource";
import { useTimeline } from "./useTimeline";

const ROOM_ID = "!room:test";

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

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useTimeline thread gating", () => {
	it("does not render thread replies from the loaded window (stray backstop)", () =>
		withRoot(async () => {
			// With threadSupport on, the SDK keeps thread replies out of room
			// timeline sets - but if one slips through (degraded push, SDK
			// edge case), isDisplayable must reject it.
			const room = createMockRoom(ROOM_ID, [
				textMessage(ROOM_ID, "$root", "@a:hs", "root message", 1000),
				threadReplyEvent(
					ROOM_ID,
					"$reply",
					"@b:hs",
					"$root",
					"in thread",
					2000,
				),
				textMessage(ROOM_ID, "$after", "@a:hs", "after", 3000),
			]);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root", "$after"]);
		}));

	it("keeps rendering plain m.in_reply_to replies", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, [
				textMessage(ROOM_ID, "$parent", "@a:hs", "parent", 1000),
				{
					eventId: "$reply",
					roomId: ROOM_ID,
					sender: "@b:hs",
					type: "m.room.message",
					content: {
						msgtype: "m.text",
						body: "> quoted\n\na normal reply",
						"m.relates_to": { "m.in_reply_to": { event_id: "$parent" } },
					},
					ts: 2000,
				},
			]);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$parent", "$reply"]);
			expect(events[1].replyToId).toBe("$parent");
		}));

	it("ignores live emissions from thread timeline sets", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, [
				textMessage(ROOM_ID, "$root", "@a:hs", "root", 1000),
			]);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events.length).toBe(1);

			// A displayable-shaped event arriving via a THREAD timeline set
			// (thread timelines re-emit RoomEvent.Timeline through the
			// client) must not touch the main store - even if its own wire
			// shape looks main-timeline (e.g. an edit targeting a thread
			// reply carries m.replace, a plain text body could slip Gate S).
			const viaThread = createMatrixEvent(
				textMessage(ROOM_ID, "$sneaky", "@b:hs", "hello from a thread", 2000),
			);
			client.__emit("Room.timeline", viaThread, room, false, false, {
				liveEvent: true,
				timeline: {
					getTimelineSet: () => ({ thread: { id: "$root" } }),
				},
			});
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root"]);
		}));

	it("ignores live thread replies by shape even from a room timeline emission", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, [
				textMessage(ROOM_ID, "$root", "@a:hs", "root", 1000),
			]);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();

			const reply = createMatrixEvent(
				threadReplyEvent(
					ROOM_ID,
					"$treply",
					"@b:hs",
					"$root",
					"in thread",
					2000,
				),
			);
			client.__emit("Room.timeline", reply, room, false, false, {
				liveEvent: true,
			});
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root"]);
		}));

	it("projects a thread summary onto roots (provisional from the bundle)", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, [
				{
					...textMessage(ROOM_ID, "$root", "@a:hs", "root with thread", 1000),
					serverAggregations: {
						"m.thread": {
							count: 2,
							current_user_participated: false,
							latest_event: { sender: "@b:hs", origin_server_ts: 5000 },
						},
					},
				},
				textMessage(ROOM_ID, "$plain", "@a:hs", "no thread here", 2000),
			]);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events[0].thread).toMatchObject({
				threadId: "$root",
				replyCount: 2,
				latestSender: "@b:hs",
				provisional: true,
			});
			expect(events[1].thread).toBeNull();
		}));

	it("windows a thread's timeline with a thread source", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, [
				textMessage(ROOM_ID, "$other", "@a:hs", "main-only message", 500),
			]);
			const { thread } = createMockThread("$root", [
				textMessage(ROOM_ID, "$root", "@a:hs", "the root", 1000),
				threadReplyEvent(ROOM_ID, "$r1", "@b:hs", "$root", "first reply", 2000),
				threadReplyEvent(
					ROOM_ID,
					"$r2",
					"@c:hs",
					"$root",
					"second reply",
					3000,
				),
			]);
			room.threads.set("$root", thread);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				{ source: () => threadTimelineSource("$root") },
			);
			await flushPromises();
			// Thread replies ARE displayable inside the thread window, and
			// the fallback m.in_reply_to renders no quote block.
			expect(events.map((e) => e.eventId)).toEqual(["$root", "$r1", "$r2"]);
			expect(events[1].replyToId).toBeNull();
			// Main-room events don't leak in via live emissions.
			const mainEvent = createMatrixEvent(
				textMessage(ROOM_ID, "$live", "@a:hs", "main live", 4000),
			);
			client.__emit("Room.timeline", mainEvent, room, false, false, {
				liveEvent: true,
			});
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root", "$r1", "$r2"]);
		}));

	it("appends live replies arriving via the thread's timeline", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, []);
			const { thread, timeline, timelineSet } = createMockThread("$root", [
				textMessage(ROOM_ID, "$root", "@a:hs", "the root", 1000),
			]);
			room.threads.set("$root", thread);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				{ source: () => threadTimelineSource("$root") },
			);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root"]);

			const reply = createMatrixEvent(
				threadReplyEvent(ROOM_ID, "$r1", "@b:hs", "$root", "live reply", 2000),
			);
			timeline.__append(reply);
			client.__emit("Room.timeline", reply, room, false, false, {
				liveEvent: true,
				timeline: { getTimelineSet: () => timelineSet },
			});
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root", "$r1"]);
		}));
});
