import {
	EventStatus,
	type MatrixClient,
	MatrixEvent,
	Poll,
	type Room,
} from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
	createMatrixEvent,
	createMockClient,
	createMockRoom,
	type MockEvent,
	pollEndEvent,
	pollResponseEvent,
	pollStartEvent,
	textMessage,
} from "../../../test/mockClient";
import { useTimeline } from "./useTimeline";

const ROOM_ID = "!room:test";
const POLL_ID = "$poll";

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

/** Wait for pending promise handlers (TimelineWindow.load() and its .then()) */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function appendLive(
	client: ReturnType<typeof createMockClient>,
	room: ReturnType<typeof createMockRoom>,
	event: ReturnType<typeof createMatrixEvent>,
) {
	const timeline = room.getLiveTimeline();
	timeline.__append(
		event as unknown as Parameters<typeof timeline.__append>[0],
	);
	client.__emit("Room.timeline", event, room, false, false, {
		liveEvent: true,
	});
}

/** Real SDK MatrixEvent mirroring a mock poll-start event, for the SDK Poll
 *  model (which requires a real event for its relations bookkeeping). */
function realEventFrom(mock: MockEvent): MatrixEvent {
	return new MatrixEvent({
		type: mock.type,
		content: mock.content,
		event_id: mock.eventId,
		room_id: mock.roomId,
		sender: mock.sender,
		origin_server_ts: mock.ts,
	});
}

function makeRealResponse(
	eventId: string,
	sender: string,
	answers: string[],
	ts: number,
): MatrixEvent {
	return realEventFrom(
		pollResponseEvent(ROOM_ID, eventId, sender, POLL_ID, answers, ts),
	);
}

/** Room + client + SDK Poll wired the way sync would leave them. */
function setupPollRoom() {
	const startMock = pollStartEvent(
		ROOM_ID,
		POLL_ID,
		"@alice:test",
		"Best pizza?",
		[
			{ id: "a", text: "Margherita" },
			{ id: "b", text: "Pepperoni" },
		],
		{ ts: 2000 },
	);
	const room = createMockRoom(ROOM_ID, [
		textMessage(ROOM_ID, "$1", "@alice:test", "hello", 1000),
		startMock,
	]);
	const client = createMockClient(new Map([[ROOM_ID, room]]));
	const poll = new Poll(
		realEventFrom(startMock),
		client as unknown as MatrixClient,
		room as unknown as Room,
	);
	room.polls.set(POLL_ID, poll);
	return { room, client, poll, startMock };
}

describe("useTimeline polls", () => {
	it("projects a poll start into a displayable row with a snapshot", async () => {
		const { client } = setupPollRoom();
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();

			expect(events.length).toBe(2);
			const pollRow = events[1];
			expect(pollRow.eventId).toBe(POLL_ID);
			expect(pollRow.poll?.question).toBe("Best pizza?");
			expect(pollRow.poll?.answers.map((a) => a.id)).toEqual(["a", "b"]);
			expect(pollRow.poll?.counts).toEqual({ a: 0, b: 0 });
			expect(pollRow.poll?.isEnded).toBe(false);
			// Non-poll rows carry no snapshot.
			expect(events[0].poll).toBeNull();
		});
	});

	it("accepts the stable m.poll.start type too", async () => {
		const room = createMockRoom(ROOM_ID, [
			{
				eventId: POLL_ID,
				roomId: ROOM_ID,
				sender: "@alice:test",
				type: "m.poll.start",
				content: {
					"m.poll.start": {
						question: { "m.text": "Stable?" },
						kind: "m.poll.disclosed",
						max_selections: 1,
						answers: [
							{ id: "y", "m.text": "Yes" },
							{ id: "n", "m.text": "No" },
						],
					},
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
			expect(events.length).toBe(1);
			expect(events[0].poll?.question).toBe("Stable?");
		});
	});

	it("filters malformed poll starts out of the timeline", async () => {
		const room = createMockRoom(ROOM_ID, [
			textMessage(ROOM_ID, "$1", "@alice:test", "hello", 1000),
			{
				eventId: "$bad",
				roomId: ROOM_ID,
				sender: "@alice:test",
				type: "org.matrix.msc3381.poll.start",
				content: { "org.matrix.msc3381.poll.start": { answers: [] } },
				ts: 2000,
			},
		]);
		const client = createMockClient(new Map([[ROOM_ID, room]]));
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$1"]);
		});
	});

	it("keeps poll responses and ends out of the timeline", async () => {
		const { client, room } = setupPollRoom();
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events.length).toBe(2);

			appendLive(
				client,
				room,
				createMatrixEvent(
					pollResponseEvent(ROOM_ID, "$v1", "@bob:test", POLL_ID, ["a"], 3000),
				),
			);
			appendLive(
				client,
				room,
				createMatrixEvent(
					pollEndEvent(ROOM_ID, "$end", "@alice:test", POLL_ID, 4000),
				),
			);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$1", POLL_ID]);
		});
	});

	it("re-projects only the poll row when a live vote arrives", async () => {
		const { client, poll } = setupPollRoom();
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events[1].poll?.counts).toEqual({ a: 0, b: 0 });

			// The SDK routes vote relations to the Poll model (not the
			// timeline); the watcher must translate that into a row update.
			poll.onNewRelation(makeRealResponse("$v1", "@bob:test", ["a"], 3000));
			await flushPromises();
			expect(events[1].poll?.counts).toEqual({ a: 1, b: 0 });
			expect(events[1].poll?.totalVotes).toBe(1);

			poll.onNewRelation(
				makeRealResponse("$v2", "@test:example.com", ["b"], 3100),
			);
			await flushPromises();
			expect(events[1].poll?.counts).toEqual({ a: 1, b: 1 });
			expect(events[1].poll?.myAnswers).toEqual(["b"]);
		});
	});

	it("marks the row ended when the creator closes the poll", async () => {
		const { client, poll } = setupPollRoom();
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events[1].poll?.isEnded).toBe(false);

			poll.onNewRelation(
				realEventFrom(
					pollEndEvent(ROOM_ID, "$end", "@alice:test", POLL_ID, 5000),
				),
			);
			await flushPromises();
			expect(events[1].poll?.isEnded).toBe(true);
		});
	});

	it("removes a redacted poll start from the timeline", async () => {
		const { client, room, startMock } = setupPollRoom();
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			expect(events.length).toBe(2);

			// Server-confirmed redaction: content cleared, then the redaction
			// event arrives on the timeline.
			startMock.redacted = true;
			appendLive(
				client,
				room,
				createMatrixEvent({
					eventId: "$redact",
					roomId: ROOM_ID,
					sender: "@alice:test",
					type: "m.room.redaction",
					content: {},
					ts: 6000,
					redacts: POLL_ID,
				}),
			);
			await flushPromises();
			expect(events.map((e) => e.eventId)).toEqual(["$1"]);
		});
	});

	it("renders a provisional snapshot for a pending local-echo poll", async () => {
		const room = createMockRoom(ROOM_ID, [
			textMessage(ROOM_ID, "$1", "@alice:test", "hello", 1000),
		]);
		const client = createMockClient(new Map([[ROOM_ID, room]]));
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();

			// A just-sent poll: local echo on the timeline, no SDK Poll model
			// yet (local echoes never reach processPollEvents).
			appendLive(
				client,
				room,
				createMatrixEvent({
					...pollStartEvent(
						ROOM_ID,
						"~local:1",
						"@test:example.com",
						"Ship it?",
						[
							{ id: "y", text: "Yes" },
							{ id: "n", text: "No" },
						],
						{ ts: 2000 },
					),
					status: EventStatus.SENDING,
				}),
			);
			await flushPromises();

			const pollRow = events.find((e) => e.eventId === "~local:1");
			expect(pollRow?.poll?.question).toBe("Ship it?");
			expect(pollRow?.poll?.counts).toEqual({ y: 0, n: 0 });
			expect(pollRow?.poll?.loadingResults).toBe(false);
			expect(pollRow?.status).toBe(EventStatus.SENDING);
		});
	});

	it("uses a poll preview snippet for replies to polls", async () => {
		const startMock = pollStartEvent(
			ROOM_ID,
			POLL_ID,
			"@alice:test",
			"Best pizza?",
			[
				{ id: "a", text: "Margherita" },
				{ id: "b", text: "Pepperoni" },
			],
			{ ts: 1000 },
		);
		const reply: MockEvent = {
			eventId: "$reply",
			roomId: ROOM_ID,
			sender: "@bob:test",
			type: "m.room.message",
			content: {
				msgtype: "m.text",
				body: "good question",
				"m.relates_to": { "m.in_reply_to": { event_id: POLL_ID } },
			},
			ts: 2000,
		};
		const room = createMockRoom(ROOM_ID, [startMock, reply]);
		const client = createMockClient(new Map([[ROOM_ID, room]]));
		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => ROOM_ID,
			);
			await flushPromises();
			const replyRow = events.find((e) => e.eventId === "$reply");
			expect(replyRow?.replyToBody).toBe("Poll: Best pizza?");
		});
	});
});
