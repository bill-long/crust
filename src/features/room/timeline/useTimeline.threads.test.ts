import { EventStatus, type MatrixClient } from "matrix-js-sdk";
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
				{
					eventId: "$real",
					roomId: ROOM_ID,
					sender: "@d:hs",
					type: "m.room.message",
					content: {
						msgtype: "m.text",
						body: "quoting r1",
						"m.relates_to": {
							rel_type: "m.thread",
							event_id: "$root",
							is_falling_back: false,
							"m.in_reply_to": { event_id: "$r1" },
						},
					},
					ts: 3500,
				},
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
			expect(events.map((e) => e.eventId)).toEqual([
				"$root",
				"$r1",
				"$r2",
				"$real",
			]);
			expect(events[1].replyToId).toBeNull();
			// A REAL in-thread reply (is_falling_back: false) keeps its quote.
			expect(events[3].replyToId).toBe("$r1");
			// Main-room events don't leak in via live emissions.
			const mainEvent = createMatrixEvent(
				textMessage(ROOM_ID, "$live", "@a:hs", "main live", 4000),
			);
			client.__emit("Room.timeline", mainEvent, room, false, false, {
				liveEvent: true,
			});
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual([
				"$root",
				"$r1",
				"$r2",
				"$real",
			]);
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

	it("keeps a failed echo's chronological slot across window rebuilds", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, []);
			const { thread, timeline, timelineSet } = createMockThread("$root", [
				textMessage(ROOM_ID, "$root", "@a:hs", "the root", 1000),
				threadReplyEvent(ROOM_ID, "$r1", "@b:hs", "$root", "first", 2000),
			]);
			// Pretend older history exists so loadOlderMessages runs its
			// (mocked no-op) pagination and rebuilds the store from the window.
			timeline.getPaginationToken = () => "tok";
			room.threads.set("$root", thread);
			const client = createMockClient(new Map([[ROOM_ID, room]]));
			const { events, loadOlderMessages } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				{ source: () => threadTimelineSource("$root") },
			);
			await flushPromises();

			const echo = createMatrixEvent({
				...threadReplyEvent(
					ROOM_ID,
					"~txn1",
					"@me:hs",
					"$root",
					"will fail",
					3000,
				),
				status: EventStatus.SENDING,
			});
			client.__emit("Room.localEchoUpdated", echo, room);
			await flushPromises();
			echo.__setStatus(EventStatus.NOT_SENT);
			client.__emit("Room.localEchoUpdated", echo, room);
			await flushPromises();

			// A newer remote reply lands after the failure.
			const newer = createMatrixEvent(
				threadReplyEvent(ROOM_ID, "$r2", "@b:hs", "$root", "newer", 4000),
			);
			timeline.__append(newer);
			client.__emit("Room.timeline", newer, room, false, false, {
				liveEvent: true,
				timeline: { getTimelineSet: () => timelineSet },
			});
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual([
				"$root",
				"$r1",
				"~txn1",
				"$r2",
			]);

			// Any window rebuild (pagination here) must merge the re-injected
			// failed row by timestamp, not re-append it at the bottom.
			await loadOlderMessages();
			expect(events.map((e) => e.eventId)).toEqual([
				"$root",
				"$r1",
				"~txn1",
				"$r2",
			]);
			expect(events[2].status).toBe(EventStatus.NOT_SENT);
		}));

	it("keeps a failed thread echo retryable across panel close/reopen", () =>
		withRoot(async () => {
			const room = createMockRoom(ROOM_ID, []);
			const { thread } = createMockThread("$root", [
				textMessage(ROOM_ID, "$root", "@a:hs", "the root", 1000),
			]);
			room.threads.set("$root", thread);
			const client = createMockClient(new Map([[ROOM_ID, room]]));

			// First mount (panel open): a send fails, then the panel closes
			// (hook disposal) with the FAILED row unresolved.
			const echo = createMatrixEvent({
				...threadReplyEvent(
					ROOM_ID,
					"~txn1",
					"@me:hs",
					"$root",
					"will fail",
					2000,
				),
				status: EventStatus.SENDING,
			});
			await new Promise<void>((resolve, reject) => {
				createRoot(async (dispose) => {
					try {
						const { events } = useTimeline(
							client as unknown as MatrixClient,
							() => ROOM_ID,
							{ source: () => threadTimelineSource("$root") },
						);
						await flushPromises();
						client.__emit("Room.localEchoUpdated", echo, room);
						await flushPromises();
						echo.__setStatus(EventStatus.NOT_SENT);
						client.__emit("Room.localEchoUpdated", echo, room);
						await flushPromises();
						expect(events.map((e) => e.eventId)).toEqual(["$root", "~txn1"]);
						dispose();
						resolve();
					} catch (e) {
						dispose();
						reject(e);
					}
				});
			});

			// Reopen: a fresh hook over the same thread rehydrates the FAILED
			// row from the persistent registry (thread echoes live in no SDK
			// timeline, so nothing else could restore it).
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				{ source: () => threadTimelineSource("$root") },
			);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root", "~txn1"]);
			expect(events[1].status).toBe(EventStatus.NOT_SENT);

			// Once resolved (discarded here), a later reopen shows no stale row.
			echo.__setStatus(EventStatus.CANCELLED);
			client.__emit("Room.localEchoUpdated", echo, room);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root"]);
			await new Promise<void>((resolve, reject) => {
				createRoot(async (dispose) => {
					try {
						const { events: reopened } = useTimeline(
							client as unknown as MatrixClient,
							() => ROOM_ID,
							{ source: () => threadTimelineSource("$root") },
						);
						await flushPromises();
						expect(reopened.map((e) => e.eventId)).toEqual(["$root"]);
						dispose();
						resolve();
					} catch (e) {
						dispose();
						reject(e);
					}
				});
			});
		}));

	it("injects, rekeys, and cancels thread-send local echoes", () =>
		withRoot(async () => {
			// Under Chronological ordering a thread send's pending echo lives
			// in NO timeline, so the store must inject it from
			// LocalEchoUpdated and reconcile the rekey/cancel itself.
			const room = createMockRoom(ROOM_ID, []);
			const { thread } = createMockThread("$root", [
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

			const echo = createMatrixEvent({
				...threadReplyEvent(
					ROOM_ID,
					"~txn1",
					"@me:hs",
					"$root",
					"sending…",
					2000,
				),
				status: EventStatus.SENDING,
			});
			client.__emit("Room.localEchoUpdated", echo, room);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root", "~txn1"]);
			expect(events[1].status).toBe(EventStatus.SENDING);

			// Remote confirmation: the SDK rekeys the same event object and
			// re-emits with the old id.
			echo.__setId("$confirmed");
			echo.__setStatus(null);
			client.__emit("Room.localEchoUpdated", echo, room, "~txn1");
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root", "$confirmed"]);
			expect(events[1].status).toBeNull();

			// A second, discarded echo: CANCELLED drops the injected row.
			const echo2 = createMatrixEvent({
				...threadReplyEvent(ROOM_ID, "~txn2", "@me:hs", "$root", "oops", 3000),
				status: EventStatus.SENDING,
			});
			client.__emit("Room.localEchoUpdated", echo2, room);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual([
				"$root",
				"$confirmed",
				"~txn2",
			]);
			echo2.__setStatus(EventStatus.CANCELLED);
			client.__emit("Room.localEchoUpdated", echo2, room);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$root", "$confirmed"]);
		}));
});
