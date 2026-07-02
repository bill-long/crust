import {
	EventStatus,
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
	type MockEvent,
	pollEndEvent,
	pollResponseEvent,
	pollStartContent,
	pollStartEvent,
} from "../../../test/mockClient";
import { createPollWatcher, type PollWatcher } from "./pollWatcher";

const ROOM_ID = "!room:example.com";
const POLL_ID = "$poll:example.com";
const ME = "@test:example.com";

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Real SDK MatrixEvent from a mock-factory event spec - the SDK Poll model
 *  and the watcher's event listeners need real emitter instances. */
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

function makeStartEvent(eventId = POLL_ID): MatrixEvent {
	return realEventFrom(
		pollStartEvent(
			ROOM_ID,
			eventId,
			"@alice:example.com",
			"Best pizza?",
			[
				{ id: "a", text: "Margherita" },
				{ id: "b", text: "Pepperoni" },
			],
			{ ts: 1000 },
		),
	);
}

function makeResponse(args: {
	eventId: string;
	sender: string;
	answers?: string[];
	ts: number;
	pollId?: string;
}): MatrixEvent {
	return realEventFrom(
		pollResponseEvent(
			ROOM_ID,
			args.eventId,
			args.sender,
			args.pollId ?? POLL_ID,
			args.answers ?? [],
			args.ts,
		),
	);
}

function makeEnd(sender: string, ts: number, eventId = "$end"): MatrixEvent {
	return realEventFrom(pollEndEvent(ROOM_ID, eventId, sender, POLL_ID, ts));
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

	it("re-derives the snapshot when the poll start is edited (m.replace)", async () => {
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
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.question,
		).toBe("Best pizza?");
		updates.length = 0;

		// An MSC3381 poll edit: a new poll.start with rel_type m.replace.
		// The SDK applies it to the root event via makeReplaced, which emits
		// MatrixEventEvent.Replaced and invalidates the extensible parse.
		const edit = new MatrixEvent({
			type: "org.matrix.msc3381.poll.start",
			event_id: "$edit",
			room_id: ROOM_ID,
			sender: "@alice:example.com",
			origin_server_ts: 3000,
			content: {
				"m.relates_to": { rel_type: "m.replace", event_id: POLL_ID },
				"m.new_content": pollStartContent("Best pasta?", [
					{ id: "x", text: "Carbonara" },
					{ id: "y", text: "Pesto" },
				]),
			},
		});
		rootEvent.makeReplaced(edit);

		expect(updates).toContain(POLL_ID);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.question).toBe("Best pasta?");
		expect(snapshot?.answers.map((a) => a.id)).toEqual(["x", "y"]);
		// Bob's old ballot for answer "a" is spoiled against the new answer
		// ids, matching what a fresh projection would compute.
		expect(snapshot?.totalVotes).toBe(0);
		expect(snapshot?.counts).toEqual({ x: 0, y: 0 });
	});

	it("keeps the watch alive while a local redaction is merely pending", async () => {
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
		updates.length = 0;

		// markLocallyRedacted emits BeforeRedaction with the SENDING local
		// redaction echo - the redaction may still fail or be cancelled, so
		// the watch (and its tallies) must survive.
		const pendingRedaction = new MatrixEvent({
			type: "m.room.redaction",
			event_id: "~local:redact",
			room_id: ROOM_ID,
			sender: "@alice:example.com",
			origin_server_ts: 7000,
			content: {},
		});
		pendingRedaction.setStatus(EventStatus.SENDING);
		rootEvent.emit(
			MatrixEventEvent.BeforeRedaction,
			rootEvent,
			pendingRedaction,
		);

		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.totalVotes).toBe(1);
		// Live updates keep flowing after the failed/cancelled redaction.
		poll.onNewRelation(
			makeResponse({ eventId: "$v2", sender: ME, answers: ["b"], ts: 8000 }),
		);
		expect(updates).toContain(POLL_ID);
	});

	it("applies a vote optimistically and clears the overlay on the remote echo", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		updates.length = 0;

		const votePromise = watcher.votePoll(POLL_ID, ["a"]);
		// Synchronous optimistic update, before the send resolves.
		let snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.counts).toEqual({ a: 1, b: 0 });
		expect(snapshot?.myAnswers).toEqual(["a"]);
		expect(snapshot?.hasPendingVote).toBe(true);
		expect(updates).toContain(POLL_ID);
		expect(client.sendEvent).toHaveBeenCalledExactlyOnceWith(
			ROOM_ID,
			"org.matrix.msc3381.poll.response",
			expect.objectContaining({
				"m.relates_to": { rel_type: "m.reference", event_id: POLL_ID },
				"org.matrix.msc3381.poll.response": { answers: ["a"] },
			}),
		);
		await votePromise;

		// Remote echo round-trips with the id the send resolved with; the
		// overlay retires and the confirmed tally takes over seamlessly.
		poll.onNewRelation(
			makeResponse({ eventId: "$sent", sender: ME, answers: ["a"], ts: 5000 }),
		);
		snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.hasPendingVote).toBe(false);
		expect(snapshot?.counts).toEqual({ a: 1, b: 0 });
		expect(snapshot?.myAnswers).toEqual(["a"]);
	});

	it("lets a rapid second vote supersede the first pending one", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();

		const first = watcher.votePoll(POLL_ID, ["a"]);
		const second = watcher.votePoll(POLL_ID, ["b"]);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.myAnswers).toEqual(["b"]);
		expect(snapshot?.counts).toEqual({ a: 0, b: 1 });
		await Promise.all([first, second]);
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.myAnswers,
		).toEqual(["b"]);
	});

	it("reverts a failed vote and offers its ballot for retry", async () => {
		setupPoll([
			makeResponse({
				eventId: "$v0",
				sender: ME,
				answers: ["b"],
				ts: 2000,
			}),
		]);
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		client.sendEvent.mockRejectedValueOnce(new Error("network"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await watcher.votePoll(POLL_ID, ["a"]);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		// Reverted to the confirmed ballot, with the failed one retryable.
		expect(snapshot?.hasPendingVote).toBe(false);
		expect(snapshot?.myAnswers).toEqual(["b"]);
		expect(snapshot?.counts).toEqual({ a: 0, b: 1 });
		expect(snapshot?.failedAnswers).toEqual(["a"]);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();

		// A successful retry clears the failure surface.
		await watcher.votePoll(POLL_ID, ["a"]);
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.failedAnswers,
		).toBeNull();
	});

	it("sends a spoiled ballot for an empty retraction vote", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();

		await watcher.votePoll(POLL_ID, []);
		expect(client.sendEvent).toHaveBeenCalledOnce();
		const [roomId, type, content] = client.sendEvent.mock.calls[0] as [
			string,
			string,
			Record<string, { answers?: unknown }>,
		];
		expect(roomId).toBe(ROOM_ID);
		expect(type).toBe("org.matrix.msc3381.poll.response");
		// A spoiled ballot omits the answers array entirely.
		expect(content["org.matrix.msc3381.poll.response"].answers).toBeUndefined();
	});

	it("ignores votes on polls without a watched SDK model", async () => {
		await watcher.votePoll("$unknown", ["a"]);
		expect(client.sendEvent).not.toHaveBeenCalled();
	});

	it("marks canEnd only for the poll creator while the poll is open", async () => {
		// Poll created by the local test user.
		client.relations.mockResolvedValue({ events: [], nextBatch: null });
		rootEvent = realEventFrom(
			pollStartEvent(ROOM_ID, POLL_ID, ME, "Mine?", [
				{ id: "a", text: "A" },
				{ id: "b", text: "B" },
			]),
		);
		poll = new Poll(
			rootEvent,
			client as unknown as MatrixClient,
			room as unknown as Room,
		);
		room.polls.set(poll.pollId, poll);
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.canEnd,
		).toBe(true);

		poll.onNewRelation(makeEnd(ME, 5000));
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.canEnd,
		).toBe(false);
	});

	it("does not offer canEnd to non-creators", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.canEnd,
		).toBe(false);
	});

	it("holds the Ending state until the confirmed end event arrives", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		updates.length = 0;

		const endPromise = watcher.endPoll(POLL_ID);
		let snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.endPending).toBe(true);
		// Undisclosed reveal is keyed off isEnded, which stays false until
		// the confirmed end round-trips.
		expect(snapshot?.isEnded).toBe(false);
		await endPromise;
		expect(client.sendEvent).toHaveBeenCalledExactlyOnceWith(
			ROOM_ID,
			"org.matrix.msc3381.poll.end",
			expect.objectContaining({
				"m.relates_to": { rel_type: "m.reference", event_id: POLL_ID },
			}),
		);
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.endPending,
		).toBe(true);

		poll.onNewRelation(makeEnd("@alice:example.com", 6000));
		snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.isEnded).toBe(true);
		expect(snapshot?.endPending).toBe(false);
	});

	it("refuses votes once the poll has ended or is being ended", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		poll.onNewRelation(makeEnd("@alice:example.com", 5000));
		client.sendEvent.mockClear();

		// A post-end vote would install an optimistic overlay the SDK's
		// end-filtered relations could never retire.
		await watcher.votePoll(POLL_ID, ["a"]);
		expect(client.sendEvent).not.toHaveBeenCalled();
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.hasPendingVote).toBe(false);
		expect(snapshot?.totalVotes).toBe(0);
		expect(snapshot?.canVote).toBe(false);
	});

	it("drops stale failure surfaces when the poll ends", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		// Both a vote send and an end send fail, leaving Retry rows.
		client.sendEvent
			.mockRejectedValueOnce(new Error("network"))
			.mockRejectedValueOnce(new Error("network"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await watcher.votePoll(POLL_ID, ["a"]);
		await watcher.endPoll(POLL_ID);
		consoleError.mockRestore();
		let snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.failedAnswers).toEqual(["a"]);
		expect(snapshot?.endFailed).toBe(true);

		// The end arrives (e.g. a moderator closed it): every stale surface
		// clears - the Retry rows can no longer accomplish anything.
		poll.onNewRelation(makeEnd("@alice:example.com", 5000));
		snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.isEnded).toBe(true);
		expect(snapshot?.failedAnswers).toBeNull();
		expect(snapshot?.endFailed).toBe(false);
	});

	it("drops a stuck optimistic overlay when the poll ends", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		// The vote sends fine but its echo never lands in the relations
		// (the SDK filters post-end responses out), so without the on-end
		// cleanup the overlay would corrupt the final tally forever.
		await watcher.votePoll(POLL_ID, ["a"]);
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.hasPendingVote,
		).toBe(true);

		poll.onNewRelation(makeEnd("@alice:example.com", 5000));
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.isEnded).toBe(true);
		expect(snapshot?.hasPendingVote).toBe(false);
		expect(snapshot?.totalVotes).toBe(0);
		expect(snapshot?.myAnswers).toEqual([]);
	});

	it("clears a vote failure when a newer confirmed own ballot arrives", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		client.sendEvent.mockRejectedValueOnce(new Error("network"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await watcher.votePoll(POLL_ID, ["a"]);
		consoleError.mockRestore();
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.failedAnswers,
		).toEqual(["a"]);

		// The user votes successfully from another device; retrying the
		// stale ["a"] ballot would stomp it, so the failure clears.
		poll.onNewRelation(
			makeResponse({ eventId: "$phone", sender: ME, answers: ["b"], ts: 6000 }),
		);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.failedAnswers).toBeNull();
		expect(snapshot?.myAnswers).toEqual(["b"]);
	});

	it("surfaces a failed end without revealing results", async () => {
		setupPoll();
		watcher.getSnapshot(rootEvent, room as unknown as Room);
		await flushPromises();
		client.sendEvent.mockRejectedValueOnce(new Error("network"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await watcher.endPoll(POLL_ID);
		const snapshot = watcher.getSnapshot(rootEvent, room as unknown as Room);
		expect(snapshot?.endPending).toBe(false);
		expect(snapshot?.endFailed).toBe(true);
		expect(snapshot?.isEnded).toBe(false);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();

		// Retry succeeds and clears the failure surface.
		await watcher.endPoll(POLL_ID);
		expect(
			watcher.getSnapshot(rootEvent, room as unknown as Room)?.endFailed,
		).toBe(false);
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
