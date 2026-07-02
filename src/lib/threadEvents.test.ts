import { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { isThreadReply, isThreadTimelineData } from "./threadEvents";

/** Real SDK events so the gates exercise the real threadRootId/isThreadRoot
 *  accessors (wire content first, attached-thread fallbacks second). */
function realEvent(
	content: Record<string, unknown>,
	overrides?: { type?: string; unsigned?: Record<string, unknown> },
): MatrixEvent {
	return new MatrixEvent({
		type: overrides?.type ?? "m.room.message",
		event_id: "$self",
		room_id: "!r:hs",
		sender: "@a:hs",
		origin_server_ts: 1,
		content,
		unsigned: overrides?.unsigned,
	});
}

describe("isThreadReply", () => {
	it("is true for a wire m.thread relation (MSC3440 shape)", () => {
		const ev = realEvent({
			msgtype: "m.text",
			body: "in thread",
			"m.relates_to": {
				rel_type: "m.thread",
				event_id: "$root",
				is_falling_back: true,
				"m.in_reply_to": { event_id: "$root" },
			},
		});
		expect(isThreadReply(ev)).toBe(true);
	});

	it("is false for a plain m.in_reply_to reply (must keep rendering)", () => {
		const ev = realEvent({
			msgtype: "m.text",
			body: "normal reply",
			"m.relates_to": { "m.in_reply_to": { event_id: "$parent" } },
		});
		expect(isThreadReply(ev)).toBe(false);
	});

	it("is false for a thread ROOT (bundled m.thread aggregation)", () => {
		const ev = realEvent(
			{ msgtype: "m.text", body: "root" },
			{
				unsigned: {
					"m.relations": {
						"m.thread": {
							count: 2,
							current_user_participated: false,
							latest_event: null,
						},
					},
				},
			},
		);
		expect(ev.isThreadRoot).toBe(true);
		expect(isThreadReply(ev)).toBe(false);
	});

	it("is false for an ordinary message and for state events", () => {
		expect(isThreadReply(realEvent({ msgtype: "m.text", body: "x" }))).toBe(
			false,
		);
		const state = new MatrixEvent({
			type: "m.room.member",
			state_key: "@a:hs",
			event_id: "$m",
			room_id: "!r:hs",
			sender: "@a:hs",
			origin_server_ts: 1,
			content: { membership: "join" },
		});
		expect(isThreadReply(state)).toBe(false);
	});

	it("is true for a relation the SDK attached to a thread (no wire m.thread)", () => {
		// A reaction targeting a thread reply carries m.annotation on the
		// wire; its thread membership arrives via setThreadId when the SDK
		// routes it into the thread.
		const reaction = realEvent(
			{
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$threadmsg",
					key: "👍",
				},
			},
			{ type: "m.reaction" },
		);
		expect(isThreadReply(reaction)).toBe(false);
		reaction.setThreadId("$root");
		expect(isThreadReply(reaction)).toBe(true);
	});
});

describe("isThreadTimelineData", () => {
	const timelineFor = (thread: unknown) =>
		({
			getTimelineSet: () => ({ thread }),
		}) as unknown as import("matrix-js-sdk").EventTimeline;

	it("is true for emissions from a thread timeline set", () => {
		expect(
			isThreadTimelineData({ timeline: timelineFor({ id: "$root" }) }),
		).toBe(true);
	});

	it("is false for room timeline sets and missing data", () => {
		expect(isThreadTimelineData({ timeline: timelineFor(undefined) })).toBe(
			false,
		);
		expect(isThreadTimelineData({})).toBe(false);
	});
});
