import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	buildMembershipTransition,
	buildStateNotice,
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
