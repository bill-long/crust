import type { MatrixEvent, Room, Thread } from "matrix-js-sdk";
import { ThreadEvent } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	createMatrixEvent,
	createMockRoom,
	textMessage,
} from "../../../test/mockClient";
import { createThreadWatcher } from "./threadWatcher";

const ROOM_ID = "!room:test";

function threadStub(
	id: string,
	length: number,
	last?: { sender: string; ts: number },
): Thread {
	const lastEvent = last
		? { getSender: () => last.sender, getTs: () => last.ts }
		: null;
	return {
		id,
		length,
		replyToEvent: lastEvent,
		hasCurrentUserParticipated: false,
	} as unknown as Thread;
}

function setup() {
	const room = createMockRoom(ROOM_ID, []);
	const onUpdate = vi.fn();
	const watcher = createThreadWatcher(onUpdate);
	watcher.watchRoom(room as unknown as Room);
	const rootEvent = createMatrixEvent(
		textMessage(ROOM_ID, "$root", "@a:test", "root", 1000),
	) as unknown as MatrixEvent;
	return { room, watcher, onUpdate, rootEvent };
}

describe("createThreadWatcher", () => {
	it("resolves a live Thread into a summary and caches it", () => {
		const { room, watcher, rootEvent } = setup();
		room.threads.set(
			"$root",
			threadStub("$root", 2, { sender: "@b:test", ts: 5000 }),
		);
		const summary = watcher.getSummary(rootEvent, room as unknown as Room);
		expect(summary).toMatchObject({
			threadId: "$root",
			replyCount: 2,
			latestSender: "@b:test",
			provisional: false,
		});
		// Cached: same object back without re-derivation.
		expect(watcher.getSummary(rootEvent, room as unknown as Room)).toBe(
			summary,
		);
	});

	it("returns null for a plain message (no thread, no bundle)", () => {
		const { room, watcher, rootEvent } = setup();
		expect(watcher.getSummary(rootEvent, room as unknown as Room)).toBeNull();
	});

	it("recomputes and re-projects on room-level ThreadEvent emissions", () => {
		const { room, watcher, onUpdate, rootEvent } = setup();
		const thread = threadStub("$root", 1, { sender: "@b:test", ts: 5000 });
		room.threads.set("$root", thread);
		// Projection registers the root as visible.
		watcher.getSummary(rootEvent, room as unknown as Room);
		onUpdate.mockClear();

		room.threads.set(
			"$root",
			threadStub("$root", 2, { sender: "@c:test", ts: 6000 }),
		);
		room.__emit(
			ThreadEvent.NewReply,
			room.threads.get("$root"),
			createMatrixEvent(textMessage(ROOM_ID, "$r2", "@c:test", "re", 6000)),
		);
		expect(onUpdate).toHaveBeenCalledWith("$root");
		const summary = watcher.getSummary(rootEvent, room as unknown as Room);
		expect(summary?.replyCount).toBe(2);
		expect(summary?.latestSender).toBe("@c:test");
	});

	it("skips onUpdate when a recompute lands on an identical summary", () => {
		const { room, watcher, onUpdate, rootEvent } = setup();
		room.threads.set(
			"$root",
			threadStub("$root", 2, { sender: "@b:test", ts: 5000 }),
		);
		watcher.getSummary(rootEvent, room as unknown as Room);
		onUpdate.mockClear();

		// The SDK fires BOTH NewReply and Update per incoming reply: the
		// first recompute sees the new state and re-projects; the second
		// lands on an identical summary and must not re-project again.
		const grown = threadStub("$root", 3, { sender: "@c:test", ts: 6000 });
		room.threads.set("$root", grown);
		room.__emit(
			ThreadEvent.NewReply,
			grown,
			createMatrixEvent(textMessage(ROOM_ID, "$r3", "@c:test", "re", 6000)),
		);
		room.__emit(ThreadEvent.Update, grown);
		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it("ignores emissions for roots that were never projected", () => {
		const { room, onUpdate } = setup();
		room.__emit(ThreadEvent.Update, threadStub("$unseen", 3));
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("drops the summary on ThreadEvent.Delete", () => {
		const { room, watcher, onUpdate, rootEvent } = setup();
		const thread = threadStub("$root", 2);
		room.threads.set("$root", thread);
		watcher.getSummary(rootEvent, room as unknown as Room);
		onUpdate.mockClear();

		room.threads.delete("$root");
		room.__emit(ThreadEvent.Delete, thread);
		expect(onUpdate).toHaveBeenCalledWith("$root");
		expect(watcher.getSummary(rootEvent, room as unknown as Room)).toBeNull();
	});

	it("prunes tracking for ids that left the visible store", () => {
		const { room, watcher, onUpdate, rootEvent } = setup();
		const thread = threadStub("$root", 1, { sender: "@b:test", ts: 5000 });
		room.threads.set("$root", thread);
		watcher.getSummary(rootEvent, room as unknown as Room);
		onUpdate.mockClear();

		// The root scrolled out of the loaded window; its emissions must no
		// longer re-project (and the cached summary is re-derived on the
		// next projection rather than served stale).
		watcher.pruneProjected(new Set(["$other"]));
		room.__emit(
			ThreadEvent.Update,
			threadStub("$root", 2, { sender: "@c:test", ts: 6000 }),
		);
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("drops cache and listeners on room switch", () => {
		const { room, watcher, onUpdate, rootEvent } = setup();
		room.threads.set("$root", threadStub("$root", 2));
		watcher.getSummary(rootEvent, room as unknown as Room);
		onUpdate.mockClear();

		const other = createMockRoom("!other:test", []);
		watcher.watchRoom(other as unknown as Room);
		// Old room's emissions no longer reach the watcher.
		room.__emit(ThreadEvent.Update, threadStub("$root", 5));
		expect(onUpdate).not.toHaveBeenCalled();
		// Projections for the old room now get throwaway (uncached) summaries.
		const throwaway = watcher.getSummary(rootEvent, room as unknown as Room);
		expect(throwaway?.replyCount).toBe(2);
	});

	it("dispose removes listeners", () => {
		const { room, watcher, onUpdate, rootEvent } = setup();
		room.threads.set("$root", threadStub("$root", 2));
		watcher.getSummary(rootEvent, room as unknown as Room);
		onUpdate.mockClear();
		watcher.dispose();
		room.__emit(ThreadEvent.Update, threadStub("$root", 9));
		expect(onUpdate).not.toHaveBeenCalled();
	});
});
