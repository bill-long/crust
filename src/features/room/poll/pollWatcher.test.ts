import {
	type MatrixClient,
	MatrixEvent,
	MatrixEventEvent,
	Poll,
	PollEvent,
	type Room,
} from "matrix-js-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockClient,
	createMockRoom,
	pollStartContent,
} from "../../../test/mockClient";
import { createPollWatcher, type PollWatcher } from "./pollWatcher";

const ROOM_ID = "!room:example.com";
const POLL_ID = "$poll:example.com";
const ME = "@test:example.com";

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeStartEvent(eventId = POLL_ID): MatrixEvent {
	return new MatrixEvent({
		type: "org.matrix.msc3381.poll.start",
		event_id: eventId,
		room_id: ROOM_ID,
		sender: "@alice:example.com",
		origin_server_ts: 1000,
		content: pollStartContent("Best pizza?", [
			{ id: "a", text: "Margherita" },
			{ id: "b", text: "Pepperoni" },
		]),
	});
}

function makeResponse(args: {
	eventId: string;
	sender: string;
	answers?: string[];
	ts: number;
	pollId?: string;
}): MatrixEvent {
	return new MatrixEvent({
		type: "org.matrix.msc3381.poll.response",
		event_id: args.eventId,
		room_id: ROOM_ID,
		sender: args.sender,
		origin_server_ts: args.ts,
		content: {
			"m.relates_to": {
				rel_type: "m.reference",
				event_id: args.pollId ?? POLL_ID,
			},
			"org.matrix.msc3381.poll.response": {
				answers:
					args.answers && args.answers.length > 0 ? args.answers : undefined,
			},
		},
	});
}

function makeEnd(sender: string, ts: number, eventId = "$end"): MatrixEvent {
	return new MatrixEvent({
		type: "org.matrix.msc3381.poll.end",
		event_id: eventId,
		room_id: ROOM_ID,
		sender,
		origin_server_ts: ts,
		content: {
			"m.relates_to": { rel_type: "m.reference", event_id: POLL_ID },
			"org.matrix.msc3381.poll.end": {},
		},
	});
}

describe("createPollWatcher", () => {
	let room: ReturnType<typeof createMockRoom>;
	let client: ReturnType<typeof createMockClient>;
	let updates: string[];
	let watcher: PollWatcher;
	let rootEvent: MatrixEvent;
	let poll: Poll;

	function setupPoll(responses: MatrixEvent[] = []): void {
		client.relations.mockResolvedValue({ events: responses, nextBatch: null });
		rootEvent = makeStartEvent();
		poll = new Poll(
			rootEvent,
			client as unknown as MatrixClient,
			room as unknown as Room,
		);
		room.polls.set(poll.pollId, poll);
	}

	beforeEach(() => {
		room = createMockRoom(ROOM_ID);
		client = createMockClient(new Map([[ROOM_ID, room]]));
		updates = [];
		watcher = createPollWatcher(client as unknown as MatrixClient, (pollId) =>
			updates.push(pollId),
		);
		watcher.watchRoom(room as unknown as Room);
	});

	it("returns a provisional snapshot and eagerly fetches responses", async () => {
		setupPoll([
			makeResponse({
				eventId: "$v1",
				sender: "@bob:example.com",
				answers: ["a"],
				ts: 2000,
			}),
		]);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.question).toBe("Best pizza?");
		expect(snapshot?.totalVotes).toBe(0);
		expect(snapshot?.loadingResults).toBe(true);
		expect(client.relations).toHaveBeenCalledTimes(1);

		await flushPromises();
		expect(updates).toContain(POLL_ID);
		const updated = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(updated?.counts).toEqual({ a: 1, b: 0 });
		expect(updated?.totalVotes).toBe(1);
		expect(updated?.loadingResults).toBe(false);
	});

	it("does not refetch on subsequent snapshot reads", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(client.relations).toHaveBeenCalledTimes(1);
	});

	it("recomputes when a live vote arrives via the SDK poll model", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		updates.length = 0;

		poll.onNewRelation(
			makeResponse({ eventId: "$v1", sender: ME, answers: ["b"], ts: 3000 }),
		);
		expect(updates).toContain(POLL_ID);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.counts).toEqual({ a: 0, b: 1 });
		expect(snapshot?.myAnswers).toEqual(["b"]);
	});

	it("replaces a sender's earlier vote with their newer one", async () => {
		setupPoll([
			makeResponse({
				eventId: "$v1",
				sender: "@bob:example.com",
				answers: ["a"],
				ts: 2000,
			}),
		]);
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();

		poll.onNewRelation(
			makeResponse({
				eventId: "$v2",
				sender: "@bob:example.com",
				answers: ["b"],
				ts: 4000,
			}),
		);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.counts).toEqual({ a: 0, b: 1 });
		expect(snapshot?.totalVotes).toBe(1);
	});

	it("marks the poll ended for a creator end event and drops later votes", async () => {
		setupPoll([
			makeResponse({
				eventId: "$v1",
				sender: "@bob:example.com",
				answers: ["a"],
				ts: 2000,
			}),
		]);
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();

		poll.onNewRelation(makeEnd("@alice:example.com", 5000));
		let snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.isEnded).toBe(true);

		// Votes cast after the poll closed are ignored by the SDK model.
		poll.onNewRelation(
			makeResponse({
				eventId: "$v2",
				sender: "@carol:example.com",
				answers: ["b"],
				ts: 6000,
			}),
		);
		snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.counts).toEqual({ a: 1, b: 0 });
	});

	it("ignores an end event from a non-creator without redaction power", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();

		poll.onNewRelation(makeEnd("@mallory:example.com", 5000));
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.isEnded).toBe(false);
	});

	it("honors an end event from a user with redaction power", async () => {
		setupPoll();
		room.__setMaySendRedaction(true);
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();

		poll.onNewRelation(makeEnd("@moderator:example.com", 5000));
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.isEnded).toBe(true);
	});

	it("recomputes when a vote is redacted from the relations set", async () => {
		const vote = makeResponse({
			eventId: "$v1",
			sender: "@bob:example.com",
			answers: ["a"],
			ts: 2000,
		});
		setupPoll([vote]);
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.totalVotes,
		).toBe(1);
		updates.length = 0;

		// The SDK Relations set removes a member and emits Redaction when its
		// target is redacted; simulate via the event emitter it listens to.
		// The Relations handler is async, so flush before asserting.
		vote.emit(
			MatrixEventEvent.BeforeRedaction,
			vote,
			new MatrixEvent({
				type: "m.room.redaction",
				event_id: "$redact-vote",
				room_id: ROOM_ID,
				sender: "@bob:example.com",
				origin_server_ts: 7000,
				content: {},
			}),
		);
		await flushPromises();
		expect(updates).toContain(POLL_ID);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.totalVotes).toBe(0);
		expect(snapshot?.counts).toEqual({ a: 0, b: 0 });
	});

	it("surfaces undecryptable response counts", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		updates.length = 0;

		const bad = makeResponse({
			eventId: "$enc",
			sender: "@bob:example.com",
			answers: ["a"],
			ts: 2500,
		});
		vi.spyOn(bad, "isDecryptionFailure").mockReturnValue(true);
		poll.onNewRelation(bad);
		expect(updates).toContain(POLL_ID);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.undecryptableCount).toBe(1);
	});

	it("clears the loading state when the response fetch fails", async () => {
		setupPoll();
		client.relations.mockRejectedValue(new Error("network"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.loadingResults).toBe(false);
		expect(snapshot?.totalVotes).toBe(0);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("upgrades a provisional snapshot when PollEvent.New fires later", async () => {
		// Project the row before the SDK has created the Poll model (e.g. the
		// start event decrypted before processPollEvents ran).
		rootEvent = makeStartEvent();
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.loadingResults).toBe(false);
		expect(client.relations).not.toHaveBeenCalled();

		client.relations.mockResolvedValue({
			events: [
				makeResponse({
					eventId: "$v1",
					sender: "@bob:example.com",
					answers: ["a"],
					ts: 2000,
				}),
			],
			nextBatch: null,
		});
		poll = new Poll(
			rootEvent,
			client as unknown as MatrixClient,
			room as unknown as Room,
		);
		room.polls.set(poll.pollId, poll);
		room.__emit(PollEvent.New, poll);
		await flushPromises();
		expect(updates).toContain(POLL_ID);
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.totalVotes,
		).toBe(1);
	});

	it("drops watcher state when the poll start event is redacted", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		updates.length = 0;

		rootEvent.emit(
			MatrixEventEvent.BeforeRedaction,
			rootEvent,
			new MatrixEvent({
				type: "m.room.redaction",
				event_id: "$redact-poll",
				room_id: ROOM_ID,
				sender: "@alice:example.com",
				origin_server_ts: 8000,
				content: {},
			}),
		);
		// Poll state is gone: further SDK emissions must not update anything.
		poll.onNewRelation(
			makeResponse({ eventId: "$v9", sender: ME, answers: ["a"], ts: 9000 }),
		);
		expect(updates).toHaveLength(0);
	});

	it("clears subscriptions and cache on room switch and dispose", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		updates.length = 0;

		const otherRoom = createMockRoom("!other:example.com");
		watcher.watchRoom(otherRoom as unknown as Room);
		poll.onNewRelation(
			makeResponse({ eventId: "$v1", sender: ME, answers: ["a"], ts: 3000 }),
		);
		expect(updates).toHaveLength(0);

		// Re-watching the original room starts from a fresh provisional
		// snapshot (cache was cleared) and re-fetches.
		watcher.watchRoom(room as unknown as Room);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.totalVotes).toBe(0);

		watcher.dispose();
		updates.length = 0;
		poll.onNewRelation(
			makeResponse({ eventId: "$v2", sender: ME, answers: ["a"], ts: 4000 }),
		);
		expect(updates).toHaveLength(0);
	});

	it("returns a throwaway snapshot for a room other than the watched one", () => {
		setupPoll();
		const otherRoom = createMockRoom("!other:example.com");
		watcher.watchRoom(otherRoom as unknown as Room);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.question).toBe("Best pizza?");
		// No subscription was made for the unwatched room's poll.
		expect(client.relations).not.toHaveBeenCalled();
	});
});
