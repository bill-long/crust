import type { MatrixEvent, Room, RoomMember } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	matchesAllTokens,
	projectEvent,
	splitQueryTokens,
	useRoomSearch,
} from "./useRoomSearch";

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

describe("splitQueryTokens", () => {
	it("returns lowercase tokens split on whitespace", () => {
		expect(splitQueryTokens("Hello World")).toEqual(["hello", "world"]);
	});

	it("collapses runs of whitespace", () => {
		expect(splitQueryTokens("foo   bar\t\nbaz")).toEqual(["foo", "bar", "baz"]);
	});

	it("trims leading/trailing whitespace", () => {
		expect(splitQueryTokens("  hello  ")).toEqual(["hello"]);
	});

	it("returns empty array for an empty or whitespace-only string", () => {
		expect(splitQueryTokens("")).toEqual([]);
		expect(splitQueryTokens("   ")).toEqual([]);
	});

	it("preserves single-token queries", () => {
		expect(splitQueryTokens("solo")).toEqual(["solo"]);
	});
});

describe("matchesAllTokens", () => {
	it("returns true when every token appears (case-insensitive)", () => {
		expect(matchesAllTokens("Hello brave new World", ["hello", "world"])).toBe(
			true,
		);
	});

	it("ignores token order", () => {
		expect(matchesAllTokens("world of hello", ["hello", "world"])).toBe(true);
	});

	it("returns false when one token is missing (AND semantics, not OR)", () => {
		expect(matchesAllTokens("hello there", ["hello", "world"])).toBe(false);
	});

	it("returns false for an empty token list (no positive match)", () => {
		expect(matchesAllTokens("anything", [])).toBe(false);
	});

	it("treats a single token as a substring search", () => {
		expect(matchesAllTokens("alphabet", ["pha"])).toBe(true);
		expect(matchesAllTokens("alphabet", ["zzz"])).toBe(false);
	});

	it("matches body that is exactly the token, case-insensitively", () => {
		expect(matchesAllTokens("HELLO", ["hello"])).toBe(true);
	});
});

interface FakeRoomOpts {
	encrypted?: boolean;
	timelineEvents?: MatrixEvent[];
}

function makeHookRoom(roomId: string, opts: FakeRoomOpts = {}): Room {
	const events = opts.timelineEvents ?? [];
	return {
		roomId,
		hasEncryptionStateEvent: () => opts.encrypted ?? false,
		getMember: () => null,
		getUnfilteredTimelineSet: () => ({
			getTimelines: () => [
				{
					getEvents: () => events,
				},
			],
		}),
	} as unknown as Room;
}

function makeHookClient(
	rooms: Map<string, Room>,
	searchImpl?: () => Promise<unknown>,
) {
	const client = {
		getRoom: (id: string) => rooms.get(id) ?? null,
		on: vi.fn(),
		off: vi.fn(),
		searchRoomEvents:
			searchImpl ??
			vi.fn().mockResolvedValue({
				results: [],
				highlights: [],
				next_batch: undefined,
			}),
		backPaginateRoomEventsSearch: vi.fn(),
	};
	return client;
}

describe("useRoomSearch (hook)", () => {
	it("starts in 'server' mode", () => {
		createRoot((dispose) => {
			const rooms = new Map<string, Room>();
			rooms.set("!r:test", makeHookRoom("!r:test"));
			const client = makeHookClient(rooms);
			const hook = useRoomSearch(
				client as unknown as Parameters<typeof useRoomSearch>[0],
				() => "!r:test",
			);
			expect(hook.mode()).toBe("server");
			expect(hook.isEncrypted()).toBe(false);
			dispose();
		});
	});

	it("submit() pre-sets mode to 'local' for an encrypted room", () => {
		createRoot((dispose) => {
			const rooms = new Map<string, Room>();
			rooms.set("!enc:test", makeHookRoom("!enc:test", { encrypted: true }));
			const client = makeHookClient(rooms);
			const hook = useRoomSearch(
				client as unknown as Parameters<typeof useRoomSearch>[0],
				() => "!enc:test",
			);
			hook.submit("hello");
			expect(hook.mode()).toBe("local");
			expect(client.searchRoomEvents).not.toHaveBeenCalled();
			dispose();
		});
	});

	it("submit() pre-sets mode to 'server' for an unencrypted room", () => {
		createRoot((dispose) => {
			const rooms = new Map<string, Room>();
			rooms.set("!plain:test", makeHookRoom("!plain:test"));
			// Never-resolving promise so we can observe the pre-set mode
			// before runServer overwrites it.
			const client = makeHookClient(
				rooms,
				() => new Promise(() => {}) as Promise<never>,
			);
			const hook = useRoomSearch(
				client as unknown as Parameters<typeof useRoomSearch>[0],
				() => "!plain:test",
			);
			hook.submit("hello");
			expect(hook.mode()).toBe("server");
			expect(hook.status()).toBe("searching");
			dispose();
		});
	});

	it("reset() restores mode to 'server' for an unencrypted room after a local fallback", async () => {
		await new Promise<void>((resolveTest) => {
			createRoot((dispose) => {
				const rooms = new Map<string, Room>();
				rooms.set("!plain:test", makeHookRoom("!plain:test"));
				// searchRoomEvents rejects -> runLocal fallback -> mode becomes "local".
				const client = makeHookClient(rooms, () =>
					Promise.reject(new Error("server search unavailable")),
				);
				const hook = useRoomSearch(
					client as unknown as Parameters<typeof useRoomSearch>[0],
					() => "!plain:test",
				);
				hook.submit("hello");
				// Wait a microtask for the rejected promise to flush.
				queueMicrotask(() => {
					expect(hook.mode()).toBe("local");
					hook.reset();
					expect(hook.mode()).toBe("server");
					dispose();
					resolveTest();
				});
			});
		});
	});

	it("reset() restores mode to 'local' for an encrypted room (avoids 'server' on an encrypted room)", () => {
		createRoot((dispose) => {
			const rooms = new Map<string, Room>();
			rooms.set("!enc:test", makeHookRoom("!enc:test", { encrypted: true }));
			const client = makeHookClient(rooms);
			const hook = useRoomSearch(
				client as unknown as Parameters<typeof useRoomSearch>[0],
				() => "!enc:test",
			);
			hook.reset();
			expect(hook.mode()).toBe("local");
			dispose();
		});
	});
});
