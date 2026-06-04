import type { MatrixEvent, Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	buildStateNotice,
	isStateNoticeType,
	STATE_NOTICE_TYPES,
} from "./stateNotice";

interface FakeEventInit {
	type: string;
	sender?: string;
	stateKey?: string;
	content?: Record<string, unknown>;
	prevContent?: Record<string, unknown>;
	redacted?: boolean;
}

function makeEvent(init: FakeEventInit): MatrixEvent {
	const e = {
		getType: () => init.type,
		getSender: () => init.sender ?? "@alice:test",
		getStateKey: () => init.stateKey,
		getContent: () => init.content ?? {},
		getPrevContent: () => init.prevContent ?? {},
		isRedacted: () => init.redacted ?? false,
	};
	return e as unknown as MatrixEvent;
}

function makeRoom(memberNames: Record<string, string> = {}): Room {
	const r = {
		getMember: (id: string) =>
			memberNames[id] ? { name: memberNames[id] } : null,
	};
	return r as unknown as Room;
}

describe("stateNotice", () => {
	it("recognises the supported state event types", () => {
		expect(STATE_NOTICE_TYPES.has("m.room.member")).toBe(true);
		expect(STATE_NOTICE_TYPES.has("m.room.message")).toBe(false);
		expect(isStateNoticeType("m.room.name")).toBe(true);
		expect(isStateNoticeType("m.reaction")).toBe(false);
	});

	it("returns null for unsupported types", () => {
		expect(
			buildStateNotice(makeEvent({ type: "m.reaction" }), makeRoom()),
		).toBe(null);
	});

	it("returns null for redacted state events", () => {
		expect(
			buildStateNotice(
				makeEvent({
					type: "m.room.name",
					content: {},
					redacted: true,
				}),
				makeRoom(),
			),
		).toBe(null);
	});

	it("returns null for member events with no state key", () => {
		expect(
			buildStateNotice(
				makeEvent({ type: "m.room.member", content: { membership: "join" } }),
				makeRoom(),
			),
		).toBe(null);
	});

	describe("m.room.member", () => {
		it("renders a fresh join", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "join", displayname: "Bob" },
					prevContent: {},
				}),
				makeRoom(),
			);
			expect(notice?.text).toBe("Bob joined the room");
		});

		it("renders a leave→join as a join", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "join", displayname: "Bob" },
					prevContent: { membership: "leave" },
				}),
				makeRoom(),
			);
			expect(notice?.text).toBe("Bob joined the room");
		});

		it("renders a self-leave", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "leave" },
					prevContent: { membership: "join", displayname: "Bob" },
				}),
				makeRoom(),
			);
			expect(notice?.text).toBe("Bob left the room");
		});

		it("renders a kick (sender ≠ subject)", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@alice:test",
					stateKey: "@bob:test",
					content: { membership: "leave" },
					prevContent: { membership: "join", displayname: "Bob" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(notice?.text).toBe("Bob was removed by Alice");
		});

		it("renders rejected invite (subject leaves their own invite)", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "leave" },
					prevContent: { membership: "invite" },
				}),
				makeRoom({ "@bob:test": "Bob" }),
			);
			expect(notice?.text).toBe("Bob rejected the invite");
		});

		it("renders withdrawn invite (someone else cancels)", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@alice:test",
					stateKey: "@bob:test",
					content: { membership: "leave" },
					prevContent: { membership: "invite" },
				}),
				makeRoom({ "@alice:test": "Alice", "@bob:test": "Bob" }),
			);
			expect(notice?.text).toBe("Alice withdrew the invite to Bob");
		});

		it("renders ban and unban", () => {
			const ban = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@alice:test",
					stateKey: "@bob:test",
					content: { membership: "ban" },
					prevContent: { membership: "join", displayname: "Bob" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(ban?.text).toBe("Bob was banned by Alice");
			const unban = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@alice:test",
					stateKey: "@bob:test",
					content: { membership: "leave" },
					prevContent: { membership: "ban" },
				}),
				makeRoom({ "@alice:test": "Alice", "@bob:test": "Bob" }),
			);
			expect(unban?.text).toBe("Bob was unbanned by Alice");
		});

		it("renders invite and knock", () => {
			const invite = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@alice:test",
					stateKey: "@bob:test",
					content: { membership: "invite", displayname: "Bob" },
					prevContent: {},
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(invite?.text).toBe("Alice invited Bob");
			const knock = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "knock", displayname: "Bob" },
					prevContent: {},
				}),
				makeRoom(),
			);
			expect(knock?.text).toBe("Bob requested to join");
		});

		it("renders display-name and avatar profile changes", () => {
			const name = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "join", displayname: "Robert" },
					prevContent: { membership: "join", displayname: "Bob" },
				}),
				makeRoom(),
			);
			expect(name?.text).toBe("Bob changed their name to Robert");
			const setAvatar = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: {
						membership: "join",
						displayname: "Bob",
						avatar_url: "mxc://x/y",
					},
					prevContent: { membership: "join", displayname: "Bob" },
				}),
				makeRoom(),
			);
			expect(setAvatar?.text).toBe("Bob set their avatar");
		});

		it("uses the matrix ID when first setting a display name (avoids 'Robert set their display name to Robert')", () => {
			const setName = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@robert:test",
					stateKey: "@robert:test",
					content: { membership: "join", displayname: "Robert" },
					prevContent: { membership: "join" },
				}),
				makeRoom(),
			);
			expect(setName?.text).toBe(
				"@robert:test set their display name to Robert",
			);
		});

		it("uses the prior display name when removing it", () => {
			const removeName = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "join" },
					prevContent: { membership: "join", displayname: "Bob" },
				}),
				makeRoom(),
			);
			expect(removeName?.text).toBe("Bob removed their display name");
		});

		it("returns null for a no-op join→join with identical profile", () => {
			expect(
				buildStateNotice(
					makeEvent({
						type: "m.room.member",
						sender: "@bob:test",
						stateKey: "@bob:test",
						content: { membership: "join", displayname: "Bob" },
						prevContent: { membership: "join", displayname: "Bob" },
					}),
					makeRoom(),
				),
			).toBe(null);
		});

		it("falls back to historical displayname when member has left", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: "m.room.member",
					sender: "@bob:test",
					stateKey: "@bob:test",
					content: { membership: "leave" },
					prevContent: { membership: "join", displayname: "OldBob" },
				}),
				makeRoom(),
			);
			expect(notice?.text).toBe("OldBob left the room");
		});
	});

	describe("m.room.name", () => {
		it("renders an add, change, and remove", () => {
			const add = buildStateNotice(
				makeEvent({
					type: "m.room.name",
					content: { name: "Hello" },
					prevContent: {},
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(add?.text).toBe('Alice changed the room name to "Hello"');
			const change = buildStateNotice(
				makeEvent({
					type: "m.room.name",
					content: { name: "World" },
					prevContent: { name: "Hello" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(change?.text).toBe('Alice changed the room name to "World"');
			const remove = buildStateNotice(
				makeEvent({
					type: "m.room.name",
					content: {},
					prevContent: { name: "Hello" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(remove?.text).toBe("Alice removed the room name");
		});

		it("returns null for a no-op write", () => {
			expect(
				buildStateNotice(
					makeEvent({
						type: "m.room.name",
						content: { name: "Same" },
						prevContent: { name: "Same" },
					}),
					makeRoom(),
				),
			).toBe(null);
		});
	});

	describe("m.room.topic", () => {
		it("renders changes and removals", () => {
			const set = buildStateNotice(
				makeEvent({
					type: "m.room.topic",
					content: { topic: "About foo" },
					prevContent: {},
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(set?.text).toBe('Alice changed the topic to "About foo"');
			const remove = buildStateNotice(
				makeEvent({
					type: "m.room.topic",
					content: {},
					prevContent: { topic: "About foo" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(remove?.text).toBe("Alice removed the topic");
		});
	});

	describe("m.room.avatar", () => {
		it("renders set, change, and remove", () => {
			const set = buildStateNotice(
				makeEvent({
					type: "m.room.avatar",
					content: { url: "mxc://a/b" },
					prevContent: {},
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(set?.text).toBe("Alice set the room avatar");
			const change = buildStateNotice(
				makeEvent({
					type: "m.room.avatar",
					content: { url: "mxc://a/c" },
					prevContent: { url: "mxc://a/b" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(change?.text).toBe("Alice changed the room avatar");
			const remove = buildStateNotice(
				makeEvent({
					type: "m.room.avatar",
					content: {},
					prevContent: { url: "mxc://a/b" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(remove?.text).toBe("Alice removed the room avatar");
		});
	});

	describe("m.room.encryption", () => {
		it("renders enabling encryption once and ignores re-writes", () => {
			const enable = buildStateNotice(
				makeEvent({
					type: "m.room.encryption",
					content: { algorithm: "m.megolm.v1.aes-sha2" },
					prevContent: {},
				}),
				makeRoom(),
			);
			expect(enable?.text).toBe("Encryption was enabled");
			expect(
				buildStateNotice(
					makeEvent({
						type: "m.room.encryption",
						content: { algorithm: "m.megolm.v1.aes-sha2" },
						prevContent: { algorithm: "m.megolm.v1.aes-sha2" },
					}),
					makeRoom(),
				),
			).toBe(null);
		});
	});

	describe("m.room.canonical_alias", () => {
		it("renders set and remove", () => {
			const set = buildStateNotice(
				makeEvent({
					type: "m.room.canonical_alias",
					content: { alias: "#room:test" },
					prevContent: {},
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(set?.text).toBe("Alice set the main address to #room:test");
			const remove = buildStateNotice(
				makeEvent({
					type: "m.room.canonical_alias",
					content: {},
					prevContent: { alias: "#room:test" },
				}),
				makeRoom({ "@alice:test": "Alice" }),
			);
			expect(remove?.text).toBe("Alice removed the main address");
		});
	});

	describe("m.room.tombstone", () => {
		it("renders with and without a reason", () => {
			expect(
				buildStateNotice(
					makeEvent({
						type: "m.room.tombstone",
						content: { body: "Moved to v11" },
					}),
					makeRoom(),
				)?.text,
			).toBe("This room has been upgraded: Moved to v11");
			expect(
				buildStateNotice(
					makeEvent({ type: "m.room.tombstone", content: {} }),
					makeRoom(),
				)?.text,
			).toBe("This room has been upgraded");
		});
	});
});
