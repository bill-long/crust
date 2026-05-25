import type { MatrixEvent, Room, RoomMember } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { projectEvent } from "./useRoomSearch";

interface FakeEventInit {
	id?: string | null;
	redacted?: boolean;
	content?: Record<string, unknown>;
	sender?: string | null;
	ts?: number;
}

function makeEvent(init: FakeEventInit): MatrixEvent {
	const content = init.content ?? {};
	const id = "id" in init ? init.id : "$evt:test";
	return {
		getId: () => id ?? undefined,
		isRedacted: () => init.redacted ?? false,
		getContent: () => content,
		getSender: () => init.sender ?? "@alice:test",
		getTs: () => init.ts ?? 1000,
		getType: () => "m.room.message",
	} as unknown as MatrixEvent;
}

function makeRoom(members: Record<string, string>): Room {
	return {
		getMember: (userId: string) =>
			members[userId] ? ({ name: members[userId] } as RoomMember) : null,
	} as unknown as Room;
}

describe("projectEvent", () => {
	it("returns a SearchHit for a plain m.text message", () => {
		const ev = makeEvent({
			id: "$1:test",
			content: { msgtype: "m.text", body: "hello world" },
			sender: "@alice:test",
			ts: 1234,
		});
		const room = makeRoom({ "@alice:test": "Alice" });
		expect(projectEvent(room, ev)).toEqual({
			eventId: "$1:test",
			sender: "@alice:test",
			senderName: "Alice",
			timestamp: 1234,
			body: "hello world",
		});
	});

	it("accepts m.emote and m.notice", () => {
		const room = makeRoom({});
		expect(
			projectEvent(
				room,
				makeEvent({ content: { msgtype: "m.emote", body: "waves" } }),
			),
		).not.toBeNull();
		expect(
			projectEvent(
				room,
				makeEvent({ content: { msgtype: "m.notice", body: "fyi" } }),
			),
		).not.toBeNull();
	});

	it("rejects non-text msgtypes (m.image, m.file, m.video)", () => {
		const room = makeRoom({});
		for (const msgtype of ["m.image", "m.file", "m.video", "m.audio"]) {
			expect(
				projectEvent(room, makeEvent({ content: { msgtype, body: "x.png" } })),
			).toBeNull();
		}
	});

	it("rejects redacted events", () => {
		const room = makeRoom({});
		const ev = makeEvent({
			redacted: true,
			content: { msgtype: "m.text", body: "gone" },
		});
		expect(projectEvent(room, ev)).toBeNull();
	});

	it("rejects edit replacements (m.replace)", () => {
		const room = makeRoom({});
		const ev = makeEvent({
			content: {
				msgtype: "m.text",
				body: "* edited",
				"m.relates_to": { rel_type: "m.replace", event_id: "$orig:test" },
			},
		});
		expect(projectEvent(room, ev)).toBeNull();
	});

	it("allows replies (m.in_reply_to is not m.replace)", () => {
		const room = makeRoom({});
		const ev = makeEvent({
			content: {
				msgtype: "m.text",
				body: "responding",
				"m.relates_to": { "m.in_reply_to": { event_id: "$orig:test" } },
			},
		});
		expect(projectEvent(room, ev)).not.toBeNull();
	});

	it("rejects events without an id", () => {
		const ev = makeEvent({
			id: null,
			content: { msgtype: "m.text", body: "hello" },
		});
		expect(projectEvent(makeRoom({}), ev)).toBeNull();
	});

	it("rejects events with empty body", () => {
		const ev = makeEvent({ content: { msgtype: "m.text", body: "" } });
		expect(projectEvent(makeRoom({}), ev)).toBeNull();
	});

	it("rejects events with non-string body", () => {
		const ev = makeEvent({
			content: { msgtype: "m.text", body: 42 as unknown as string },
		});
		expect(projectEvent(makeRoom({}), ev)).toBeNull();
	});

	it("falls back to sender id when member display name is missing", () => {
		const room = makeRoom({});
		const ev = makeEvent({
			content: { msgtype: "m.text", body: "hi" },
			sender: "@stranger:test",
		});
		const hit = projectEvent(room, ev);
		expect(hit?.senderName).toBe("@stranger:test");
	});

	it("tolerates a null room (server-mode projection before room cache hydrates)", () => {
		const ev = makeEvent({
			content: { msgtype: "m.text", body: "hi" },
			sender: "@alice:test",
		});
		const hit = projectEvent(null, ev);
		expect(hit?.senderName).toBe("@alice:test");
	});
});
