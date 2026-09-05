import type { MatrixEvent, Room, RoomMember } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { projectEvent } from "./searchProjection";

interface FakeEventInit {
	id?: string | null;
	redacted?: boolean;
	content?: unknown;
	sender?: string | null;
	ts?: number;
	omitContentGetter?: boolean;
	omitTimestampGetter?: boolean;
}

function makeEvent(init: FakeEventInit = {}): MatrixEvent {
	const content = "content" in init ? init.content : {};
	const record =
		typeof content === "object" && content !== null
			? (content as Record<string, unknown>)
			: {};
	const relates = record["m.relates_to"] as
		| { rel_type?: string; event_id?: string }
		| undefined;
	const event = {
		getId: () => ("id" in init ? (init.id ?? undefined) : "$evt:test"),
		isRedacted: () => init.redacted ?? false,
		getSender: () => init.sender ?? "@alice:test",
		getType: () => "m.room.message",
		isRelation: (relType?: string) =>
			!!(
				relates?.rel_type &&
				relates.event_id &&
				(relType ? relates.rel_type === relType : true)
			),
		threadRootId:
			relates?.rel_type === "m.thread" ? relates.event_id : undefined,
	} as Record<string, unknown>;
	if (!init.omitContentGetter) event.getContent = () => content;
	if (!init.omitTimestampGetter) event.getTs = () => init.ts ?? 1000;
	return event as unknown as MatrixEvent;
}

function makeRoom(members: Record<string, string>): Room {
	return {
		getMember: (userId: string) =>
			members[userId] ? ({ name: members[userId] } as RoomMember) : null,
	} as unknown as Room;
}

describe("projectEvent", () => {
	it("projects a text event with its resolved sender and timestamp", () => {
		const event = makeEvent({
			id: "$message:test",
			content: { msgtype: "m.text", body: "hello world" },
			sender: "@alice:test",
			ts: 1234,
		});

		expect(projectEvent(makeRoom({ "@alice:test": "Alice" }), event)).toEqual({
			eventId: "$message:test",
			sender: "@alice:test",
			senderName: "Alice",
			timestamp: 1234,
			body: "hello world",
		});
	});

	it.each(["m.text", "m.emote", "m.notice"])(
		"accepts the text msgtype %s",
		(msgtype) => {
			expect(
				projectEvent(
					makeRoom({}),
					makeEvent({ content: { msgtype, body: "visible" } }),
				),
			).not.toBeNull();
		},
	);

	it.each(["m.image", "m.file", "m.video", "m.audio", "m.location"])(
		"rejects the non-text msgtype %s",
		(msgtype) => {
			expect(
				projectEvent(
					makeRoom({}),
					makeEvent({ content: { msgtype, body: "not searchable" } }),
				),
			).toBeNull();
		},
	);

	it.each([
		["missing content getter", { omitContentGetter: true }],
		["null content", { content: null }],
		["primitive content", { content: "not an object" }],
		["missing msgtype", { content: { body: "hello" } }],
		["non-string msgtype", { content: { msgtype: 42, body: "hello" } }],
		["missing body", { content: { msgtype: "m.text" } }],
		["empty body", { content: { msgtype: "m.text", body: "" } }],
		["non-string body", { content: { msgtype: "m.text", body: 42 } }],
	] satisfies ReadonlyArray<readonly [string, FakeEventInit]>)(
		"rejects malformed input with %s",
		(_label, init) => {
			expect(projectEvent(makeRoom({}), makeEvent(init))).toBeNull();
		},
	);

	it("rejects events without an id", () => {
		expect(
			projectEvent(
				makeRoom({}),
				makeEvent({
					id: null,
					content: { msgtype: "m.text", body: "hello" },
				}),
			),
		).toBeNull();
	});

	it("rejects redactions and edit replacement events", () => {
		const content = { msgtype: "m.text", body: "gone" };
		expect(
			projectEvent(makeRoom({}), makeEvent({ redacted: true, content })),
		).toBeNull();
		expect(
			projectEvent(
				makeRoom({}),
				makeEvent({
					content: {
						...content,
						"m.relates_to": {
							rel_type: "m.replace",
							event_id: "$original:test",
						},
					},
				}),
			),
		).toBeNull();
	});

	it("keeps ordinary replies in the main-timeline search route", () => {
		const hit = projectEvent(
			makeRoom({}),
			makeEvent({
				content: {
					msgtype: "m.text",
					body: "responding",
					"m.relates_to": {
						"m.in_reply_to": { event_id: "$original:test" },
					},
				},
			}),
		);
		expect(hit?.threadRootId).toBeUndefined();
	});

	it("ignores a malformed relation instead of dropping an otherwise valid hit", () => {
		expect(
			projectEvent(
				makeRoom({}),
				makeEvent({
					content: {
						msgtype: "m.text",
						body: "still searchable",
						"m.relates_to": "m.replace",
					},
				}),
			),
		).toMatchObject({ body: "still searchable" });
	});

	it("carries a thread reply root for panel routing", () => {
		const hit = projectEvent(
			makeRoom({}),
			makeEvent({
				content: {
					msgtype: "m.text",
					body: "in a thread",
					"m.relates_to": {
						rel_type: "m.thread",
						event_id: "$root:test",
					},
				},
			}),
		);
		expect(hit?.threadRootId).toBe("$root:test");
	});

	it("falls back safely when room metadata or optional event data is missing", () => {
		const event = makeEvent({
			content: { msgtype: "m.text", body: "hello" },
			sender: "@stranger:test",
			omitTimestampGetter: true,
		});
		expect(projectEvent(makeRoom({}), event)).toMatchObject({
			senderName: "@stranger:test",
			timestamp: 0,
		});
		expect(projectEvent(null, event)).toMatchObject({
			senderName: "@stranger:test",
			timestamp: 0,
		});
	});
});
