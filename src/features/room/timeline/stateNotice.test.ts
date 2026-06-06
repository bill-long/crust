import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	buildMembershipTransition,
	buildStateNotice,
	computeCallTimelineNotices,
	iconForTransitionKind,
	isStateNoticeType,
	type MembershipTransitionKind,
	STATE_NOTICE_TYPES,
} from "./stateNotice";

interface FakeEventInit {
	type: string;
	sender?: string;
	stateKey?: string;
	content?: Record<string, unknown>;
	prevContent?: Record<string, unknown>;
	redacted?: boolean;
	id?: string;
	ts?: number;
}

function makeEvent(init: FakeEventInit): MatrixEvent {
	const e = {
		getType: () => init.type,
		getSender: () => init.sender ?? "@alice:test",
		getStateKey: () => init.stateKey,
		getContent: () => init.content ?? {},
		getPrevContent: () => init.prevContent ?? {},
		isRedacted: () => init.redacted ?? false,
		getId: () => init.id,
		getTs: () => init.ts ?? 0,
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

	describe("call membership (org.matrix.msc3401.call.member)", () => {
		const CALL = "org.matrix.msc3401.call.member";
		const room = makeRoom({ "@alice:test": "Alice" });
		// A well-formed modern MSC4143 per-device membership.
		const FLAT = {
			application: "m.call",
			call_id: "",
			device_id: "DEV",
			focus_active: { type: "livekit" },
		};

		it("is a recognised notice type", () => {
			expect(STATE_NOTICE_TYPES.has(CALL)).toBe(true);
			expect(isStateNoticeType(CALL)).toBe(true);
		});

		it("renders a join for the modern MSC4143 flat shape", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: CALL,
					stateKey: "_@alice:test_DEV",
					sender: "@alice:test",
					content: { ...FLAT },
					prevContent: {},
				}),
				room,
			);
			expect(notice?.text).toBe("Alice joined the call");
		});

		it("renders a leave when the membership is emptied", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: CALL,
					stateKey: "_@alice:test_DEV",
					sender: "@alice:test",
					content: {},
					prevContent: { ...FLAT },
				}),
				room,
			);
			expect(notice?.text).toBe("Alice left the call");
		});

		it("renders a join for the legacy nested m.calls shape", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: CALL,
					sender: "@alice:test",
					content: { "m.calls": [{ "m.call_id": "x" }] },
					prevContent: {},
				}),
				room,
			);
			expect(notice?.text).toBe("Alice joined the call");
		});

		it("returns null for a membership refresh (still present)", () => {
			expect(
				buildStateNotice(
					makeEvent({
						type: CALL,
						sender: "@alice:test",
						content: { ...FLAT },
						prevContent: { ...FLAT },
					}),
					room,
				),
			).toBeNull();
		});

		it("returns null for an empty->empty no-op", () => {
			expect(
				buildStateNotice(
					makeEvent({
						type: CALL,
						sender: "@alice:test",
						content: {},
						prevContent: {},
					}),
					room,
				),
			).toBeNull();
		});

		it("ignores a malformed flat membership missing required fields", () => {
			// Missing call_id/device_id entirely.
			expect(
				buildStateNotice(
					makeEvent({
						type: CALL,
						sender: "@alice:test",
						content: { application: "m.call" },
						prevContent: {},
					}),
					room,
				),
			).toBeNull();
			// Present ids but missing focus_active.type (not a valid membership).
			expect(
				buildStateNotice(
					makeEvent({
						type: CALL,
						sender: "@alice:test",
						content: { application: "m.call", call_id: "", device_id: "DEV" },
						prevContent: {},
					}),
					room,
				),
			).toBeNull();
		});

		it("falls back to the bare matrix id when the member is unknown", () => {
			const notice = buildStateNotice(
				makeEvent({
					type: CALL,
					sender: "@ghost:test",
					content: { ...FLAT },
					prevContent: {},
				}),
				makeRoom(),
			);
			expect(notice?.text).toBe("@ghost:test joined the call");
		});

		it("returns null for a call event with no sender", () => {
			const e = {
				getType: () => CALL,
				getSender: () => null,
				getStateKey: () => "_x",
				getContent: () => ({ ...FLAT }),
				getPrevContent: () => ({}),
				isRedacted: () => false,
			} as unknown as MatrixEvent;
			expect(buildStateNotice(e, room)).toBeNull();
		});
	});
});

describe("buildMembershipTransition", () => {
	const fakeClient = {
		mxcUrlToHttp: (mxc: string) => (mxc ? `http://media/${mxc}` : null),
	} as unknown as MatrixClient;

	function classify(init: FakeEventInit, room = makeRoom()) {
		return buildMembershipTransition(makeEvent(init), room, fakeClient);
	}

	it("classifies a fresh join", () => {
		const t = classify({
			type: "m.room.member",
			stateKey: "@bob:test",
			sender: "@bob:test",
			content: { membership: "join", displayname: "Bob" },
			prevContent: { membership: "leave" },
		});
		expect(t).toMatchObject({ kind: "join", subject: "Bob" });
	});

	it("classifies a self leave", () => {
		const t = classify({
			type: "m.room.member",
			stateKey: "@bob:test",
			sender: "@bob:test",
			content: { membership: "leave" },
			prevContent: { membership: "join", displayname: "Bob" },
		});
		expect(t?.kind).toBe("leave");
	});

	it("classifies a kick (left by someone else)", () => {
		const t = classify({
			type: "m.room.member",
			stateKey: "@bob:test",
			sender: "@alice:test",
			content: { membership: "leave" },
			prevContent: { membership: "join", displayname: "Bob" },
		});
		expect(t?.kind).toBe("kick");
	});

	it("classifies an invite and a ban", () => {
		expect(
			classify({
				type: "m.room.member",
				stateKey: "@bob:test",
				content: { membership: "invite", displayname: "Bob" },
			})?.kind,
		).toBe("invite");
		expect(
			classify({
				type: "m.room.member",
				stateKey: "@bob:test",
				content: { membership: "ban" },
				prevContent: { membership: "join" },
			})?.kind,
		).toBe("ban");
	});

	it("does not classify profile-only changes, invite withdrawals, or unbans", () => {
		// Profile change while joined.
		expect(
			classify({
				type: "m.room.member",
				stateKey: "@bob:test",
				content: { membership: "join", displayname: "Bobby" },
				prevContent: { membership: "join", displayname: "Bob" },
			}),
		).toBeNull();
		// Invite rejected / withdrawn.
		expect(
			classify({
				type: "m.room.member",
				stateKey: "@bob:test",
				content: { membership: "leave" },
				prevContent: { membership: "invite" },
			}),
		).toBeNull();
		// Unban.
		expect(
			classify({
				type: "m.room.member",
				stateKey: "@bob:test",
				content: { membership: "leave" },
				prevContent: { membership: "ban" },
			}),
		).toBeNull();
	});

	it("returns null for non-member events", () => {
		expect(
			classify({ type: "m.room.name", content: { name: "x" } }),
		).toBeNull();
	});

	it("resolves an avatar from the event content", () => {
		const t = classify({
			type: "m.room.member",
			stateKey: "@bob:test",
			sender: "@bob:test",
			content: {
				membership: "join",
				displayname: "Bob",
				avatar_url: "mxc://server/abc",
			},
			prevContent: { membership: "leave" },
		});
		expect(t?.avatarUrl).toBe("http://media/mxc://server/abc");
	});

	it("classifies call joins and leaves with the sender as subject", () => {
		const CALL = "org.matrix.msc3401.call.member";
		const FLAT = {
			application: "m.call",
			call_id: "",
			device_id: "DEV",
			focus_active: { type: "livekit" },
		};
		const join = classify(
			{
				type: CALL,
				stateKey: "_@bob:test_DEV",
				sender: "@bob:test",
				content: { ...FLAT },
				prevContent: {},
			},
			makeRoom({ "@bob:test": "Bob" }),
		);
		expect(join).toMatchObject({
			kind: "call_join",
			userId: "@bob:test",
			subject: "Bob",
		});
		const leave = classify(
			{
				type: CALL,
				stateKey: "_@bob:test_DEV",
				sender: "@bob:test",
				content: {},
				prevContent: { ...FLAT },
			},
			makeRoom({ "@bob:test": "Bob" }),
		);
		expect(leave?.kind).toBe("call_leave");
	});

	it("does not classify a call-membership refresh", () => {
		const FLAT = {
			application: "m.call",
			call_id: "",
			device_id: "DEV",
			focus_active: { type: "livekit" },
		};
		expect(
			classify({
				type: "org.matrix.msc3401.call.member",
				sender: "@bob:test",
				content: { ...FLAT },
				prevContent: { ...FLAT },
			}),
		).toBeNull();
	});

	it("returns null for a call transition with no sender", () => {
		const e = {
			getType: () => "org.matrix.msc3401.call.member",
			getSender: () => null,
			getStateKey: () => "_x",
			getContent: () => ({
				application: "m.call",
				call_id: "",
				device_id: "DEV",
				focus_active: { type: "livekit" },
			}),
			getPrevContent: () => ({}),
			isRedacted: () => false,
		} as unknown as MatrixEvent;
		expect(buildMembershipTransition(e, makeRoom(), fakeClient)).toBeNull();
	});
});

describe("state notice icons", () => {
	const CALL = "org.matrix.msc3401.call.member";
	const callRoom = makeRoom({ "@alice:test": "Alice" });

	function iconFor(init: FakeEventInit, room = makeRoom()) {
		return buildStateNotice(makeEvent(init), room)?.icon;
	}

	it("uses the join glyph for arrivals", () => {
		expect(
			iconFor({
				type: "m.room.member",
				sender: "@bob:test",
				stateKey: "@bob:test",
				content: { membership: "join", displayname: "Bob" },
				prevContent: { membership: "leave" },
			}),
		).toBe("join");
		// An invite brings a member in → join glyph.
		expect(
			iconFor({
				type: "m.room.member",
				sender: "@alice:test",
				stateKey: "@bob:test",
				content: { membership: "invite", displayname: "Bob" },
			}),
		).toBe("join");
		expect(
			iconFor(
				{
					type: CALL,
					stateKey: "_@alice:test_DEV",
					sender: "@alice:test",
					content: {
						application: "m.call",
						call_id: "",
						device_id: "DEV",
						focus_active: { type: "livekit" },
					},
					prevContent: {},
				},
				callRoom,
			),
		).toBe("join");
	});

	it("uses the leave glyph for departures", () => {
		// Self leave.
		expect(
			iconFor({
				type: "m.room.member",
				sender: "@bob:test",
				stateKey: "@bob:test",
				content: { membership: "leave" },
				prevContent: { membership: "join", displayname: "Bob" },
			}),
		).toBe("leave");
		// Kick (left by someone else).
		expect(
			iconFor({
				type: "m.room.member",
				sender: "@alice:test",
				stateKey: "@bob:test",
				content: { membership: "leave" },
				prevContent: { membership: "join", displayname: "Bob" },
			}),
		).toBe("leave");
		// Ban.
		expect(
			iconFor({
				type: "m.room.member",
				sender: "@alice:test",
				stateKey: "@bob:test",
				content: { membership: "ban" },
				prevContent: { membership: "join", displayname: "Bob" },
			}),
		).toBe("leave");
		// Call leave.
		expect(
			iconFor(
				{
					type: CALL,
					stateKey: "_@alice:test_DEV",
					sender: "@alice:test",
					content: {},
					prevContent: {
						application: "m.call",
						call_id: "",
						device_id: "DEV",
						focus_active: { type: "livekit" },
					},
				},
				callRoom,
			),
		).toBe("leave");
	});

	it("uses the info glyph for non-membership and profile changes", () => {
		// Display-name change while joined.
		expect(
			iconFor({
				type: "m.room.member",
				sender: "@bob:test",
				stateKey: "@bob:test",
				content: { membership: "join", displayname: "Bobby" },
				prevContent: { membership: "join", displayname: "Bob" },
			}),
		).toBe("info");
		// Invite rejected by the invitee.
		expect(
			iconFor({
				type: "m.room.member",
				sender: "@bob:test",
				stateKey: "@bob:test",
				content: { membership: "leave" },
				prevContent: { membership: "invite", displayname: "Bob" },
			}),
		).toBe("info");
		// Room name change.
		expect(
			iconFor({
				type: "m.room.name",
				sender: "@alice:test",
				content: { name: "New" },
				prevContent: { name: "Old" },
			}),
		).toBe("info");
		// Encryption enabled.
		expect(
			iconFor({
				type: "m.room.encryption",
				sender: "@alice:test",
				content: { algorithm: "m.megolm.v1.aes-sha2" },
				prevContent: {},
			}),
		).toBe("info");
	});

	it("maps every grouping transition kind to a glyph", () => {
		const cases: Record<MembershipTransitionKind, "join" | "leave"> = {
			join: "join",
			invite: "join",
			call_join: "join",
			leave: "leave",
			kick: "leave",
			ban: "leave",
			call_leave: "leave",
		};
		for (const [kind, expected] of Object.entries(cases)) {
			expect(iconForTransitionKind(kind as MembershipTransitionKind)).toBe(
				expected,
			);
		}
	});
});

describe("computeCallTimelineNotices — suppression", () => {
	const CALL = "org.matrix.msc3401.call.member";

	function callBlob(deviceId: string): Record<string, unknown> {
		return {
			application: "m.call",
			call_id: "",
			device_id: deviceId,
			focus_active: { type: "livekit" },
		};
	}

	function join(id: string, sender: string, deviceId: string): MatrixEvent {
		return makeEvent({
			type: CALL,
			id,
			sender,
			content: callBlob(deviceId),
			prevContent: {},
		});
	}

	function leave(id: string, sender: string, deviceId: string): MatrixEvent {
		return makeEvent({
			type: CALL,
			id,
			sender,
			content: {},
			prevContent: callBlob(deviceId),
		});
	}

	// All events default to ts 0; `now: 0` keeps every membership unexpired so
	// these cases exercise explicit-leave suppression only.
	function suppressedFor(events: MatrixEvent[]): Set<string> {
		return computeCallTimelineNotices(events, 0).suppressed;
	}

	it("does not suppress a lone join or its matching last-device leave", () => {
		const ids = suppressedFor([
			join("j1", "@alice:test", "A"),
			leave("l1", "@alice:test", "A"),
		]);
		expect(ids.size).toBe(0);
	});

	it("suppresses a duplicate join from a second device", () => {
		const ids = suppressedFor([
			join("j1", "@alice:test", "A"),
			join("j2", "@alice:test", "B"),
		]);
		expect([...ids]).toEqual(["j2"]);
	});

	it("suppresses a premature leave while another device stays in the call", () => {
		// Alice joins from A and B, then A leaves (B still live), then B leaves.
		const ids = suppressedFor([
			join("j1", "@alice:test", "A"),
			join("j2", "@alice:test", "B"),
			leave("l1", "@alice:test", "A"),
			leave("l2", "@alice:test", "B"),
		]);
		// j2 (dup join) and l1 (premature leave) hidden; j1 + l2 (last) shown.
		expect([...ids].sort()).toEqual(["j2", "l1"]);
	});

	it("tracks per-user liveness independently", () => {
		const ids = suppressedFor([
			join("aj", "@alice:test", "A"),
			join("bj", "@bob:test", "B"),
			leave("al", "@alice:test", "A"),
			leave("bl", "@bob:test", "B"),
		]);
		// Each user's single device join/leave is their first/last → nothing hidden.
		expect(ids.size).toBe(0);
	});

	it("re-shows a join after the user fully left and rejoined", () => {
		const ids = suppressedFor([
			join("j1", "@alice:test", "A"),
			leave("l1", "@alice:test", "A"),
			join("j2", "@alice:test", "A"),
		]);
		expect(ids.size).toBe(0);
	});

	it("ignores non-call events and events with no sender", () => {
		const noSender = makeEvent({
			type: CALL,
			id: "x",
			sender: undefined,
			content: callBlob("A"),
			prevContent: {},
		});
		// getSender defaults to @alice in the helper, so force it null here.
		(noSender as unknown as { getSender: () => string | null }).getSender =
			() => null;
		const ids = suppressedFor([
			makeEvent({ type: "m.room.message", id: "m1" }),
			noSender,
		]);
		expect(ids.size).toBe(0);
	});

	it("ignores redacted call-member events in liveness", () => {
		// Alice's device-A join is redacted, so it must not occupy her liveness;
		// the device-B join is then her first live device and stays visible.
		const ids = suppressedFor([
			makeEvent({
				type: CALL,
				id: "j1",
				sender: "@alice:test",
				content: callBlob("A"),
				prevContent: {},
				redacted: true,
			}),
			join("j2", "@alice:test", "B"),
		]);
		expect(ids.size).toBe(0);
	});
});

describe("computeCallTimelineNotices — expiry leaves", () => {
	const CALL = "org.matrix.msc3401.call.member";
	const HOUR = 60 * 60 * 1000;

	function activeBlob(
		deviceId: string,
		createdTs: number,
		expires?: number,
	): Record<string, unknown> {
		return {
			application: "m.call",
			call_id: "",
			device_id: deviceId,
			focus_active: { type: "livekit" },
			created_ts: createdTs,
			...(expires === undefined ? {} : { expires }),
		};
	}

	function activeEvent(
		id: string,
		sender: string,
		deviceId: string,
		createdTs: number,
		opts: { expires?: number; refresh?: boolean; ts?: number } = {},
	): MatrixEvent {
		return makeEvent({
			type: CALL,
			id,
			sender,
			ts: opts.ts ?? createdTs,
			content: activeBlob(deviceId, createdTs, opts.expires),
			// A refresh (active→active) carries the previous membership as
			// prev_content; a fresh join has empty prev_content.
			prevContent: opts.refresh ? activeBlob(deviceId, createdTs - 1) : {},
		});
	}

	function leaveEvent(
		id: string,
		sender: string,
		deviceId: string,
		ts: number,
	): MatrixEvent {
		return makeEvent({
			type: CALL,
			id,
			sender,
			ts,
			content: {},
			prevContent: activeBlob(deviceId, ts - HOUR),
		});
	}

	it("synthesizes a leave when a lone membership lapses by expiry", () => {
		// Join at t=0 with 1h expiry; no leave event; evaluate well after expiry.
		const { syntheticLeaves, suppressed, nextExpiry } =
			computeCallTimelineNotices(
				[activeEvent("j1", "@alice:test", "A", 0, { expires: HOUR })],
				2 * HOUR,
			);
		expect(suppressed.size).toBe(0);
		expect(syntheticLeaves).toEqual([
			{ userId: "@alice:test", deviceId: "A", expiresAt: HOUR },
		]);
		expect(nextExpiry).toBeNull();
	});

	it("defaults to a 4h expiry when `expires` is absent", () => {
		const { syntheticLeaves } = computeCallTimelineNotices(
			[activeEvent("j1", "@alice:test", "A", 0)],
			5 * HOUR,
		);
		expect(syntheticLeaves).toEqual([
			{ userId: "@alice:test", deviceId: "A", expiresAt: 4 * HOUR },
		]);
	});

	it("does not synthesize a leave before the membership has expired", () => {
		const { syntheticLeaves, nextExpiry } = computeCallTimelineNotices(
			[activeEvent("j1", "@alice:test", "A", 0, { expires: HOUR })],
			HOUR / 2,
		);
		expect(syntheticLeaves).toEqual([]);
		// The timeline should re-evaluate at the membership's expiry.
		expect(nextExpiry).toBe(HOUR);
	});

	it("a refresh extends the expiry so no premature synthetic leave fires", () => {
		// Join at 0 (expiry 1h), refresh at 50m (new expiry 50m+1h = 110m).
		const { syntheticLeaves, suppressed, nextExpiry } =
			computeCallTimelineNotices(
				[
					activeEvent("j1", "@alice:test", "A", 0, { expires: HOUR }),
					activeEvent("r1", "@alice:test", "A", 50 * 60 * 1000, {
						expires: HOUR,
						refresh: true,
					}),
				],
				HOUR + 5 * 60 * 1000, // 65m: past the original expiry, before the refreshed one
			);
		expect(syntheticLeaves).toEqual([]);
		expect(suppressed.size).toBe(0);
		expect(nextExpiry).toBe(50 * 60 * 1000 + HOUR);
	});

	it("an explicit leave before expiry renders (no synthetic, not suppressed)", () => {
		const { syntheticLeaves, suppressed } = computeCallTimelineNotices(
			[
				activeEvent("j1", "@alice:test", "A", 0, { expires: HOUR }),
				leaveEvent("l1", "@alice:test", "A", HOUR / 2),
			],
			2 * HOUR,
		);
		expect(syntheticLeaves).toEqual([]);
		expect(suppressed.size).toBe(0);
	});

	it("anchors a multi-device expiry leave at the last device's expiry", () => {
		// Alice on A (expiry 1h) and B (expiry 90m); both lapse, last is B.
		const { syntheticLeaves } = computeCallTimelineNotices(
			[
				activeEvent("j1", "@alice:test", "A", 0, { expires: HOUR }),
				activeEvent("j2", "@alice:test", "B", 0, { expires: 90 * 60 * 1000 }),
			],
			2 * HOUR,
		);
		expect(syntheticLeaves).toEqual([
			{ userId: "@alice:test", deviceId: "B", expiresAt: 90 * 60 * 1000 },
		]);
	});

	it("does not suppress a later explicit leave once another device has expired", () => {
		// A expires at 1h with no leave event; B explicitly leaves at 90m.
		// B's leave is the user's real last departure → must render. (The
		// simultaneous B join is a per-device duplicate and is suppressed.)
		const { syntheticLeaves, suppressed } = computeCallTimelineNotices(
			[
				activeEvent("j1", "@alice:test", "A", 0, { expires: HOUR }),
				activeEvent("j2", "@alice:test", "B", 0, { expires: 3 * HOUR }),
				leaveEvent("l2", "@alice:test", "B", 90 * 60 * 1000),
			],
			2 * HOUR,
		);
		expect([...suppressed]).toEqual(["j2"]);
		expect(suppressed.has("l2")).toBe(false);
		expect(syntheticLeaves).toEqual([]);
	});

	it("suppresses a redundant explicit leave after the device already expired", () => {
		// A expires at 1h; a late explicit leave for A arrives at 90m.
		const { syntheticLeaves, suppressed } = computeCallTimelineNotices(
			[
				activeEvent("j1", "@alice:test", "A", 0, { expires: HOUR }),
				leaveEvent("l1", "@alice:test", "A", 90 * 60 * 1000),
			],
			2 * HOUR,
		);
		// The expiry leave at 1h is surfaced; the late explicit leave is hidden.
		expect(syntheticLeaves).toEqual([
			{ userId: "@alice:test", deviceId: "A", expiresAt: HOUR },
		]);
		expect([...suppressed]).toEqual(["l1"]);
	});

	it("renders an explicit leave whose join is before the loaded window", () => {
		// Only the leave is loaded (the join scrolled off the top). The device
		// was never seen as active in-window, so the leave must NOT be
		// suppressed — it's the user's real departure.
		const { syntheticLeaves, suppressed, nextExpiry } =
			computeCallTimelineNotices(
				[leaveEvent("l1", "@alice:test", "A", 90 * 60 * 1000)],
				2 * HOUR,
			);
		expect(suppressed.size).toBe(0);
		expect(syntheticLeaves).toEqual([]);
		expect(nextExpiry).toBeNull();
	});

	it("suppresses an out-of-window leave while the user is still live on another device", () => {
		// Device B joins in-window (live); device A's join is before the window
		// (never seen), and A's leave arrives while B is still live. The leave is
		// premature — the user is still in the call — so it must be suppressed.
		const { syntheticLeaves, suppressed } = computeCallTimelineNotices(
			[
				activeEvent("jB", "@alice:test", "B", 0, { expires: 10 * HOUR }),
				leaveEvent("lA", "@alice:test", "A", 30 * 60 * 1000),
			],
			HOUR,
		);
		expect([...suppressed]).toEqual(["lA"]);
		expect(syntheticLeaves).toEqual([]);
	});

	it("never synthesizes a leave for legacy / device-less membership shapes", () => {
		// Legacy nested shape has no per-device expiry; only explicit leaves.
		const legacy = makeEvent({
			type: CALL,
			id: "j1",
			sender: "@alice:test",
			ts: 0,
			content: { "m.calls": [{ "m.call_id": "x" }] },
			prevContent: {},
		});
		const { syntheticLeaves, nextExpiry } = computeCallTimelineNotices(
			[legacy],
			10 * HOUR,
		);
		expect(syntheticLeaves).toEqual([]);
		expect(nextExpiry).toBeNull();
	});

	it("treats a real event at exactly a device's expiry as winning the tie", () => {
		// B's membership expires at exactly 1h; A's explicit leave is also at 1h.
		// The real leave at 1h is processed first, so A is the last departure and
		// renders; B then expires but the user is already gone → no double leave.
		const { syntheticLeaves, suppressed } = computeCallTimelineNotices(
			[
				activeEvent("j1", "@alice:test", "A", 0, { expires: 2 * HOUR }),
				activeEvent("j2", "@alice:test", "B", 0, { expires: HOUR }),
				leaveEvent("l1", "@alice:test", "A", HOUR),
			],
			3 * HOUR,
		);
		// A leaves explicitly at 1h while B is still (barely) live → premature,
		// suppressed; B then lapses by expiry at 1h → synthetic leave for B.
		// (B's simultaneous duplicate join is suppressed too.)
		expect([...suppressed].sort()).toEqual(["j2", "l1"]);
		expect(syntheticLeaves).toEqual([
			{ userId: "@alice:test", deviceId: "B", expiresAt: HOUR },
		]);
	});
});
