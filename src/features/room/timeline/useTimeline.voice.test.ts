import type { MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
	createMockClient,
	createMockRoom,
	type MockEvent,
} from "../../../test/mockClient";
import { useTimeline } from "./useTimeline";

const ROOM_ID = "!room:test";

function withRoot(fn: (dispose: () => void) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			try {
				await fn(dispose);
				dispose();
				resolve();
			} catch (e) {
				dispose();
				reject(e);
			}
		});
	});
}

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Element-shaped voice message event. */
function voiceEvent(eventId: string, ts: number): MockEvent {
	return {
		eventId,
		roomId: ROOM_ID,
		sender: "@alice:test",
		type: "m.room.message",
		content: {
			msgtype: "m.audio",
			body: "Voice message",
			url: "mxc://example.com/voice",
			info: { duration: 6541, mimetype: "audio/ogg", size: 42967 },
			"org.matrix.msc1767.audio": {
				duration: 6541,
				waveform: [0, 512, 1024],
			},
			"org.matrix.msc3245.voice": {},
		},
		ts,
	};
}

describe("useTimeline voice messages", () => {
	it("projects MSC3245 voice fields for a voice message", async () => {
		const room = createMockRoom(ROOM_ID, [voiceEvent("$v", 1000)]);
		const client = createMockClient(new Map([[ROOM_ID, room]]));
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].msgtype).toBe("m.audio");
			expect(events[0].isVoice).toBe(true);
			expect(events[0].voiceDurationMs).toBe(6541);
			expect(events[0].voiceWaveform).toEqual([0, 0.5, 1]);
			expect(events[0].mediaFullUrl).toContain("https://");
		});
	});

	it("leaves plain audio messages non-voice", async () => {
		const room = createMockRoom(ROOM_ID, [
			{
				eventId: "$a",
				roomId: ROOM_ID,
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.audio",
					body: "song.mp3",
					url: "mxc://example.com/song",
					info: { mimetype: "audio/mpeg", size: 123 },
				},
				ts: 1000,
			},
		]);
		const client = createMockClient(new Map([[ROOM_ID, room]]));
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events[0].isVoice).toBe(false);
			expect(events[0].voiceDurationMs).toBeNull();
			expect(events[0].voiceWaveform).toBeNull();
		});
	});

	it("uses a voice snippet for replies to voice messages", async () => {
		const reply: MockEvent = {
			eventId: "$reply",
			roomId: ROOM_ID,
			sender: "@bob:test",
			type: "m.room.message",
			content: {
				msgtype: "m.text",
				body: "nice one",
				"m.relates_to": { "m.in_reply_to": { event_id: "$v" } },
			},
			ts: 2000,
		};
		const room = createMockRoom(ROOM_ID, [voiceEvent("$v", 1000), reply]);
		const client = createMockClient(new Map([[ROOM_ID, room]]));
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			const replyRow = events.find((e) => e.eventId === "$reply");
			expect(replyRow?.replyToBody).toBe("🎤 Voice message");
		});
	});
});
