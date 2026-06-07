import { describe, expect, it } from "vitest";
import { buildNotificationCopy, trimmedField } from "./pushCopy";

describe("trimmedField", () => {
	it("trims strings and returns '' for non-strings", () => {
		expect(trimmedField("  hi  ")).toBe("hi");
		expect(trimmedField("   ")).toBe("");
		expect(trimmedField(42)).toBe("");
		expect(trimmedField(null)).toBe("");
		expect(trimmedField(undefined)).toBe("");
		expect(trimmedField({})).toBe("");
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
});
