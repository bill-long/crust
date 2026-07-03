import { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { buildNotificationBody } from "./notificationCopy";

function ev(
	content: Record<string, unknown>,
	overrides?: { type?: string; unsigned?: Record<string, unknown> },
): MatrixEvent {
	return new MatrixEvent({
		type: overrides?.type ?? "m.room.message",
		event_id: "$e",
		room_id: "!r:hs",
		sender: "@a:hs",
		origin_server_ts: 1,
		content,
		unsigned: overrides?.unsigned,
	});
}

const THREAD_RELATION = {
	rel_type: "m.thread",
	event_id: "$root",
	is_falling_back: true,
	"m.in_reply_to": { event_id: "$root" },
};

describe("buildNotificationBody", () => {
	it("attributes a plain text message to the sender", () => {
		expect(
			buildNotificationBody(ev({ msgtype: "m.text", body: "hi" }), "Amon"),
		).toBe("Amon: hi");
	});

	it("uses an action phrase for media (space-joined, no colon)", () => {
		expect(buildNotificationBody(ev({ msgtype: "m.image" }), "Amon")).toBe(
			"Amon sent an image",
		);
	});

	it("frames a thread text reply as replied in a thread", () => {
		const reply = ev({
			msgtype: "m.text",
			body: "in thread",
			"m.relates_to": THREAD_RELATION,
		});
		expect(buildNotificationBody(reply, "Amon")).toBe(
			"Amon replied in a thread: in thread",
		);
	});

	it("frames a thread media reply without the sent-an-X specifics", () => {
		const reply = ev({
			msgtype: "m.image",
			"m.relates_to": THREAD_RELATION,
		});
		expect(buildNotificationBody(reply, "Amon")).toBe(
			"Amon replied in a thread",
		);
	});

	it("keeps the encrypted-failure label regardless of thread state", () => {
		const enc = ev({}, { type: "m.room.encrypted" });
		// Force the decryption-failure branch.
		enc.isDecryptionFailure = () => true;
		expect(buildNotificationBody(enc, "Amon")).toBe(
			"Amon: 🔒 Encrypted message",
		);
	});

	it("falls back to New message for an empty body", () => {
		expect(buildNotificationBody(ev({ msgtype: "m.text" }), "Amon")).toBe(
			"Amon: New message",
		);
	});
});
