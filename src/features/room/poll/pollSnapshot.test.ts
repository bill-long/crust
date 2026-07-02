import { EventStatus, MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { pollStartContent } from "../../../test/mockClient";
import {
	buildPollSnapshot,
	computePollTally,
	type PollStartInfo,
	parsePollStart,
} from "./pollSnapshot";

const ROOM_ID = "!room:example.com";
const POLL_ID = "$poll:example.com";

function startEvent(
	options?: Parameters<typeof pollStartContent>[2] & {
		content?: Record<string, unknown>;
	},
): MatrixEvent {
	return new MatrixEvent({
		type: "org.matrix.msc3381.poll.start",
		event_id: POLL_ID,
		room_id: ROOM_ID,
		sender: "@alice:example.com",
		origin_server_ts: 1000,
		content:
			options?.content ??
			pollStartContent(
				"Best pizza?",
				[
					{ id: "a", text: "Margherita" },
					{ id: "b", text: "Pepperoni" },
					{ id: "c", text: "Hawaiian" },
				],
				options,
			),
	});
}

function responseEvent(args: {
	eventId: string;
	sender: string;
	answers?: string[];
	ts: number;
	status?: EventStatus;
}): MatrixEvent {
	const event = new MatrixEvent({
		type: "org.matrix.msc3381.poll.response",
		event_id: args.eventId,
		room_id: ROOM_ID,
		sender: args.sender,
		origin_server_ts: args.ts,
		content: {
			"m.relates_to": { rel_type: "m.reference", event_id: POLL_ID },
			"org.matrix.msc3381.poll.response": {
				answers:
					args.answers && args.answers.length > 0 ? args.answers : undefined,
			},
		},
	});
	if (args.status) event.setStatus(args.status);
	return event;
}

function parsedStart(
	options?: Parameters<typeof pollStartContent>[2],
): PollStartInfo {
	const info = parsePollStart(startEvent(options));
	if (!info) throw new Error("test poll start must parse");
	return info;
}

describe("parsePollStart", () => {
	it("parses question, answers, kind, and max selections", () => {
		const info = parsedStart({ kind: "undisclosed", maxSelections: 2 });
		expect(info.question).toBe("Best pizza?");
		expect(info.answers).toEqual([
			{ id: "a", text: "Margherita" },
			{ id: "b", text: "Pepperoni" },
			{ id: "c", text: "Hawaiian" },
		]);
		expect(info.kind).toBe("undisclosed");
		expect(info.maxSelections).toBe(2);
	});

	it("defaults to single-select disclosed", () => {
		const info = parsedStart();
		expect(info.kind).toBe("disclosed");
		expect(info.maxSelections).toBe(1);
	});

	it("treats unknown kinds as undisclosed (fail closed)", () => {
		const content = pollStartContent("Q?", [
			{ id: "a", text: "A" },
			{ id: "b", text: "B" },
		]);
		(content["org.matrix.msc3381.poll.start"] as Record<string, unknown>).kind =
			"org.example.fancy.kind";
		const info = parsePollStart(startEvent({ content }));
		expect(info?.kind).toBe("undisclosed");
	});

	it("parses stable-prefix content", () => {
		const info = parsePollStart(
			new MatrixEvent({
				type: "m.poll.start",
				event_id: POLL_ID,
				room_id: ROOM_ID,
				sender: "@alice:example.com",
				origin_server_ts: 1000,
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
			}),
		);
		expect(info?.question).toBe("Stable?");
		expect(info?.answers.map((a) => a.id)).toEqual(["y", "n"]);
		expect(info?.kind).toBe("disclosed");
	});

	it("returns null for malformed content", () => {
		expect(
			parsePollStart(
				new MatrixEvent({
					type: "org.matrix.msc3381.poll.start",
					event_id: POLL_ID,
					room_id: ROOM_ID,
					sender: "@alice:example.com",
					origin_server_ts: 1000,
					content: { "org.matrix.msc3381.poll.start": { question: {} } },
				}),
			),
		).toBeNull();
	});

	it("returns null for redacted events", () => {
		// `isRedacted()` keys off unsigned.redacted_because, exactly what the
		// server sets when an event is redacted before we saw it.
		const event = new MatrixEvent({
			type: "org.matrix.msc3381.poll.start",
			event_id: POLL_ID,
			room_id: ROOM_ID,
			sender: "@alice:example.com",
			origin_server_ts: 1000,
			content: {},
			unsigned: {
				redacted_because: {
					type: "m.room.redaction",
					event_id: "$redaction",
					room_id: ROOM_ID,
					sender: "@alice:example.com",
					origin_server_ts: 2000,
					content: {},
					unsigned: {},
				},
			},
		});
		expect(parsePollStart(event)).toBeNull();
	});
});

describe("computePollTally", () => {
	const start = parsedStart();
	const multiStart = parsedStart({ maxSelections: 2 });

	it("counts one ballot per sender and reports voters, not answers", () => {
		const tally = computePollTally(
			[
				responseEvent({
					eventId: "$1",
					sender: "@alice:example.com",
					answers: ["a"],
					ts: 100,
				}),
				responseEvent({
					eventId: "$2",
					sender: "@bob:example.com",
					answers: ["a"],
					ts: 110,
				}),
				responseEvent({
					eventId: "$3",
					sender: "@carol:example.com",
					answers: ["b"],
					ts: 120,
				}),
			],
			start,
			"@bob:example.com",
		);
		expect(tally.counts).toEqual({ a: 2, b: 1, c: 0 });
		expect(tally.totalVotes).toBe(3);
		expect(tally.myAnswers).toEqual(["a"]);
	});

	it("keeps the latest ballot per sender by timestamp", () => {
		const tally = computePollTally(
			[
				responseEvent({
					eventId: "$1",
					sender: "@alice:example.com",
					answers: ["a"],
					ts: 100,
				}),
				responseEvent({
					eventId: "$2",
					sender: "@alice:example.com",
					answers: ["b"],
					ts: 200,
				}),
			],
			start,
			null,
		);
		expect(tally.counts).toEqual({ a: 0, b: 1, c: 0 });
		expect(tally.totalVotes).toBe(1);
	});

	it("breaks timestamp ties deterministically by event id", () => {
		const newer = responseEvent({
			eventId: "$b",
			sender: "@alice:example.com",
			answers: ["b"],
			ts: 100,
		});
		const older = responseEvent({
			eventId: "$a",
			sender: "@alice:example.com",
			answers: ["a"],
			ts: 100,
		});
		const forward = computePollTally([older, newer], start, null);
		const reversed = computePollTally([newer, older], start, null);
		expect(forward.counts).toEqual(reversed.counts);
		expect(forward.counts.b).toBe(1);
	});

	it("treats an empty ballot as spoiled (vote retraction)", () => {
		const tally = computePollTally(
			[
				responseEvent({
					eventId: "$1",
					sender: "@alice:example.com",
					answers: ["a"],
					ts: 100,
				}),
				responseEvent({
					eventId: "$2",
					sender: "@alice:example.com",
					answers: [],
					ts: 200,
				}),
			],
			start,
			"@alice:example.com",
		);
		expect(tally.counts).toEqual({ a: 0, b: 0, c: 0 });
		expect(tally.totalVotes).toBe(0);
		expect(tally.myAnswers).toEqual([]);
	});

	it("spoils the whole ballot on an unknown answer id", () => {
		const tally = computePollTally(
			[
				responseEvent({
					eventId: "$1",
					sender: "@alice:example.com",
					answers: ["a", "nope"],
					ts: 100,
				}),
			],
			start,
			null,
		);
		expect(tally.totalVotes).toBe(0);
		expect(tally.counts.a).toBe(0);
	});

	it("truncates ballots to maxSelections", () => {
		const tally = computePollTally(
			[
				responseEvent({
					eventId: "$1",
					sender: "@alice:example.com",
					answers: ["a", "b", "c"],
					ts: 100,
				}),
			],
			multiStart,
			null,
		);
		expect(tally.counts).toEqual({ a: 1, b: 1, c: 0 });
		expect(tally.totalVotes).toBe(1);
	});

	it("ignores failed and cancelled local echoes", () => {
		const tally = computePollTally(
			[
				responseEvent({
					eventId: "$1",
					sender: "@alice:example.com",
					answers: ["a"],
					ts: 100,
				}),
				responseEvent({
					eventId: "$2",
					sender: "@alice:example.com",
					answers: ["b"],
					ts: 200,
					status: EventStatus.NOT_SENT,
				}),
				responseEvent({
					eventId: "$3",
					sender: "@bob:example.com",
					answers: ["b"],
					ts: 210,
					status: EventStatus.CANCELLED,
				}),
			],
			start,
			null,
		);
		expect(tally.counts).toEqual({ a: 1, b: 0, c: 0 });
		expect(tally.totalVotes).toBe(1);
	});

	it("returns zero counts for every answer with no responses", () => {
		const tally = computePollTally([], start, null);
		expect(tally.counts).toEqual({ a: 0, b: 0, c: 0 });
		expect(tally.totalVotes).toBe(0);
		expect(tally.myAnswers).toEqual([]);
	});
});

describe("buildPollSnapshot", () => {
	const start = parsedStart();

	it("builds a provisional zero-count snapshot from a null tally", () => {
		const snapshot = buildPollSnapshot({
			pollId: POLL_ID,
			start,
			tally: null,
			isEnded: false,
			undecryptableCount: 0,
			loadingResults: true,
		});
		expect(snapshot.counts).toEqual({ a: 0, b: 0, c: 0 });
		expect(snapshot.totalVotes).toBe(0);
		expect(snapshot.myAnswers).toEqual([]);
		expect(snapshot.loadingResults).toBe(true);
		expect(snapshot.question).toBe("Best pizza?");
	});

	it("carries the tally and poll state through", () => {
		const snapshot = buildPollSnapshot({
			pollId: POLL_ID,
			start,
			tally: { counts: { a: 2, b: 0, c: 1 }, totalVotes: 3, myAnswers: ["c"] },
			isEnded: true,
			undecryptableCount: 2,
			loadingResults: false,
		});
		expect(snapshot.counts).toEqual({ a: 2, b: 0, c: 1 });
		expect(snapshot.totalVotes).toBe(3);
		expect(snapshot.myAnswers).toEqual(["c"]);
		expect(snapshot.isEnded).toBe(true);
		expect(snapshot.undecryptableCount).toBe(2);
	});
});
