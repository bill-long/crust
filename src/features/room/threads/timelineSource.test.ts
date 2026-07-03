import type { EventTimeline, EventTimelineSet, Room } from "matrix-js-sdk";
import { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { mainTimelineSource, threadTimelineSource } from "./timelineSource";

function fakeSet(thread: unknown): EventTimelineSet {
	return { thread } as unknown as EventTimelineSet;
}

function dataFor(set: EventTimelineSet | undefined): {
	timeline?: EventTimeline;
} {
	return set
		? { timeline: { getTimelineSet: () => set } as unknown as EventTimeline }
		: {};
}

function threadReply(rootId: string): MatrixEvent {
	return new MatrixEvent({
		type: "m.room.message",
		event_id: "$reply",
		room_id: "!r:hs",
		sender: "@a:hs",
		origin_server_ts: 1,
		content: {
			msgtype: "m.text",
			body: "x",
			"m.relates_to": { rel_type: "m.thread", event_id: rootId },
		},
	});
}

function plainMessage(id: string): MatrixEvent {
	return new MatrixEvent({
		type: "m.room.message",
		event_id: id,
		room_id: "!r:hs",
		sender: "@a:hs",
		origin_server_ts: 1,
		content: { msgtype: "m.text", body: "hello" },
	});
}

describe("mainTimelineSource", () => {
	const src = mainTimelineSource();

	it("windows the room's unfiltered set", () => {
		const set = fakeSet(undefined);
		const room = {
			getUnfilteredTimelineSet: () => set,
		} as unknown as Room;
		expect(src.getTimelineSet(room)).toBe(set);
		expect(src.inThread).toBe(false);
		expect(src.key).toBe("main");
	});

	it("accepts room emissions and rejects thread ones", () => {
		expect(src.acceptsTimeline(dataFor(fakeSet(undefined)))).toBe(true);
		expect(src.acceptsTimeline(dataFor(fakeSet({ id: "$t" })))).toBe(false);
		expect(src.acceptsTimelineSet(fakeSet(undefined))).toBe(true);
		expect(src.acceptsTimelineSet(fakeSet({ id: "$t" }))).toBe(false);
		expect(src.acceptsTimelineSet(undefined)).toBe(true);
	});

	it("accepts plain events and rejects thread replies", () => {
		expect(src.acceptsEvent(plainMessage("$m"))).toBe(true);
		expect(src.acceptsEvent(threadReply("$root"))).toBe(false);
	});
});

describe("threadTimelineSource", () => {
	const src = threadTimelineSource("$root");

	it("windows its thread's timeline set (null when unmaterialized)", () => {
		const set = fakeSet({ id: "$root" });
		const room = {
			getThread: (id: string) => (id === "$root" ? { timelineSet: set } : null),
		} as unknown as Room;
		expect(src.getTimelineSet(room)).toBe(set);
		expect(
			src.getTimelineSet({
				getThread: () => null,
			} as unknown as Room),
		).toBeNull();
		expect(src.inThread).toBe(true);
		expect(src.key).toBe("thread:$root");
	});

	it("accepts only its own thread's emissions", () => {
		expect(src.acceptsTimeline(dataFor(fakeSet({ id: "$root" })))).toBe(true);
		expect(src.acceptsTimeline(dataFor(fakeSet({ id: "$other" })))).toBe(false);
		expect(src.acceptsTimeline(dataFor(fakeSet(undefined)))).toBe(false);
		expect(src.acceptsTimeline({})).toBe(false);
	});

	it("accepts the root, its replies, and attached relations only", () => {
		expect(src.acceptsEvent(threadReply("$root"))).toBe(true);
		expect(src.acceptsEvent(threadReply("$other"))).toBe(false);
		expect(src.acceptsEvent(plainMessage("$root"))).toBe(true);
		expect(src.acceptsEvent(plainMessage("$unrelated"))).toBe(false);
		// A reaction the SDK attached to this thread (threadRootId fallback).
		const reaction = new MatrixEvent({
			type: "m.reaction",
			event_id: "$re",
			room_id: "!r:hs",
			sender: "@a:hs",
			origin_server_ts: 1,
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$reply",
					key: "+1",
				},
			},
		});
		expect(src.acceptsEvent(reaction)).toBe(false);
		reaction.setThreadId("$root");
		expect(src.acceptsEvent(reaction)).toBe(true);
	});
});
