import { describe, expect, it } from "vitest";
import { buildNotificationCopy, stringField, trimmedField } from "./pushCopy";

describe("trimmedField", () => {
	it("trims strings and returns '' for non-strings", () => {
		// Still used by the service worker for room_id / event_id, where
		// surrounding whitespace is never meaningful.
		expect(trimmedField("  hi  ")).toBe("hi");
		expect(trimmedField("   ")).toBe("");
		expect(trimmedField(42)).toBe("");
		expect(trimmedField(null)).toBe("");
		expect(trimmedField(undefined)).toBe("");
		expect(trimmedField({})).toBe("");
	});
});

describe("stringField", () => {
	it("passes strings through and returns '' for non-strings", () => {
		expect(stringField("  hi  ")).toBe("  hi  ");
		expect(stringField("   ")).toBe("   ");
		expect(stringField(42)).toBe("");
		expect(stringField(null)).toBe("");
		expect(stringField(undefined)).toBe("");
		expect(stringField({})).toBe("");
	});

	it("does not trim, so displayNameOr sees the raw length", () => {
		// The bound is tested against the raw string. Trimming here would let
		// a name behind 2000 spaces past a bound the member list applies.
		const padded = `${" ".repeat(2000)}Ann`;
		expect(stringField(padded)).toBe(padded);
	});
});

describe("buildNotificationCopy", () => {
	it("attributes a text message to the sender inside a named room", () => {
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Alice",
				type: "m.room.message",
				content: { msgtype: "m.text", body: "hello there" },
			}),
		).toEqual({ title: "General", body: "Alice: hello there" });
	});

	it("uses the sender as the title in a DM (no room name)", () => {
		expect(
			buildNotificationCopy({
				sender_display_name: "Alice",
				type: "m.room.message",
				content: { msgtype: "m.text", body: "hello there" },
			}),
		).toEqual({ title: "Alice", body: "hello there" });
	});

	it("frames a thread reply consistently with the in-app copy (named room)", () => {
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Alice",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "in thread",
					"m.relates_to": { rel_type: "m.thread", event_id: "$root" },
				},
			}),
		).toEqual({
			title: "General",
			body: "Alice replied in a thread: in thread",
		});
	});

	it("frames a thread media reply without the sent-an-X specifics (DM)", () => {
		expect(
			buildNotificationCopy({
				sender_display_name: "Alice",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					"m.relates_to": { rel_type: "m.thread", event_id: "$root" },
				},
			}),
		).toEqual({ title: "Alice", body: "replied in a thread" });
	});

	it("does not thread-frame a plain in_reply_to reply", () => {
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Alice",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "hi",
					"m.relates_to": { "m.in_reply_to": { event_id: "$p" } },
				},
			}),
		).toEqual({ title: "General", body: "Alice: hi" });
	});

	it("describes a voice message distinctly from plain audio", () => {
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Alice",
				type: "m.room.message",
				content: {
					msgtype: "m.audio",
					"org.matrix.msc3245.voice": {},
				},
			}),
		).toEqual({ title: "General", body: "Alice sent a voice message" });
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Alice",
				type: "m.room.message",
				content: { msgtype: "m.audio" },
			}),
		).toEqual({ title: "General", body: "Alice sent an audio file" });
	});

	it("renders media actions with a space join, not a colon", () => {
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Bob",
				content: { msgtype: "m.image" },
			}),
		).toEqual({ title: "General", body: "Bob sent an image" });
	});

	it("shows a clear encrypted-message label for m.room.encrypted events", () => {
		expect(
			buildNotificationCopy({
				room_name: "Secret",
				sender_display_name: "Carol",
				type: "m.room.encrypted",
			}),
		).toEqual({ title: "Secret", body: "Carol: 🔒 Encrypted message" });
	});

	it("uses the encrypted label as the body in an encrypted DM", () => {
		expect(
			buildNotificationCopy({
				sender_display_name: "Carol",
				type: "m.room.encrypted",
			}),
		).toEqual({ title: "Carol", body: "🔒 Encrypted message" });
	});

	it("shows 'Poll: <question>' for a poll start event", () => {
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Alice",
				type: "org.matrix.msc3381.poll.start",
				content: {
					"org.matrix.msc3381.poll.start": {
						question: { "org.matrix.msc1767.text": "Best pizza?" },
					},
				},
			}),
		).toEqual({ title: "General", body: "Alice: Poll: Best pizza?" });
	});

	it("falls back to plain 'Poll' when the poll question is unreadable", () => {
		expect(
			buildNotificationCopy({
				sender_display_name: "Alice",
				type: "m.poll.start",
			}),
		).toEqual({ title: "Alice", body: "Poll" });
	});

	it("falls back to 'New message' for a non-encrypted event with no body", () => {
		expect(
			buildNotificationCopy({
				room_name: "General",
				sender_display_name: "Dave",
				type: "m.room.message",
				content: { msgtype: "m.text" },
			}),
		).toEqual({ title: "General", body: "Dave: New message" });
	});

	it("prefers a readable body over the encrypted label when one is present", () => {
		expect(
			buildNotificationCopy({
				sender_display_name: "Eve",
				type: "m.room.encrypted",
				content: { msgtype: "m.text", body: "already decrypted" },
			}),
		).toEqual({ title: "Eve", body: "already decrypted" });
	});

	it("falls back to 'Someone' and trims whitespace-only names", () => {
		expect(
			buildNotificationCopy({
				room_name: "   ",
				sender: "   ",
				type: "m.room.encrypted",
			}),
		).toEqual({ title: "Someone", body: "🔒 Encrypted message" });
	});

	it("does not repeat the sender when the room name equals the sender", () => {
		expect(
			buildNotificationCopy({
				room_name: "Alice",
				sender_display_name: "Alice",
				content: { msgtype: "m.text", body: "hi" },
			}),
		).toEqual({ title: "Alice", body: "hi" });
	});

	it("still frames a DM as a DM when the peer's name carries a bidi control", () => {
		// Sygnal derives room_name from the peer's member name for an unnamed
		// DM, and the sender goes through the name policy, so both sides of
		// the "is this a room" comparison must be normalised the same way -
		// otherwise the raw name lands in the OS title as a room, with the
		// unmatched embedding intact.
		const name = `Ann${String.fromCharCode(0x202a)}Smith`;
		expect(
			buildNotificationCopy({
				room_name: name,
				sender_display_name: name,
				content: { msgtype: "m.text", body: "hi" },
			}),
		).toEqual({ title: "AnnSmith", body: "hi" });
	});
});
