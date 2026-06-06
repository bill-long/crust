import type { MatrixClient } from "matrix-js-sdk";
import {
	createEffect,
	createRoot,
	createSignal,
	getOwner,
	runWithOwner,
} from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	createMatrixEvent,
	createMockClient,
	createMockRoom,
	encryptedMessage,
	textMessage,
} from "../../../test/mockClient";
import { useTimeline } from "./useTimeline";

/** Run a test inside createRoot with proper error propagation. */
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

/** Wait for pending promise handlers (TimelineWindow.load() and its .then()/.catch()) */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Create a fake SDK-like event for live event emissions in tests */
function createFakeEvent(
	roomId: string,
	eventId: string,
	sender: string,
	body: string,
	ts: number,
	type = "m.room.message",
	content?: Record<string, unknown>,
) {
	return createMatrixEvent({
		eventId,
		roomId,
		sender,
		type,
		content: content ?? { msgtype: "m.text", body },
		ts,
	});
}

/** Append event to mock timeline and emit as live event */
function appendLive(
	client: ReturnType<typeof createMockClient>,
	room: ReturnType<typeof createMockRoom>,
	event: ReturnType<typeof createFakeEvent>,
) {
	const timeline = room.getLiveTimeline();
	timeline.__append(
		event as unknown as Parameters<typeof timeline.__append>[0],
	);
	client.__emit("Room.timeline", event, room, false, false, {
		liveEvent: true,
	});
}

describe("useTimeline", () => {
	it("loads events for the initial room", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			textMessage("!roomA:test", "$2", "@bob:test", "world", 2000),
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(2);
			expect(events[0].body).toBe("hello");
			expect(events[1].body).toBe("world");
			expect(loading()).toBe(false);
		});
	});

	it("returns empty events for unknown room", async () => {
		const client = createMockClient(new Map());

		await withRoot(async (_dispose) => {
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				() => "!unknown:test",
			);

			await flushPromises();

			expect(events.length).toBe(0);
			expect(loading()).toBe(false);
		});
	});

	it("replaces events completely when room changes", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "room A msg", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B msg", 2000),
			textMessage("!roomB:test", "$b2", "@bob:test", "room B msg 2", 3000),
		]);

		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async (_dispose) => {
			const [roomId, setRoomId] = createSignal("!roomA:test");

			const { events } = useTimeline(client as unknown as MatrixClient, roomId);

			// Allow initial reactive effect to run
			await flushPromises();

			// Initial load: room A
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");
			expect(events[0].eventId).toBe("$a1");

			// Switch to room B
			setRoomId("!roomB:test");

			// Allow reactive effect to run
			await flushPromises();

			expect(events.length).toBe(2);
			expect(events[0].body).toBe("room B msg");
			expect(events[0].eventId).toBe("$b1");
			expect(events[1].body).toBe("room B msg 2");

			// No events from room A should remain
			const allBodies = Array.from(
				{ length: events.length },
				(_, i) => events[i].body,
			);
			expect(allBodies).not.toContain("room A msg");
		});
	});

	it("handles switching to a room with fewer events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$a2", "@alice:test", "msg 2", 2000),
			textMessage("!roomA:test", "$a3", "@alice:test", "msg 3", 3000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "only msg", 4000),
		]);

		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async (_dispose) => {
			const [roomId, setRoomId] = createSignal("!roomA:test");

			const { events } = useTimeline(client as unknown as MatrixClient, roomId);

			await flushPromises();
			expect(events.length).toBe(3);

			setRoomId("!roomB:test");
			await flushPromises();

			// Must be exactly 1 event, not 3 with stale trailing items
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("only msg");
		});
	});

	it("filters out non-displayable events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "visible", 1000),
			{
				eventId: "$2",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 2000,
			},
			{
				eventId: "$3",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "edit target",
					"m.relates_to": { rel_type: "m.replace", event_id: "$1" },
				},
				ts: 3000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(1);
			expect(events[0].body).toBe("visible");
		});
	});

	it("reconciles per-device call memberships into per-user notices", async () => {
		const CALL = "org.matrix.msc3401.call.member";
		const blob = (deviceId: string) => ({
			application: "m.call",
			call_id: "",
			device_id: deviceId,
			focus_active: { type: "livekit" },
		});
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$m", "@alice:test", "hi", 1000),
			// Alice joins from device A (shown) then device B (duplicate, hidden).
			{
				eventId: "$j1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: CALL,
				stateKey: "@alice:test_A",
				content: blob("A"),
				prevContent: {},
				ts: 2000,
			},
			{
				eventId: "$j2",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: CALL,
				stateKey: "@alice:test_B",
				content: blob("B"),
				prevContent: {},
				ts: 3000,
			},
			// Device A leaves while B is still in the call (premature, hidden),
			// then device B leaves (last device, shown).
			{
				eventId: "$l1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: CALL,
				stateKey: "@alice:test_A",
				content: {},
				prevContent: blob("A"),
				ts: 4000,
			},
			{
				eventId: "$l2",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: CALL,
				stateKey: "@alice:test_B",
				content: {},
				prevContent: blob("B"),
				ts: 5000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			// message + one join notice + one leave notice; the duplicate join
			// ($j2) and premature leave ($l1) are reconciled away.
			expect(events.length).toBe(3);
			const ids = events.map((e) => e.eventId);
			expect(ids).toEqual(["$m", "$j1", "$l2"]);
			const notices = events
				.filter((e) => e.stateNotice)
				.map((e) => e.stateNotice?.text);
			expect(notices).toEqual([
				"@alice:test joined the call",
				"@alice:test left the call",
			]);
		});
	});

	it("reconciles per-device call memberships arriving as live events", async () => {
		const CALL = "org.matrix.msc3401.call.member";
		const blob = (deviceId: string) => ({
			application: "m.call",
			call_id: "",
			device_id: deviceId,
			focus_active: { type: "livekit" },
		});
		const callEvent = (
			id: string,
			content: Record<string, unknown>,
			prevContent: Record<string, unknown>,
			ts: number,
		) =>
			createMatrixEvent({
				eventId: id,
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: CALL,
				stateKey: "@alice:test",
				content,
				prevContent,
				ts,
			});

		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$m", "@alice:test", "hi", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();
			expect(events.length).toBe(1);

			// Device A joins (shown), device B joins (duplicate, hidden).
			appendLive(client, roomA, callEvent("$j1", blob("A"), {}, 2000));
			appendLive(client, roomA, callEvent("$j2", blob("B"), {}, 3000));
			// Device A leaves while B is still live (premature, hidden), then B
			// leaves (last device, shown).
			appendLive(client, roomA, callEvent("$l1", {}, blob("A"), 4000));
			appendLive(client, roomA, callEvent("$l2", {}, blob("B"), 5000));

			expect(events.map((e) => e.eventId)).toEqual(["$m", "$j1", "$l2"]);
			expect(
				events.filter((e) => e.stateNotice).map((e) => e.stateNotice?.text),
			).toEqual(["@alice:test joined the call", "@alice:test left the call"]);
		});
	});

	it("rebuilds call notices when a shown join is redacted, surfacing a sibling", async () => {
		const CALL = "org.matrix.msc3401.call.member";
		const blob = (deviceId: string) => ({
			application: "m.call",
			call_id: "",
			device_id: deviceId,
			focus_active: { type: "livekit" },
		});
		// Device A join is shown; device B join is suppressed as a duplicate.
		const j1: import("../../../test/mockClient").MockEvent = {
			eventId: "$j1",
			roomId: "!roomA:test",
			sender: "@alice:test",
			type: CALL,
			stateKey: "@alice:test_A",
			content: blob("A"),
			prevContent: {},
			ts: 2000,
		};
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$m", "@alice:test", "hi", 1000),
			j1,
			{
				eventId: "$j2",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: CALL,
				stateKey: "@alice:test_B",
				content: blob("B"),
				prevContent: {},
				ts: 3000,
			},
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();
			// Only the device-A join shows; device-B is the hidden duplicate.
			expect(events.map((e) => e.eventId)).toEqual(["$m", "$j1"]);

			// Redact the shown device-A join. The reconciliation must rebuild and
			// surface the previously-suppressed device-B join.
			j1.redacted = true;
			const redaction = createMatrixEvent({
				eventId: "$red",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.redaction",
				content: {},
				ts: 4000,
				redacts: "$j1",
			});
			appendLive(client, roomA, redaction);

			expect(events.map((e) => e.eventId)).toEqual(["$m", "$j2"]);
			expect(events[1].stateNotice?.text).toBe("@alice:test joined the call");
		});
	});

	it("includes state events as state-notice timeline items", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			{
				eventId: "$2",
				roomId: "!roomA:test",
				sender: "@bob:test",
				type: "m.room.member",
				stateKey: "@bob:test",
				content: { membership: "join", displayname: "Bob" },
				prevContent: {},
				ts: 2000,
			},
			{
				eventId: "$3",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.name",
				stateKey: "",
				content: { name: "New Title" },
				prevContent: { name: "Old Title" },
				ts: 3000,
			},
			// No-op state write — must be filtered out, not rendered.
			{
				eventId: "$4",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.topic",
				stateKey: "",
				content: { topic: "same" },
				prevContent: { topic: "same" },
				ts: 4000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			// hello + join + name change. The no-op topic write is filtered.
			expect(events.length).toBe(3);
			expect(events[0].body).toBe("hello");
			expect(events[0].stateNotice).toBe(null);
			expect(events[1].stateNotice?.text).toBe("Bob joined the room");
			expect(events[2].stateNotice?.text).toBe(
				'@alice:test changed the room name to "New Title"',
			);
		});
	});

	it("includes encrypted events as displayable", async () => {
		const roomA = createMockRoom("!roomA:test", [
			encryptedMessage("!roomA:test", "$1", "@alice:test", 1000, true),
			textMessage("!roomA:test", "$2", "@bob:test", "normal", 2000),
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(2);
			expect(events[0].isDecryptionFailure).toBe(true);
			expect(events[1].body).toBe("normal");
		});
	});

	it("extracts intrinsic image dimensions from m.image content.info", async () => {
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$img1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "screenshot.png",
					url: "mxc://test/abc",
					info: { w: 1920, h: 1080, mimetype: "image/png", size: 12345 },
				},
				ts: 1000,
			},
			// Sticker (uses m.sticker type, not msgtype)
			{
				eventId: "$st1",
				roomId: "!roomA:test",
				sender: "@bob:test",
				type: "m.sticker",
				content: {
					body: "sticker",
					url: "mxc://test/xyz",
					info: { w: 128, h: 256 },
				},
				ts: 2000,
			},
			// Missing info entirely
			{
				eventId: "$img2",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "no-dims.png",
					url: "mxc://test/none",
				},
				ts: 3000,
			},
			// Garbage / non-numeric / zero / NaN values must not poison the field
			{
				eventId: "$img3",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "bad-dims.png",
					url: "mxc://test/bad",
					info: { w: "640", h: 0 },
				},
				ts: 4000,
			},
			{
				eventId: "$img4",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "nan-dims.png",
					url: "mxc://test/nan",
					info: { w: Number.NaN, h: -10 },
				},
				ts: 5000,
			},
			// Only one dimension valid → all-or-nothing pairing means both
			// fields must be null (can't reserve a useful aspect ratio
			// from a single dim).
			{
				eventId: "$img5",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "half-dims.png",
					url: "mxc://test/half",
					info: { w: 800 },
				},
				ts: 6000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(6);
			expect(events[0].imageWidth).toBe(1920);
			expect(events[0].imageHeight).toBe(1080);
			expect(events[1].imageWidth).toBe(128);
			expect(events[1].imageHeight).toBe(256);
			expect(events[2].imageWidth).toBeNull();
			expect(events[2].imageHeight).toBeNull();
			// "640" is a string, not a number → rejected. h=0 is non-positive.
			expect(events[3].imageWidth).toBeNull();
			expect(events[3].imageHeight).toBeNull();
			// NaN and negative both rejected.
			expect(events[4].imageWidth).toBeNull();
			expect(events[4].imageHeight).toBeNull();
			// Half-valid: missing one dim ⇒ both null (all-or-nothing).
			expect(events[5].imageWidth).toBeNull();
			expect(events[5].imageHeight).toBeNull();
		});
	});

	it("ignores info.w/h on non-image / non-sticker events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			// m.file with a stray info.w/h — should NOT populate image dims
			{
				eventId: "$f1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.file",
					body: "doc.pdf",
					url: "mxc://test/file",
					info: { w: 1024, h: 768 },
				},
				ts: 1000,
			},
			// m.text with bogus info block — must also be ignored
			{
				eventId: "$t1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "hello",
					info: { w: 200, h: 100 },
				},
				ts: 2000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(2);
			expect(events[0].imageWidth).toBeNull();
			expect(events[0].imageHeight).toBeNull();
			expect(events[1].imageWidth).toBeNull();
			expect(events[1].imageHeight).toBeNull();
		});
	});

	it("treats empty-string content.url / content.file.url as missing for m.image", async () => {
		const roomA = createMockRoom("!roomA:test", [
			// Empty plain url — should not project as a usable image and
			// must not be flagged as encrypted.
			{
				eventId: "$e1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "empty.png",
					url: "",
				},
				ts: 1000,
			},
			// Empty encrypted file.url — same rule applies.
			{
				eventId: "$e2",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "empty-enc.png",
					file: { url: "", key: { k: "x" } },
				},
				ts: 2000,
			},
			// Empty plain url with a valid encrypted url — falls back to the
			// encrypted source and is correctly flagged as encrypted.
			{
				eventId: "$e3",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "mixed.png",
					url: "",
					file: { url: "mxc://test/enc", key: { k: "x" } },
				},
				ts: 3000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(3);
			expect(events[0].imageUrl).toBeNull();
			expect(events[0].imageFullUrl).toBeNull();
			expect(events[0].imageIsEncrypted).toBe(false);
			expect(events[1].imageUrl).toBeNull();
			expect(events[1].imageFullUrl).toBeNull();
			expect(events[1].imageIsEncrypted).toBe(false);
			expect(events[2].imageUrl).not.toBeNull();
			expect(events[2].imageFullUrl).not.toBeNull();
			expect(events[2].imageIsEncrypted).toBe(true);
		});
	});

	it("falls back to content.body when content.filename is empty/whitespace", async () => {
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$empty",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					filename: "",
					body: "photo.png",
					url: "mxc://test/empty",
				},
				ts: 1000,
			},
			{
				eventId: "$ws",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					filename: "   ",
					body: "shot.jpg",
					url: "mxc://test/ws",
				},
				ts: 2000,
			},
			{
				eventId: "$real",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					filename: "real.png",
					body: "ignored caption",
					url: "mxc://test/real",
				},
				ts: 3000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(3);
			expect(events[0].imageFilename).toBe("photo.png");
			expect(events[1].imageFilename).toBe("shot.jpg");
			expect(events[2].imageFilename).toBe("real.png");
		});
	});

	it("rejects filenames containing ASCII control chars (CR, NUL, etc.)", async () => {
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$cr",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "evil\rname.png",
					url: "mxc://test/cr",
				},
				ts: 1000,
			},
			{
				eventId: "$nul",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "evil\u0000name.png",
					url: "mxc://test/nul",
				},
				ts: 2000,
			},
			{
				eventId: "$del",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "evil\u007fname.png",
					url: "mxc://test/del",
				},
				ts: 3000,
			},
			{
				eventId: "$ok",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.image",
					body: "fine name.png",
					url: "mxc://test/ok",
				},
				ts: 4000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(4);
			expect(events[0].imageFilename).toBeNull();
			expect(events[1].imageFilename).toBeNull();
			expect(events[2].imageFilename).toBeNull();
			expect(events[3].imageFilename).toBe("fine name.png");
		});
	});

	it("extracts intrinsic dimensions from m.text GIF messages with info block", async () => {
		const roomA = createMockRoom("!roomA:test", [
			// Composer-sent GIF: m.text body with recognized provider URL
			// and info.w/h attached so the receiver can reserve the box.
			{
				eventId: "$g1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "https://media.giphy.com/media/abc/giphy.gif",
					info: { w: 480, h: 270, mimetype: "image/gif" },
				},
				ts: 1000,
			},
			// Reply-prefixed GIF: the reply fallback prefix must still be
			// stripped before the GIF URL check, otherwise the row would
			// miss its dimensions on every reply.
			{
				eventId: "$g2",
				roomId: "!roomA:test",
				sender: "@bob:test",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "> <@alice:test> hi\n\nhttps://static.klipy.com/gifs/x.gif",
					info: { w: 320, h: 240 },
				},
				ts: 2000,
			},
			// Inbound foreign GIF without dims: behaviour must be unchanged
			// (dims remain null; scroller RO handles re-anchor on load).
			{
				eventId: "$g3",
				roomId: "!roomA:test",
				sender: "@bob:test",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "https://media.tenor.com/y.gif",
				},
				ts: 3000,
			},
			// m.text with info but body is NOT a GIF URL → dims ignored
			// (guards against the gating widening too far).
			{
				eventId: "$g4",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.text",
					body: "just a regular message",
					info: { w: 999, h: 999 },
				},
				ts: 4000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			expect(events.length).toBe(4);
			expect(events[0].imageWidth).toBe(480);
			expect(events[0].imageHeight).toBe(270);
			expect(events[1].imageWidth).toBe(320);
			expect(events[1].imageHeight).toBe(240);
			expect(events[2].imageWidth).toBeNull();
			expect(events[2].imageHeight).toBeNull();
			expect(events[3].imageWidth).toBeNull();
			expect(events[3].imageHeight).toBeNull();
		});
	});

	it("loads events when room appears after initial empty load", async () => {
		// Room doesn't exist initially
		const client = createMockClient(new Map());

		await withRoot(async (_dispose) => {
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();

			// No room yet — empty
			expect(events.length).toBe(0);
			expect(loading()).toBe(false);

			// Room appears with messages
			const roomA = createMockRoom("!roomA:test", [
				textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			]);
			client.__setRooms(new Map([["!roomA:test", roomA]]));
			client.__emit("Room", roomA);

			await flushPromises();

			// Events should now be loaded
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("hello");
		});
	});

	it("does not reload when onRoomAppeared fires for an already-loaded room", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			// Spy on getRoom to count reload attempts
			let getRoomCalls = 0;
			const originalGetRoom = client.getRoom;
			client.getRoom = (roomId: string) => {
				getRoomCalls++;
				return originalGetRoom(roomId);
			};

			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);
			const callsAfterInitialLoad = getRoomCalls;

			// Emit Room event again — should NOT reload (events already loaded)
			client.__emit("Room", roomA);
			await flushPromises();

			// getRoom should not have been called again
			expect(getRoomCalls).toBe(callsAfterInitialLoad);
			expect(events.length).toBe(1);
		});
	});

	it("reloads empty room when non-live timeline event arrives", async () => {
		// Room exists but has no events initially
		const roomA = createMockRoom("!roomA:test", []);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(0);

			// Simulate backfill: room now has events, non-live event arrives
			const updatedRoom = createMockRoom("!roomA:test", [
				textMessage("!roomA:test", "$1", "@alice:test", "backfilled", 1000),
			]);
			client.__setRooms(new Map([["!roomA:test", updatedRoom]]));

			// Emit a non-live timeline event
			const fakeEvent = {
				getId: () => "$1",
				getRoomId: () => "!roomA:test",
				getSender: () => "@alice:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "backfilled" }),
				getTs: () => 1000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", fakeEvent, updatedRoom, false, false, {
				liveEvent: false,
			});

			await flushPromises();

			expect(events.length).toBe(1);
			expect(events[0].body).toBe("backfilled");
		});
	});

	it("non-live events do not cause reload when room already has events", async () => {
		// Room has displayable events
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "existing", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async (_dispose) => {
			let getRoomCalls = 0;
			const originalGetRoom = client.getRoom;
			client.getRoom = (roomId: string) => {
				getRoomCalls++;
				return originalGetRoom(roomId);
			};

			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);
			const callsAfterLoad = getRoomCalls;

			// Emit a non-live timeline event for a room that already has events
			// The guard should skip reload (events.length > 0)
			const fakeEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@alice:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "backfilled" }),
				getTs: () => 500,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", fakeEvent, roomA, false, false, {
				liveEvent: false,
			});

			await flushPromises();

			// getRoom should NOT have been called — non-live event skipped
			expect(getRoomCalls).toBe(callsAfterLoad);
			// Events unchanged
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("existing");
		});
	});

	it("does not repeatedly reload on multiple non-live events for empty room", async () => {
		// Room has only non-displayable events
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$1",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 1000,
			},
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			let getRoomCalls = 0;
			const originalGetRoom = client.getRoom;
			client.getRoom = (roomId: string) => {
				getRoomCalls++;
				return originalGetRoom(roomId);
			};

			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(0);
			const callsAfterLoad = getRoomCalls;

			const makeFakeEvent = (id: string, ts: number) => ({
				getId: () => id,
				getRoomId: () => "!roomA:test",
				getSender: () => "@alice:test",
				getType: () => "m.room.member",
				getContent: () => ({ membership: "join" }),
				getTs: () => ts,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			});

			// Emit 5 non-live events — should only reload once (not 5 times)
			for (let i = 0; i < 5; i++) {
				client.__emit(
					"Room.timeline",
					makeFakeEvent(`$evt${i}`, 2000 + i),
					roomA,
					false,
					false,
					{ liveEvent: false },
				);
			}

			await flushPromises();

			// Only 1 additional getRoom call (from the single backfill reload)
			expect(getRoomCalls - callsAfterLoad).toBe(1);
			expect(events.length).toBe(0);
		});
	});

	it("auto-backfills when initial window has no displayable events but can paginate", async () => {
		// Simulates the just-joined / sparse-sync case: the live timeline
		// contains only the user's own m.room.member join event (non-
		// displayable), and the server set a backward pagination token.
		// Without auto-backfill, the user sees an empty timeline until they
		// manually scroll up or refresh the browser (bug repro: leave a
		// channel, rejoin, click in — empty).
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$join",
				roomId: "!roomA:test",
				sender: "@test:example.com",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 1000,
			},
		]);
		roomA.getLiveTimeline().getPaginationToken = () => "token-1";

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		// First paginateEventTimeline call appends a displayable message,
		// then nulls the backward token. Returning false signals "no more".
		client.paginateEventTimeline = vi.fn().mockImplementation(async () => {
			const room = client.getRoom("!roomA:test");
			if (room) {
				const timeline = room.getLiveTimeline();
				const olderEvent = {
					getId: () => "$older",
					getRoomId: () => "!roomA:test",
					getSender: () => "@alice:test",
					getType: () => "m.room.message",
					getContent: () => ({ msgtype: "m.text", body: "older msg" }),
					getTs: () => 500,
					isEncrypted: () => false,
					isDecryptionFailure: () => false,
					replacingEventId: () => null,
					event: { redacts: undefined },
				};
				timeline.__prepend(
					olderEvent as unknown as Parameters<typeof timeline.__prepend>[0],
				);
				timeline.getPaginationToken = () => null;
			}
			return false;
		});

		await withRoot(async () => {
			const { events, loading, canLoadOlder } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			// Auto-backfill kicked in and surfaced the older message.
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("older msg");
			expect(loading()).toBe(false);
			expect(canLoadOlder()).toBe(false);
			expect(client.paginateEventTimeline).toHaveBeenCalledTimes(1);
		});
	});

	it("auto-backfill caps the number of paginate rounds", async () => {
		// Pagination keeps returning non-displayable events (more member
		// churn) so the loop never finds anything displayable. The cap
		// must bound the number of /messages calls.
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$join",
				roomId: "!roomA:test",
				sender: "@test:example.com",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 1000,
			},
		]);
		roomA.getLiveTimeline().getPaginationToken = () => "token-1";

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		let callIdx = 0;
		client.paginateEventTimeline = vi.fn().mockImplementation(async () => {
			callIdx++;
			const room = client.getRoom("!roomA:test");
			if (room) {
				const timeline = room.getLiveTimeline();
				const memberEvent = {
					getId: () => `$mem${callIdx}`,
					getRoomId: () => "!roomA:test",
					getSender: () => "@alice:test",
					getType: () => "m.room.member",
					getContent: () => ({ membership: "join" }),
					getTs: () => 500 - callIdx,
					isEncrypted: () => false,
					isDecryptionFailure: () => false,
					replacingEventId: () => null,
					event: { redacts: undefined },
				};
				timeline.__prepend(
					memberEvent as unknown as Parameters<typeof timeline.__prepend>[0],
				);
				// Keep the token non-null so canPaginate stays true.
			}
			return true;
		});

		await withRoot(async () => {
			const { events, loading, canLoadOlder } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(0);
			expect(loading()).toBe(false);
			// Capped at the INITIAL_BACKFILL_MAX_ROUNDS internal constant (3).
			expect(client.paginateEventTimeline).toHaveBeenCalledTimes(3);
			// canLoadOlder remains true so the user can scroll to keep going.
			expect(canLoadOlder()).toBe(true);
		});
	});

	it("auto-backfill is skipped when initial window already has displayable events", async () => {
		// Sanity: rooms that already have visible content must not trigger
		// any background pagination on initial load.
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
		]);
		roomA.getLiveTimeline().getPaginationToken = () => "token-1";
		const client = createMockClient(new Map([["!roomA:test", roomA]]));
		client.paginateEventTimeline = vi.fn().mockResolvedValue(false);

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(client.paginateEventTimeline).not.toHaveBeenCalled();
		});
	});

	it("auto-backfill is skipped when there is no backward pagination token", async () => {
		// Without a prev_batch token, canPaginate(Backward) is false — the
		// timeline genuinely has no more history, so no auto-backfill.
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$join",
				roomId: "!roomA:test",
				sender: "@test:example.com",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 1000,
			},
		]);
		// No pagination token set; default returns null.
		const client = createMockClient(new Map([["!roomA:test", roomA]]));
		client.paginateEventTimeline = vi.fn().mockResolvedValue(false);

		await withRoot(async () => {
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(0);
			expect(loading()).toBe(false);
			expect(client.paginateEventTimeline).not.toHaveBeenCalled();
		});
	});

	it("auto-backfill is discarded when the room changes mid-flight", async () => {
		// A→B switch during the in-flight backfill must not leak room A's
		// state into room B's view.
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$joinA",
				roomId: "!roomA:test",
				sender: "@test:example.com",
				type: "m.room.member",
				content: { membership: "join" },
				ts: 1000,
			},
		]);
		roomA.getLiveTimeline().getPaginationToken = () => "token-a";
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B msg", 2000),
		]);

		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		let resolveA!: (value: boolean) => void;
		client.paginateEventTimeline = vi.fn().mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					resolveA = (val: boolean) => {
						// When eventually resolved, the rebuild of room A's
						// window must not poison room B's events store.
						const t = roomA.getLiveTimeline();
						const olderEvent = {
							getId: () => "$olderA",
							getRoomId: () => "!roomA:test",
							getSender: () => "@alice:test",
							getType: () => "m.room.message",
							getContent: () => ({ msgtype: "m.text", body: "leaked from A" }),
							getTs: () => 500,
							isEncrypted: () => false,
							isDecryptionFailure: () => false,
							replacingEventId: () => null,
							event: { redacts: undefined },
						};
						t.__prepend(
							olderEvent as unknown as Parameters<typeof t.__prepend>[0],
						);
						t.getPaginationToken = () => null;
						resolve(val);
					};
				}),
		);

		await withRoot(async () => {
			const [rid, setRid] = createSignal("!roomA:test");
			const { events } = useTimeline(client as unknown as MatrixClient, rid);

			await flushPromises();
			// Backfill in flight (pagination promise not yet resolved).
			expect(events.length).toBe(0);

			// Switch to room B before A's backfill resolves.
			setRid("!roomB:test");
			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B msg");

			// Now resolve A — must not mutate room B's events.
			resolveA(false);
			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B msg");
		});
	});

	it("loadOlderMessages fetches and prepends older events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$3", "@alice:test", "recent", 3000),
		]);
		// Set pagination token before useTimeline initializes
		roomA.getLiveTimeline().getPaginationToken = () => "token-1";

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		// Mock paginateEventTimeline to simulate adding older events
		client.paginateEventTimeline = vi.fn().mockImplementation(async () => {
			const room = client.getRoom("!roomA:test");
			if (room) {
				const timeline = room.getLiveTimeline();
				const olderEvent = {
					getId: () => "$1",
					getRoomId: () => "!roomA:test",
					getSender: () => "@bob:test",
					getType: () => "m.room.message",
					getContent: () => ({ msgtype: "m.text", body: "older msg" }),
					getTs: () => 1000,
					isEncrypted: () => false,
					isDecryptionFailure: () => false,
					replacingEventId: () => null,
					event: { redacts: undefined },
				};
				// Use __prepend to properly track baseIndex for TimelineWindow
				timeline.__prepend(
					olderEvent as unknown as Parameters<typeof timeline.__prepend>[0],
				);
				timeline.getPaginationToken = () => "token-2";
			}
			return true; // hasMore
		});

		await withRoot(async () => {
			const { events, loadOlderMessages, canLoadOlder, loadingOlder } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("recent");
			expect(canLoadOlder()).toBe(true);

			await loadOlderMessages();
			await flushPromises();

			expect(events.length).toBe(2);
			expect(events[0].body).toBe("older msg");
			expect(events[1].body).toBe("recent");
			expect(loadingOlder()).toBe(false);
			expect(canLoadOlder()).toBe(true);
		});
	});

	it("discards stale pagination results after A→B→A room switch", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "room A msg", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B msg", 2000),
		]);
		// Room A has a pagination token
		roomA.getLiveTimeline().getPaginationToken = () => "token-a";

		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		// paginateEventTimeline will resolve after a delay, simulating network.
		// When it resolves, it mutates room A's timeline with an older event.
		let resolvePagination!: (value: boolean) => void;
		client.paginateEventTimeline = vi.fn().mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					resolvePagination = (val: boolean) => {
						// Simulate SDK prepending older events to the timeline
						const timeline = roomA.getLiveTimeline();
						const staleEvent = {
							getId: () => "$stale",
							getRoomId: () => "!roomA:test",
							getSender: () => "@old:test",
							getType: () => "m.room.message",
							getContent: () => ({
								msgtype: "m.text",
								body: "STALE - should not appear",
							}),
							getTs: () => 500,
							isEncrypted: () => false,
							isDecryptionFailure: () => false,
							replacingEventId: () => null,
							event: { redacts: undefined },
						};
						// Use __prepend to properly track baseIndex
						timeline.__prepend(
							staleEvent as unknown as Parameters<typeof timeline.__prepend>[0],
						);
						resolve(val);
					};
				}),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!roomA:test");
			const { events, loadOlderMessages } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");

			// Start pagination for room A (will hang until we resolve)
			const paginationPromise = loadOlderMessages();

			// Switch to room B while pagination is in flight
			setRoomId("!roomB:test");
			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B msg");

			// Switch back to room A (A→B→A)
			setRoomId("!roomA:test");
			await flushPromises();
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");

			// Now resolve the stale pagination from the first visit to A
			resolvePagination(true);
			await paginationPromise;
			await flushPromises();

			// Events should still be room A's current state — stale pagination
			// result must NOT be applied (generation counter should catch it)
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room A msg");
		});
	});

	it("withholds live events when followingLive is false", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(canLoadNewer()).toBe(false);

			// Stop following live (user scrolled up)
			setFollowingLive(false);

			// Simulate a live message arriving
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "new msg" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});

			await flushPromises();

			// Event should NOT be added to the store
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("initial");
			// canLoadNewer should be set
			expect(canLoadNewer()).toBe(true);
		});
	});

	it("canLoadNewer is set for non-displayable skipped events too", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			setFollowingLive(false);

			// Simulate a live reaction (non-displayable) arriving
			const reactionEvent = {
				getId: () => "$r1",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.reaction",
				getContent: () => ({
					"m.relates_to": {
						rel_type: "m.annotation",
						event_id: "$1",
						key: "👍",
					},
				}),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", reactionEvent, roomA, false, false, {
				liveEvent: true,
			});

			await flushPromises();

			// canLoadNewer should still be set (non-displayable events count)
			expect(canLoadNewer()).toBe(true);
			// Store unchanged
			expect(events.length).toBe(1);
		});
	});

	it("jumpToLive reloads from live end and resets state", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, loading, setFollowingLive, jumpToLive } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);

			// Stop following, simulate withheld event
			setFollowingLive(false);
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "new msg" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			// Append to the underlying timeline so it's available after reload
			const timeline = roomA.getLiveTimeline();
			timeline.__append(
				liveEvent as unknown as Parameters<typeof timeline.__append>[0],
			);
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});

			await flushPromises();
			expect(canLoadNewer()).toBe(true);
			expect(events.length).toBe(1);

			// Jump to live
			jumpToLive();
			await flushPromises();

			// Should reload and show both events
			expect(canLoadNewer()).toBe(false);
			expect(loading()).toBe(false);
			expect(events.length).toBe(2);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("new msg");
		});
	});

	it("setFollowingLive(true) auto-jumps when behind live", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			setFollowingLive(false);

			// Simulate withheld live event
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "new msg" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			const timeline = roomA.getLiveTimeline();
			timeline.__append(
				liveEvent as unknown as Parameters<typeof timeline.__append>[0],
			);
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});
			await flushPromises();
			expect(canLoadNewer()).toBe(true);

			// Setting followingLive back to true should trigger jumpToLive
			setFollowingLive(true);
			await flushPromises();

			expect(canLoadNewer()).toBe(false);
			expect(events.length).toBe(2);
			expect(events[1].body).toBe("new msg");
		});
	});

	it("room switch resets followingLive and canLoadNewer", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "room A", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B", 2000),
		]);
		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!roomA:test");
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);

			await flushPromises();
			setFollowingLive(false);

			// Simulate withheld event in room A
			const liveEvent = {
				getId: () => "$2",
				getRoomId: () => "!roomA:test",
				getSender: () => "@bob:test",
				getType: () => "m.room.message",
				getContent: () => ({ msgtype: "m.text", body: "withheld" }),
				getTs: () => 2000,
				isEncrypted: () => false,
				isDecryptionFailure: () => false,
				replacingEventId: () => null,
				event: { redacts: undefined },
			};
			client.__emit("Room.timeline", liveEvent, roomA, false, false, {
				liveEvent: true,
			});
			await flushPromises();
			expect(canLoadNewer()).toBe(true);

			// Switch to room B — should reset all forward pagination state
			setRoomId("!roomB:test");
			await flushPromises();

			expect(canLoadNewer()).toBe(false);
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B");
		});
	});

	it("live events resume when followingLive is restored without pending newer", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			// Stop following, then resume without any events arriving
			setFollowingLive(false);
			setFollowingLive(true);
			expect(canLoadNewer()).toBe(false);

			// Now a live event should be handled normally
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$2", "@bob:test", "live msg", 2000),
			);

			await flushPromises();

			// Event should be added normally
			expect(events.length).toBe(2);
			expect(events[1].body).toBe("live msg");
		});
	});

	it("loadNewerMessages paginates forward and shows newer events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$2", "@alice:test", "msg 2", 2000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const {
				events,
				canLoadNewer,
				loadingNewer,
				setFollowingLive,
				loadNewerMessages,
				getWindowEvents,
			} = useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(2);
			expect(canLoadNewer()).toBe(false);

			// Stop following live (user scrolled up)
			setFollowingLive(false);

			// Simulate 3 live events arriving while scrolled up
			for (let i = 3; i <= 5; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$${i}`,
						"@bob:test",
						`msg ${i}`,
						i * 1000,
					),
				);
			}

			await flushPromises();
			expect(events.length).toBe(2); // withheld
			expect(canLoadNewer()).toBe(true);

			// Forward paginate to catch up
			await loadNewerMessages();
			await flushPromises();

			// All 5 events should now be visible
			expect(events.length).toBe(5);
			expect(events[2].body).toBe("msg 3");
			expect(events[3].body).toBe("msg 4");
			expect(events[4].body).toBe("msg 5");
			expect(loadingNewer()).toBe(false);
			expect(canLoadNewer()).toBe(false);
			// Window should contain all events
			expect(getWindowEvents().length).toBe(5);
		});
	});

	it("loadNewerMessages catches up then view restores followingLive for live events", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive, loadNewerMessages } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);

			setFollowingLive(false);

			// 2 live events arrive while scrolled up
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$2", "@bob:test", "withheld 1", 2000),
			);
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$3", "@bob:test", "withheld 2", 3000),
			);

			await flushPromises();
			expect(canLoadNewer()).toBe(true);
			expect(events.length).toBe(1);

			// Catch up via forward pagination
			await loadNewerMessages();
			await flushPromises();

			expect(canLoadNewer()).toBe(false);
			expect(events.length).toBe(3);

			// loadNewerMessages does NOT restore followingLive — the view
			// drives that transition via the [atBottom, canLoadNewer] effect.
			// Simulate the view re-enabling following after catch-up.
			setFollowingLive(true);

			// New live events should now appear immediately
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$4",
					"@bob:test",
					"live after catchup",
					4000,
				),
			);

			await flushPromises();

			expect(events.length).toBe(4);
			expect(events[3].body).toBe("live after catchup");
			expect(canLoadNewer()).toBe(false);
		});
	});

	it("loadNewerMessages handles partial catch-up requiring multiple pages", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$0", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, canLoadNewer, setFollowingLive, loadNewerMessages } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			expect(events.length).toBe(1);

			setFollowingLive(false);

			// Append 55 events (more than PAGINATION_SIZE=50 in useTimeline.ts)
			for (let i = 1; i <= 55; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$new${i}`,
						"@bob:test",
						`new msg ${i}`,
						2000 + i,
					),
				);
			}

			await flushPromises();
			expect(canLoadNewer()).toBe(true);
			expect(events.length).toBe(1);

			// First forward pagination — picks up 50 of 55 withheld events
			await loadNewerMessages();
			await flushPromises();

			expect(events.length).toBe(51); // 1 initial + 50 paginated
			expect(canLoadNewer()).toBe(true); // 5 remaining

			// Second forward pagination — picks up remaining 5
			await loadNewerMessages();
			await flushPromises();

			expect(events.length).toBe(56); // 1 initial + 55 total
			expect(canLoadNewer()).toBe(false); // fully caught up
		});
	});

	it("loadNewerMessages only includes displayable events after forward pagination", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, setFollowingLive, loadNewerMessages, getWindowEvents } =
				useTimeline(client as unknown as MatrixClient, () => "!roomA:test");

			await flushPromises();
			setFollowingLive(false);

			// Append displayable events
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$2", "@bob:test", "msg 2", 2000),
			);
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$3", "@bob:test", "msg 3", 3000),
			);

			// Append non-displayable: state event
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$s1",
					"@alice:test",
					"",
					3500,
					"m.room.member",
					{ membership: "join" },
				),
			);

			// Append non-displayable: reaction
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$r1",
					"@bob:test",
					"",
					3600,
					"m.reaction",
					{
						"m.relates_to": {
							rel_type: "m.annotation",
							event_id: "$1",
							key: "👍",
						},
					},
				),
			);

			// Append one more displayable
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$4", "@bob:test", "msg 4", 4000),
			);

			await flushPromises();

			await loadNewerMessages();
			await flushPromises();

			// Window has all 6 events (initial + 3 messages + 1 state + 1 reaction)
			expect(getWindowEvents().length).toBe(6);
			// Store has only displayable events
			expect(events.length).toBe(4);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("msg 2");
			expect(events[2].body).toBe("msg 3");
			expect(events[3].body).toBe("msg 4");
		});
	});

	it("syncStoreEviction trims store events evicted from window", async () => {
		// Use a small windowLimit to make eviction testable with few events.
		// Initial events fill the window; non-displayable live events then
		// trigger eviction, and the store must stay in sync.
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$2", "@alice:test", "msg 2", 2000),
			textMessage("!roomA:test", "$3", "@alice:test", "msg 3", 3000),
			textMessage("!roomA:test", "$4", "@alice:test", "msg 4", 4000),
			textMessage("!roomA:test", "$5", "@alice:test", "msg 5", 5000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, getWindowEvents } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
				{ windowLimit: 5, initialWindowSize: 5 },
			);

			await flushPromises();
			expect(events.length).toBe(5);
			expect(events[0].body).toBe("msg 1");

			// Emit non-displayable live events to trigger eviction.
			// Each extends the window by 1 and evicts 1 from the oldest end.
			for (let i = 1; i <= 3; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$s${i}`,
						"@alice:test",
						"",
						6000 + i,
						"m.room.member",
						{ membership: "join" },
					),
				);
			}

			await flushPromises();

			// Window evicted $1, $2, $3 (replaced by 3 state events).
			// Store must also have trimmed those events.
			expect(events[0].body).toBe("msg 4");
			expect(events[1].body).toBe("msg 5");
			expect(events.length).toBe(2);

			// Every store event must exist in the window
			const windowIds = new Set(getWindowEvents().map((e) => e.getId()));
			for (let i = 0; i < events.length; i++) {
				expect(windowIds.has(events[i].eventId)).toBe(true);
			}
		});
	});

	it("syncStoreEviction is a no-op below window capacity", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "msg 1", 1000),
			textMessage("!roomA:test", "$2", "@alice:test", "msg 2", 2000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
				{ windowLimit: 10, initialWindowSize: 10 },
			);

			await flushPromises();
			expect(events.length).toBe(2);

			// Add live events — window is well below capacity, no eviction
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$3", "@bob:test", "msg 3", 3000),
			);

			await flushPromises();

			// All events remain (no eviction, no trimming)
			expect(events.length).toBe(3);
			expect(events[0].body).toBe("msg 1");
			expect(events[2].body).toBe("msg 3");
		});
	});

	it("captures live events arriving during loadRoom() async gap", async () => {
		// Regression test for the microtask race: loadRoom() sets
		// currentTimelineWindow = null before tw.load().then() publishes
		// the window. A live event firing in that gap must not be lost.
		// We use jumpToLive() to trigger loadRoom() after the initial
		// load has completed, creating the null-window gap.
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			// jumpToLive calls loadRoom synchronously, which sets
			// currentTimelineWindow = null and queues .then() as a microtask.
			jumpToLive();

			// Fire a live event during the gap (window is null).
			appendLive(
				client,
				roomA,
				createFakeEvent("!roomA:test", "$live", "@bob:test", "gap msg", 2000),
			);

			await flushPromises();

			// Both the initial event and the gap event must appear
			expect(events.length).toBe(2);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("gap msg");
		});
	});

	it("captures multiple live events during loadRoom() async gap", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			jumpToLive();

			// Fire 3 live events during the gap
			for (let i = 1; i <= 3; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$live${i}`,
						"@bob:test",
						`gap msg ${i}`,
						1000 + i,
					),
				);
			}

			await flushPromises();

			expect(events.length).toBe(4);
			expect(events[0].body).toBe("initial");
			expect(events[1].body).toBe("gap msg 1");
			expect(events[2].body).toBe("gap msg 2");
			expect(events[3].body).toBe("gap msg 3");
		});
	});

	it("non-displayable live events during loadRoom() gap do not create bogus store entries", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "initial", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);

			jumpToLive();

			// Fire a non-displayable event (state) during the gap
			appendLive(
				client,
				roomA,
				createFakeEvent(
					"!roomA:test",
					"$state",
					"@alice:test",
					"",
					2000,
					"m.room.member",
					{ membership: "join" },
				),
			);

			await flushPromises();

			// Only the initial displayable event should be in the store
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("initial");
		});
	});

	it("store event IDs match displayable window event IDs after mixed live traffic", async () => {
		// Invariant test: after a burst of mixed displayable and non-displayable
		// live events that trigger eviction, the store must exactly equal the
		// displayable events in the window.
		const initialEvents = [];
		for (let i = 1; i <= 8; i++) {
			initialEvents.push(
				textMessage(
					"!roomA:test",
					`$${i}`,
					"@alice:test",
					`msg ${i}`,
					i * 1000,
				),
			);
		}
		const roomA = createMockRoom("!roomA:test", initialEvents);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, getWindowEvents } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
				{ windowLimit: 8, initialWindowSize: 8 },
			);

			await flushPromises();
			expect(events.length).toBe(8);

			// Mixed burst: 3 displayable + 5 non-displayable = 8 events
			// Window evicts 8 from the oldest end, replacing with new events.
			for (let i = 1; i <= 5; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$state${i}`,
						"@alice:test",
						"",
						10000 + i,
						"m.room.member",
						{ membership: "join" },
					),
				);
			}
			for (let i = 1; i <= 3; i++) {
				appendLive(
					client,
					roomA,
					createFakeEvent(
						"!roomA:test",
						`$new${i}`,
						"@bob:test",
						`new msg ${i}`,
						20000 + i,
					),
				);
			}

			await flushPromises();

			// Invariant: store IDs === displayable window IDs
			const windowEvents = getWindowEvents();
			const displayableWindowIds = windowEvents
				.filter(
					(e) => e.getType() === "m.room.message" && e.getContent()?.msgtype,
				)
				.map((e) => e.getId());
			const storeIds = Array.from(
				{ length: events.length },
				(_, i) => events[i].eventId,
			);
			expect(storeIds).toEqual(displayableWindowIds);
		});
	});

	it("canLoadOlder is set before loading becomes false (signal ordering)", async () => {
		// Regression guard: dependents must never observe the transient state
		// (loading=false, canLoadOlder=false, events.length > 0) when the
		// room actually has backward pagination available. loadRoom must set
		// canLoadOlder before setting loading=false.
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
			textMessage("!roomA:test", "$2", "@bob:test", "world", 2000),
		]);
		// Simulate a room with older messages available
		roomA.__setPaginationToken("t_backward");
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const owner = getOwner();
			if (!owner) throw new Error("Expected Solid owner inside createRoot");
			const { events, loading, canLoadOlder, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(loading()).toBe(false);
			expect(events.length).toBe(2);
			expect(canLoadOlder()).toBe(true);

			// Capture signal states at every reactive notification during reload.
			// createEffect tracks both signals, so it fires whenever either changes.
			// Use runWithOwner to keep the effect inside the root (avoids leak
			// after await boundaries lose Solid's owner context).
			const states: { loading: boolean; canLoadOlder: boolean }[] = [];
			runWithOwner(owner, () => {
				createEffect(() => {
					states.push({
						loading: loading(),
						canLoadOlder: canLoadOlder(),
					});
				});
			});

			// jumpToLive → loadRoom resets canLoadOlder=false and loading=true,
			// then .then() must set canLoadOlder=true before setting loading=false.
			jumpToLive();
			await flushPromises();

			// Verify the invariant: every state where loading=false must also
			// have canLoadOlder=true (since the room has a pagination token).
			// If the ordering were wrong (loading=false set first), we'd see
			// a transient {loading: false, canLoadOlder: false}.
			const loadDoneStates = states.filter((s) => !s.loading);
			expect(loadDoneStates.length).toBeGreaterThan(0);
			for (const s of loadDoneStates) {
				expect(s.canLoadOlder).toBe(true);
			}
		});
	});

	it("room switch clears events immediately (no stale events during load)", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "room A", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", [
			textMessage("!roomB:test", "$b1", "@bob:test", "room B", 2000),
		]);
		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!roomA:test");
			const { events, loading } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(loading()).toBe(false);

			// Switch rooms — events must be cleared synchronously so
			// stale room A events are never visible under room B's header.
			setRoomId("!roomB:test");

			// Before promises flush: events cleared, loading true
			expect(events.length).toBe(0);
			expect(loading()).toBe(true);

			await flushPromises();

			// After load: room B events
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("room B");
			expect(loading()).toBe(false);
		});
	});

	it("jumpToLive preserves events during same-room reload (no spinner flash)", async () => {
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$1", "@alice:test", "hello", 1000),
		]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, loading, jumpToLive } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);

			await flushPromises();
			expect(events.length).toBe(1);
			expect(loading()).toBe(false);

			// jumpToLive reloads the same room — events must stay so the
			// view doesn't flash a spinner.
			jumpToLive();

			// Before promises flush: loading true, but events still present
			expect(loading()).toBe(true);
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("hello");

			await flushPromises();

			expect(loading()).toBe(false);
			expect(events.length).toBe(1);
		});
	});

	// ─── Local-echo / status tracking (issue #53) ─────────────────────

	it("local-echo sends appear with SENDING status, then transition to null on confirm", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const roomA = createMockRoom("!roomA:test", []);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createFakeEvent(
				"!roomA:test",
				"~local.1",
				"@me:test",
				"hello",
				1000,
			);
			echo.__setStatus(EventStatus.SENDING);
			appendLive(client, roomA, echo);

			expect(events.length).toBe(1);
			expect(events[0].status).toBe(EventStatus.SENDING);

			// Server confirms: SDK rekeys event ID and clears status, then
			// fires LocalEchoUpdated with the old ID for reconciliation.
			echo.__setId("$server.1");
			echo.__setStatus(null);
			client.__emit(
				"Room.localEchoUpdated",
				echo,
				roomA,
				"~local.1",
				EventStatus.SENDING,
			);

			expect(events.length).toBe(1);
			expect(events[0].eventId).toBe("$server.1");
			expect(events[0].status).toBe(null);
		});
	});

	it("local-echo send transitioning to NOT_SENT keeps the event with failed status", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const roomA = createMockRoom("!roomA:test", []);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createFakeEvent(
				"!roomA:test",
				"~local.2",
				"@me:test",
				"oops",
				1000,
			);
			echo.__setStatus(EventStatus.SENDING);
			appendLive(client, roomA, echo);

			echo.__setStatus(EventStatus.NOT_SENT);
			client.__emit(
				"Room.localEchoUpdated",
				echo,
				roomA,
				undefined,
				EventStatus.SENDING,
			);

			expect(events.length).toBe(1);
			expect(events[0].status).toBe(EventStatus.NOT_SENT);
		});
	});

	it("cancelled local echoes are removed via the _removed Timeline path", async () => {
		const roomA = createMockRoom("!roomA:test", []);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createFakeEvent(
				"!roomA:test",
				"~local.3",
				"@me:test",
				"nope",
				1000,
			);
			appendLive(client, roomA, echo);
			expect(events.length).toBe(1);

			// SDK fires a removed Timeline event before LocalEchoUpdated(CANCELLED).
			client.__emit("Room.timeline", echo, roomA, false, true, {
				liveEvent: true,
			});
			expect(events.length).toBe(0);
		});
	});

	it("LocalEchoUpdated from other rooms does not mutate the current room's store", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const roomA = createMockRoom("!roomA:test", [
			textMessage("!roomA:test", "$a1", "@alice:test", "in A", 1000),
		]);
		const roomB = createMockRoom("!roomB:test", []);
		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();
			expect(events.length).toBe(1);

			const otherEcho = createFakeEvent(
				"!roomB:test",
				"~local.B",
				"@me:test",
				"in B",
				2000,
			);
			otherEcho.__setStatus(EventStatus.NOT_SENT);
			// Wrong room — handler must ignore.
			client.__emit(
				"Room.localEchoUpdated",
				otherEcho,
				roomB,
				undefined,
				EventStatus.SENDING,
			);
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("in A");
		});
	});

	it("failed reaction echoes are excluded from the parent's reaction count", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const parent = textMessage(
			"!roomA:test",
			"$parent",
			"@alice:test",
			"target",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [parent]);

		// Build two reaction events: one SENT, one NOT_SENT. Plant them
		// in the room's relations so eventToTimelineEvent aggregates over
		// both and filters the failed one.
		const sentReaction = createMatrixEvent({
			eventId: "$r1",
			roomId: "!roomA:test",
			sender: "@bob:test",
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🚀",
				},
			},
			ts: 2000,
		});
		const failedReaction = createMatrixEvent({
			eventId: "~local.r2",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🚀",
				},
			},
			ts: 3000,
			status: EventStatus.NOT_SENT,
		});

		// Override the relations stub to return a sorted-annotations map
		// containing both reactions for the "🚀" key.
		const timelineSet = roomA.getUnfilteredTimelineSet();
		timelineSet.relations = {
			getChildEventsForEvent: (_eventId: string) => ({
				getSortedAnnotationsByKey: () => [
					["🚀", new Set([sentReaction, failedReaction])],
				],
			}),
		} as unknown as typeof timelineSet.relations;

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			// Only the sent reaction should count, with one sender.
			expect(events[0].reactions["🚀"].count).toBe(1);
			expect(events[0].reactions["🚀"].senders).toHaveLength(1);
			expect(events[0].reactions["🚀"].senders[0].userId).toBe("@bob:test");
			// myReactions tracks the user's own pressed key. The user's
			// own reaction failed (NOT_SENT), so myReactions must not
			// include "🚀" — otherwise the pressed pill state lies.
			expect(events[0].myReactions["🚀"]).toBeUndefined();
		});
	});

	it("duplicate reactions from the same sender are deduped in count and senders", async () => {
		const parent = textMessage(
			"!roomA:test",
			"$parent",
			"@alice:test",
			"target",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [parent]);

		// Two sent reactions from the SAME sender (transient local-echo
		// reconciliation edge case). Both successful — dedupe must keep
		// only the first so count and senders.length stay equal.
		const reaction1 = createMatrixEvent({
			eventId: "$r1",
			roomId: "!roomA:test",
			sender: "@bob:test",
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🚀",
				},
			},
			ts: 2000,
		});
		const reaction2 = createMatrixEvent({
			eventId: "$r2",
			roomId: "!roomA:test",
			sender: "@bob:test",
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🚀",
				},
			},
			ts: 3000,
		});

		const timelineSet = roomA.getUnfilteredTimelineSet();
		timelineSet.relations = {
			getChildEventsForEvent: (_eventId: string) => ({
				getSortedAnnotationsByKey: () => [
					["🚀", new Set([reaction1, reaction2])],
				],
			}),
		} as unknown as typeof timelineSet.relations;

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			const agg = events[0].reactions["🚀"];
			expect(agg.count).toBe(1);
			expect(agg.senders).toHaveLength(1);
			expect(agg.senders[0].userId).toBe("@bob:test");
		});
	});

	it("myReactions tracks the latest event id when a sender has multiple echoes", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const parent = textMessage(
			"!roomA:test",
			"$parent",
			"@alice:test",
			"target",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [parent]);

		// Simulate the transient window where a local-echo for my
		// reaction still exists alongside the server-confirmed event:
		// the dedupe must not strand myReactions on the stale txn id.
		const myUserId = "@test:example.com";
		const localEcho = createMatrixEvent({
			eventId: "~local.r1",
			roomId: "!roomA:test",
			sender: myUserId,
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🚀",
				},
			},
			ts: 2000,
			status: EventStatus.SENDING,
		});
		const serverConfirmed = createMatrixEvent({
			eventId: "$server.r1",
			roomId: "!roomA:test",
			sender: myUserId,
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🚀",
				},
			},
			ts: 3000,
		});

		const timelineSet = roomA.getUnfilteredTimelineSet();
		timelineSet.relations = {
			getChildEventsForEvent: (_eventId: string) => ({
				getSortedAnnotationsByKey: () => [
					["🚀", new Set([localEcho, serverConfirmed])],
				],
			}),
		} as unknown as typeof timelineSet.relations;

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			// Count and senders dedupe to one entry, but myReactions
			// must point at the server-confirmed id (status === null
			// beats pending status) so the redaction path targets the
			// correct event.
			expect(events[0].reactions["🚀"].count).toBe(1);
			expect(events[0].myReactions["🚀"]).toBe("$server.r1");
		});
	});

	it("myReactions prefers server-confirmed event regardless of Set iteration order", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const parent = textMessage(
			"!roomA:test",
			"$parent",
			"@alice:test",
			"target",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [parent]);

		// Same as the previous test but with the server-confirmed
		// event iterated FIRST. matrix-js-sdk does not guarantee Set
		// iteration order matches send order, so the resolution must
		// pick by status/ts, not first/last position.
		const myUserId = "@test:example.com";
		const localEcho = createMatrixEvent({
			eventId: "~local.r2",
			roomId: "!roomA:test",
			sender: myUserId,
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🎉",
				},
			},
			ts: 2000,
			status: EventStatus.SENDING,
		});
		const serverConfirmed = createMatrixEvent({
			eventId: "$server.r2",
			roomId: "!roomA:test",
			sender: myUserId,
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🎉",
				},
			},
			ts: 3000,
		});

		const timelineSet = roomA.getUnfilteredTimelineSet();
		timelineSet.relations = {
			getChildEventsForEvent: (_eventId: string) => ({
				getSortedAnnotationsByKey: () => [
					["🎉", new Set([serverConfirmed, localEcho])],
				],
			}),
		} as unknown as typeof timelineSet.relations;

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			expect(events[0].myReactions["🎉"]).toBe("$server.r2");
		});
	});

	it("senders are sorted alphabetically for a stable tooltip order", async () => {
		const parent = textMessage(
			"!roomA:test",
			"$parent",
			"@host:test",
			"target",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [parent]);

		// Insert reactions in non-alphabetical iteration order; the
		// rendered senders array must come out sorted by display name
		// so the tooltip doesn't shuffle between renders.
		const r1 = createMatrixEvent({
			eventId: "$r1",
			roomId: "!roomA:test",
			sender: "@charlie:test",
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🎯",
				},
			},
			ts: 2000,
		});
		const r2 = createMatrixEvent({
			eventId: "$r2",
			roomId: "!roomA:test",
			sender: "@alice:test",
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🎯",
				},
			},
			ts: 2100,
		});
		const r3 = createMatrixEvent({
			eventId: "$r3",
			roomId: "!roomA:test",
			sender: "@bob:test",
			type: "m.reaction",
			content: {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: "$parent",
					key: "🎯",
				},
			},
			ts: 2200,
		});

		const timelineSet = roomA.getUnfilteredTimelineSet();
		timelineSet.relations = {
			getChildEventsForEvent: (_eventId: string) => ({
				getSortedAnnotationsByKey: () => [["🎯", new Set([r1, r2, r3])]],
			}),
		} as unknown as typeof timelineSet.relations;

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			const senders = events[0].reactions["🎯"].senders;
			// Display names default to MXID when no member is found in
			// the mock room, so sort by MXID: alice < bob < charlie.
			expect(senders.map((s) => s.userId)).toEqual([
				"@alice:test",
				"@bob:test",
				"@charlie:test",
			]);
		});
	});

	it("failed edit echoes do not mark the original message as edited", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const original: import("../../../test/mockClient").MockEvent = {
			eventId: "$orig",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.message",
			content: { msgtype: "m.text", body: "original body" },
			ts: 1000,
			replacingEvent: {
				eventId: "~local.edit",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.message",
				content: {
					"m.new_content": { msgtype: "m.text", body: "edited body" },
					"m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			},
		};

		const roomA = createMockRoom("!roomA:test", [original]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			// Failed edit: must NOT appear edited.
			expect(events[0].isEdited).toBe(false);
			// Original body still visible.
			expect(events[0].body).toBe("original body");
		});
	});

	it("in-flight (SENDING) edit echoes apply optimistically", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const original: import("../../../test/mockClient").MockEvent = {
			eventId: "$orig",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.message",
			content: { msgtype: "m.text", body: "original body" },
			ts: 1000,
			replacingEvent: {
				eventId: "~local.edit",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.message",
				content: {
					"m.new_content": { msgtype: "m.text", body: "edited body" },
					"m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
				},
				ts: 2000,
				status: EventStatus.SENDING,
			},
		};

		const roomA = createMockRoom("!roomA:test", [original]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			// Optimistic: edited body visible while the SDK round-trips.
			expect(events[0].body).toBe("edited body");
			// And the (edited) indicator surfaces too.
			expect(events[0].isEdited).toBe(true);
		});
	});

	it("cancelled edit echoes restore the original message", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const original: import("../../../test/mockClient").MockEvent = {
			eventId: "$orig",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.message",
			content: { msgtype: "m.text", body: "original body" },
			ts: 1000,
			replacingEvent: {
				eventId: "~local.edit",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.message",
				content: {
					"m.new_content": { msgtype: "m.text", body: "edited body" },
					"m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
				},
				ts: 2000,
				status: EventStatus.CANCELLED,
			},
		};

		const roomA = createMockRoom("!roomA:test", [original]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			// Cancelled edit: treated the same as NOT_SENT — original body.
			expect(events[0].body).toBe("original body");
			expect(events[0].isEdited).toBe(false);
		});
	});

	// ─── Pending-redaction tracking (issue #58) ───────────────────────

	it("pending redaction echo records SENDING status keyed by target", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@me:test",
			"delete me",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, pendingRedactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events.length).toBe(1);
			expect(pendingRedactions.$target).toBeUndefined();

			const redactionEcho = createMatrixEvent({
				eventId: "~local.red",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.redaction",
				content: {},
				ts: 2000,
				status: EventStatus.SENDING,
				redacts: "$target",
			});
			appendLive(client, roomA, redactionEcho);

			const entry = pendingRedactions.$target;
			expect(entry).toBeDefined();
			expect(entry?.status).toBe(EventStatus.SENDING);
			expect(entry?.redactionEvent.getId()).toBe("~local.red");
			// Target still in the store; the overlay is purely visual.
			expect(events.length).toBe(1);
		});
	});

	it("redaction echo transitioning to NOT_SENT updates pending status", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@me:test",
			"delete me",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingRedactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const redactionEcho = createMatrixEvent({
				eventId: "~local.red",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.redaction",
				content: {},
				ts: 2000,
				status: EventStatus.SENDING,
				redacts: "$target",
			});
			appendLive(client, roomA, redactionEcho);
			expect(pendingRedactions.$target?.status).toBe(EventStatus.SENDING);

			redactionEcho.__setStatus(EventStatus.NOT_SENT);
			client.__emit(
				"Room.localEchoUpdated",
				redactionEcho,
				roomA,
				undefined,
				EventStatus.SENDING,
			);
			expect(pendingRedactions.$target?.status).toBe(EventStatus.NOT_SENT);
		});
	});

	it("cancelled redaction echo clears the pending overlay (target stays)", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@me:test",
			"delete me",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, pendingRedactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const redactionEcho = createMatrixEvent({
				eventId: "~local.red",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.redaction",
				content: {},
				ts: 2000,
				status: EventStatus.SENDING,
				redacts: "$target",
			});
			appendLive(client, roomA, redactionEcho);
			expect(pendingRedactions.$target).toBeDefined();

			// SDK fires removed-Timeline before LocalEchoUpdated(CANCELLED).
			client.__emit("Room.timeline", redactionEcho, roomA, false, true, {
				liveEvent: true,
			});
			expect(pendingRedactions.$target).toBeUndefined();
			// Target stays — discard restores normal appearance.
			expect(events.length).toBe(1);
			expect(events[0].eventId).toBe("$target");
		});
	});

	it("confirmed redaction (LocalEchoUpdated status=null) clears pending overlay and removes target", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target: import("../../../test/mockClient").MockEvent = {
			eventId: "$target",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.message",
			content: { msgtype: "m.text", body: "delete me" },
			ts: 1000,
		};
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, pendingRedactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();
			expect(events.length).toBe(1);

			const redactionEcho = createMatrixEvent({
				eventId: "~local.red",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.redaction",
				content: {},
				ts: 2000,
				status: EventStatus.SENDING,
				redacts: "$target",
			});
			// Simulate SDK markLocallyRedacted on the target.
			target.localRedaction = {
				eventId: "~local.red",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.redaction",
				content: {},
				ts: 2000,
				redacts: "$target",
			};
			appendLive(client, roomA, redactionEcho);
			expect(pendingRedactions.$target).toBeDefined();

			// Server confirms — SDK runs makeRedacted: clears
			// _localRedactionEvent, marks the target truly redacted.
			target.localRedaction = undefined;
			target.redacted = true;
			redactionEcho.__setStatus(null);
			client.__emit(
				"Room.localEchoUpdated",
				redactionEcho,
				roomA,
				undefined,
				EventStatus.SENDING,
			);
			expect(pendingRedactions.$target).toBeUndefined();
			// Target removed from the store (the SDK reconciles remote
			// echoes without re-firing Room.timeline, so this code path
			// has to drive the removal).
			expect(events.length).toBe(0);
		});
	});

	it("cancelled redaction restores the target's body", async () => {
		// After cancel, SDK's unmarkLocallyRedacted clears the local
		// redaction state so getContent() returns the original content
		// again. The target's TimelineEvent in the store must be
		// recomputed so the body comes back; otherwise discarding a
		// failed delete leaves the message blank.
		const redactionEcho: import("../../../test/mockClient").MockEvent = {
			eventId: "~local.red",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.redaction",
			content: {},
			ts: 2000,
			redacts: "$target",
		};
		const target: import("../../../test/mockClient").MockEvent = {
			eventId: "$target",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.message",
			content: { msgtype: "m.text", body: "delete me" },
			ts: 1000,
			localRedaction: redactionEcho,
		};
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events, pendingRedactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			// Initially: target visible, body cleared by local redaction.
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("");

			// SDK unmarks (simulated by clearing localRedaction on the
			// mock target) then fires `Room.timeline(removed=true)` for
			// the redaction event.
			target.localRedaction = undefined;
			const redactionWrapper = createMatrixEvent(redactionEcho);
			client.__emit("Room.timeline", redactionWrapper, roomA, false, true, {
				liveEvent: true,
			});

			expect(pendingRedactions.$target).toBeUndefined();
			// Target's body restored from getContent().
			expect(events.length).toBe(1);
			expect(events[0].body).toBe("delete me");
		});
	});

	it("pending redactions are cleared on room switch", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@me:test",
			"delete me",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const roomB = createMockRoom("!roomB:test", []);
		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		const [roomId, setRoomId] = createSignal("!roomA:test");

		await withRoot(async () => {
			const { pendingRedactions } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);
			await flushPromises();

			const redactionEcho = createMatrixEvent({
				eventId: "~local.red",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.redaction",
				content: {},
				ts: 2000,
				status: EventStatus.NOT_SENT,
				redacts: "$target",
			});
			appendLive(client, roomA, redactionEcho);
			expect(pendingRedactions.$target).toBeDefined();

			setRoomId("!roomB:test");
			await flushPromises();

			expect(pendingRedactions.$target).toBeUndefined();
		});
	});

	it("locally-redacted-pending target stays in the store but with cleared content", async () => {
		// Mirrors the real SDK: when the user sends a delete, the target
		// event is immediately marked locally-redacted — `getContent()`
		// and `getOriginalContent()` both return `{}`, and `isRedacted()`
		// already returns true (markLocallyRedacted sets
		// `unsigned.redacted_because`). The optimistic-redaction overlay
		// rendered by TimelineItem carries the "Deleting…" semantics;
		// here we just need the target to survive isDisplayable so the
		// overlay has somewhere to attach.
		const redactionEcho: import("../../../test/mockClient").MockEvent = {
			eventId: "~local.red",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.redaction",
			content: {},
			ts: 2000,
			redacts: "$target",
		};
		const target: import("../../../test/mockClient").MockEvent = {
			eventId: "$target",
			roomId: "!roomA:test",
			sender: "@me:test",
			type: "m.room.message",
			content: { msgtype: "m.text", body: "delete me" },
			ts: 1000,
			localRedaction: redactionEcho,
		};
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			// Target survives isDisplayable so the overlay has an anchor.
			expect(events.length).toBe(1);
			expect(events[0].eventId).toBe("$target");
			// Body is empty — SDK cleared it via markLocallyRedacted.
			// The "Deleting…" overlay (rendered by TimelineItem from the
			// separate pendingRedactions store) is what the user sees.
			expect(events[0].body).toBe("");
		});
	});

	// ─── Pending reactions / edits (issue #106) ───────────────────────

	it("failed reaction echo records pendingReactions by target and key", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@alice:test",
			"hi",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingReactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(pendingReactions.$target).toBeUndefined();

			const failedReaction = createMatrixEvent({
				eventId: "~local.r",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.reaction",
				content: {
					"m.relates_to": {
						rel_type: "m.annotation",
						event_id: "$target",
						key: "🚀",
					},
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			});
			appendLive(client, roomA, failedReaction);

			expect(pendingReactions.$target?.["🚀"]?.length).toBe(1);
			expect(pendingReactions.$target?.["🚀"]?.[0]?.getId()).toBe("~local.r");
		});
	});

	it("reaction retry transition (SENDING) removes the failed entry", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@alice:test",
			"hi",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingReactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createMatrixEvent({
				eventId: "~local.r",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.reaction",
				content: {
					"m.relates_to": {
						rel_type: "m.annotation",
						event_id: "$target",
						key: "🚀",
					},
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			});
			appendLive(client, roomA, echo);
			expect(pendingReactions.$target?.["🚀"]?.length).toBe(1);

			echo.__setStatus(EventStatus.SENDING);
			client.__emit(
				"Room.localEchoUpdated",
				echo,
				roomA,
				undefined,
				EventStatus.NOT_SENT,
			);
			// Entry removed and target key pruned along with the outer key.
			expect(pendingReactions.$target).toBeUndefined();
		});
	});

	it("duplicate NOT_SENT for same reaction event does not stack", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@alice:test",
			"hi",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingReactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createMatrixEvent({
				eventId: "~local.r",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.reaction",
				content: {
					"m.relates_to": {
						rel_type: "m.annotation",
						event_id: "$target",
						key: "🚀",
					},
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			});
			appendLive(client, roomA, echo);
			client.__emit(
				"Room.localEchoUpdated",
				echo,
				roomA,
				undefined,
				EventStatus.NOT_SENT,
			);
			expect(pendingReactions.$target?.["🚀"]?.length).toBe(1);
		});
	});

	it("cancelled reaction echo removes the pending entry", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@alice:test",
			"hi",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingReactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createMatrixEvent({
				eventId: "~local.r",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.reaction",
				content: {
					"m.relates_to": {
						rel_type: "m.annotation",
						event_id: "$target",
						key: "🚀",
					},
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			});
			appendLive(client, roomA, echo);
			expect(pendingReactions.$target?.["🚀"]?.length).toBe(1);

			echo.__setStatus(EventStatus.CANCELLED);
			client.__emit(
				"Room.localEchoUpdated",
				echo,
				roomA,
				undefined,
				EventStatus.NOT_SENT,
			);
			expect(pendingReactions.$target).toBeUndefined();
		});
	});

	it("pending reactions survive when target is outside the rendered window", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		// Create a room with two messages; the failed reaction targets
		// the older one. The store is keyed by target event ID, so it
		// should not depend on the target being in `events` either way.
		const older = textMessage(
			"!roomA:test",
			"$older",
			"@alice:test",
			"old",
			500,
		);
		const newer = textMessage(
			"!roomA:test",
			"$newer",
			"@alice:test",
			"new",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [older, newer]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingReactions } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createMatrixEvent({
				eventId: "~local.r",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.reaction",
				content: {
					"m.relates_to": {
						rel_type: "m.annotation",
						event_id: "$older",
						key: "🚀",
					},
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			});
			appendLive(client, roomA, echo);

			// Pending entry recorded against $older even though the
			// reaction-aggregation recompute is a no-op when the target
			// is missing from the visible window.
			expect(pendingReactions.$older?.["🚀"]?.length).toBe(1);
		});
	});

	it("failed edit echo records pendingEdits keyed by target", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@me:test",
			"original",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingEdits } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const editEcho = createMatrixEvent({
				eventId: "~local.e",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.message",
				content: {
					"m.relates_to": {
						rel_type: "m.replace",
						event_id: "$target",
					},
					"m.new_content": {
						msgtype: "m.text",
						body: "edited text",
					},
					msgtype: "m.text",
					body: "* edited text",
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			});
			appendLive(client, roomA, editEcho);

			expect(pendingEdits.$target?.length).toBe(1);
			expect(pendingEdits.$target?.[0]?.getId()).toBe("~local.e");
		});
	});

	it("edit retry transition removes the failed entry", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@me:test",
			"original",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { pendingEdits } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const echo = createMatrixEvent({
				eventId: "~local.e",
				roomId: "!roomA:test",
				sender: "@me:test",
				type: "m.room.message",
				content: {
					"m.relates_to": {
						rel_type: "m.replace",
						event_id: "$target",
					},
					"m.new_content": {
						msgtype: "m.text",
						body: "edited",
					},
					msgtype: "m.text",
					body: "* edited",
				},
				ts: 2000,
				status: EventStatus.NOT_SENT,
			});
			appendLive(client, roomA, echo);
			expect(pendingEdits.$target?.length).toBe(1);

			echo.__setStatus(EventStatus.SENDING);
			client.__emit(
				"Room.localEchoUpdated",
				echo,
				roomA,
				undefined,
				EventStatus.NOT_SENT,
			);
			expect(pendingEdits.$target).toBeUndefined();
		});
	});

	it("pendingReactions and pendingEdits are cleared on room switch", async () => {
		const { EventStatus } = await import("matrix-js-sdk");
		const target = textMessage(
			"!roomA:test",
			"$target",
			"@me:test",
			"hi",
			1000,
		);
		const roomA = createMockRoom("!roomA:test", [target]);
		const roomB = createMockRoom("!roomB:test", []);
		const client = createMockClient(
			new Map([
				["!roomA:test", roomA],
				["!roomB:test", roomB],
			]),
		);

		const [roomId, setRoomId] = createSignal("!roomA:test");

		await withRoot(async () => {
			const { pendingReactions, pendingEdits } = useTimeline(
				client as unknown as MatrixClient,
				roomId,
			);
			await flushPromises();

			appendLive(
				client,
				roomA,
				createMatrixEvent({
					eventId: "~local.r",
					roomId: "!roomA:test",
					sender: "@me:test",
					type: "m.reaction",
					content: {
						"m.relates_to": {
							rel_type: "m.annotation",
							event_id: "$target",
							key: "🚀",
						},
					},
					ts: 2000,
					status: EventStatus.NOT_SENT,
				}),
			);
			appendLive(
				client,
				roomA,
				createMatrixEvent({
					eventId: "~local.e",
					roomId: "!roomA:test",
					sender: "@me:test",
					type: "m.room.message",
					content: {
						"m.relates_to": {
							rel_type: "m.replace",
							event_id: "$target",
						},
						"m.new_content": { msgtype: "m.text", body: "edited" },
						msgtype: "m.text",
						body: "* edited",
					},
					ts: 2500,
					status: EventStatus.NOT_SENT,
				}),
			);
			expect(pendingReactions.$target).toBeDefined();
			expect(pendingEdits.$target).toBeDefined();

			setRoomId("!roomB:test");
			await flushPromises();

			expect(pendingReactions.$target).toBeUndefined();
			expect(pendingEdits.$target).toBeUndefined();
		});
	});
});
