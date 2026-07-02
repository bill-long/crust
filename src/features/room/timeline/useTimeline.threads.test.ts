import type { MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
	createMatrixEvent,
	createMockClient,
	createMockRoom,
	textMessage,
	threadReplyEvent,
} from "../../../test/mockClient";
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
	it("does not render thread replies from the loaded window (fail-closed backstop)", () =>
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
});
