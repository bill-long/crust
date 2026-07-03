import { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { isThreadReply, isThreadTimelineData } from "./threadEvents";

/** Real SDK events so the gates exercise the real isRelation predicate
 *  (wire content, state-event exclusion, single latched relation name). */
function realEvent(
	content: Record<string, unknown>,
	overrides?: {
		type?: string;
		unsigned?: Record<string, unknown>;
		stateKey?: string;
	},
): MatrixEvent {
	return new MatrixEvent({
		type: overrides?.type ?? "m.room.message",
		event_id: "$self",
		room_id: "!r:hs",
		sender: "@a:hs",
		origin_server_ts: 1,
		content,
		unsigned: overrides?.unsigned,
		...(overrides?.stateKey !== undefined
			? { state_key: overrides.stateKey }
			: {}),
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

	it("is false for state events, even with a thread-shaped relation", () => {
		// The SDK's isRelation explicitly rejects m.thread on state events;
		// eventShouldLiveIn keeps them in the room timeline.
		const state = realEvent(
			{
				membership: "join",
				"m.relates_to": { rel_type: "m.thread", event_id: "$root" },
			},
			{ type: "m.room.member", stateKey: "@a:hs" },
		);
		expect(isThreadReply(state)).toBe(false);
	});

	it("stays false for events the SDK merely ATTACHED to a thread", () => {
		// The SDK dual-homes some events into both the room and the thread
		// (e.g. a plain reply to a thread root) and attaches `.thread` /
		// a thread id to them - they are main-timeline citizens. Only the
		// wire m.thread relation is thread-only; relations arriving via
		// thread timelines are Gate T's job.
		const reaction = realEvent(
			{
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$threadmsg",
					key: "+1",
				},
			},
			{ type: "m.reaction" },
		);
		reaction.setThreadId("$root");
		expect(isThreadReply(reaction)).toBe(false);

		const replyToRoot = realEvent({
			msgtype: "m.text",
			body: "reply to a thread root",
			"m.relates_to": { "m.in_reply_to": { event_id: "$root" } },
		});
		replyToRoot.setThreadId("$root");
		expect(isThreadReply(replyToRoot)).toBe(false);
	});

	it("tracks the SDK's latched relation name, not a hardcoded list", () => {
		// The SDK partitions on exactly ONE name (THREAD_RELATION_TYPE.name,
		// stable "m.thread" here). An event carrying the pre-stable
		// io.element.thread name is NOT partitioned - it stays in the room
		// timeline - so the gate must not hide it either.
		const ev = realEvent({
			msgtype: "m.text",
			body: "legacy-name thread reply",
			"m.relates_to": { rel_type: "io.element.thread", event_id: "$root" },
		});
		expect(ev.isRelation("m.thread")).toBe(false);
		expect(isThreadReply(ev)).toBe(false);
	});

	it("is false when the relation lacks an event_id (malformed)", () => {
		const ev = realEvent({
			msgtype: "m.text",
			body: "malformed",
			"m.relates_to": { rel_type: "m.thread" },
		});
		expect(isThreadReply(ev)).toBe(false);
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
