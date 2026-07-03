import { MatrixEvent, type Thread } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	buildProvisionalThreadSummary,
	buildThreadSummaryFromThread,
} from "./threadSummary";

function rootWithBundle(bundle: unknown): MatrixEvent {
	return new MatrixEvent({
		type: "m.room.message",
		event_id: "$root",
		room_id: "!r:hs",
		sender: "@a:hs",
		origin_server_ts: 1,
		content: { msgtype: "m.text", body: "root" },
		unsigned: { "m.relations": { "m.thread": bundle } },
	});
}

describe("buildProvisionalThreadSummary", () => {
	it("builds from the server-aggregated bundle", () => {
		const summary = buildProvisionalThreadSummary(
			rootWithBundle({
				count: 3,
				current_user_participated: true,
				latest_event: {
					sender: "@b:hs",
					origin_server_ts: 5000,
					type: "m.room.message",
					content: { msgtype: "m.text", body: "latest" },
				},
			}),
		);
		expect(summary).toEqual({
			threadId: "$root",
			replyCount: 3,
			latestSender: "@b:hs",
			latestTs: 5000,
			currentUserParticipated: true,
			provisional: true,
		});
	});

	it("returns null without a bundle (no chip for plain messages)", () => {
		const plain = new MatrixEvent({
			type: "m.room.message",
			event_id: "$plain",
			room_id: "!r:hs",
			sender: "@a:hs",
			origin_server_ts: 1,
			content: { msgtype: "m.text", body: "no thread" },
		});
		expect(buildProvisionalThreadSummary(plain)).toBeNull();
	});

	it("returns null for a zero-count bundle", () => {
		expect(
			buildProvisionalThreadSummary(
				rootWithBundle({ count: 0, current_user_participated: false }),
			),
		).toBeNull();
	});

	it("tolerates hostile/missing bundle fields", () => {
		const summary = buildProvisionalThreadSummary(
			rootWithBundle({
				count: 2,
				current_user_participated: "yes",
				latest_event: { sender: 42, origin_server_ts: "soon" },
			}),
		);
		expect(summary).toEqual({
			threadId: "$root",
			replyCount: 2,
			latestSender: null,
			latestTs: null,
			currentUserParticipated: false,
			provisional: true,
		});
	});
});

describe("buildThreadSummaryFromThread", () => {
	function threadStub(overrides?: {
		length?: number;
		last?: { sender: string; ts: number } | null;
		participated?: boolean;
	}): Thread {
		const last = overrides?.last;
		const lastEvent = last
			? {
					getSender: () => last.sender,
					getTs: () => last.ts,
				}
			: null;
		return {
			id: "$root",
			length: overrides?.length ?? 2,
			replyToEvent: lastEvent,
			lastReply: () => lastEvent,
			hasCurrentUserParticipated: overrides?.participated ?? false,
		} as unknown as Thread;
	}

	it("builds from a live Thread", () => {
		const summary = buildThreadSummaryFromThread(
			threadStub({
				length: 4,
				last: { sender: "@c:hs", ts: 9000 },
				participated: true,
			}),
		);
		expect(summary).toEqual({
			threadId: "$root",
			replyCount: 4,
			latestSender: "@c:hs",
			latestTs: 9000,
			currentUserParticipated: true,
			provisional: false,
		});
	});

	it("returns null for a thread with no replies (no chip)", () => {
		expect(buildThreadSummaryFromThread(threadStub({ length: 0 }))).toBeNull();
	});

	it("tolerates an absent latest reply (undecryptable/unfetched)", () => {
		const summary = buildThreadSummaryFromThread(
			threadStub({ length: 1, last: null }),
		);
		expect(summary?.latestSender).toBeNull();
		expect(summary?.latestTs).toBeNull();
	});
});
