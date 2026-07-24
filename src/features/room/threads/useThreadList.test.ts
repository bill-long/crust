import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { RoomEvent, ThreadEvent } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { rootSnippet, useThreadList } from "./useThreadList";

const ROOM_ID = "!room:example.com";

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeThreadInit {
	id: string;
	replyCount?: number;
	latestTs?: number | null;
	latestSender?: string;
	rootBody?: string;
	rootTs?: number;
	rootSender?: string;
	participated?: boolean;
}

/** Thread-shaped object matching what buildThreadSummaryFromThread and the
 *  list projection read; registered via room.threads.set(...). */
function fakeThread(init: FakeThreadInit) {
	const latestTs = init.latestTs === undefined ? 5000 : init.latestTs;
	return {
		id: init.id,
		length: init.replyCount ?? 1,
		replyToEvent:
			latestTs === null
				? null
				: {
						getSender: () => init.latestSender ?? "@bob:example.com",
						getTs: () => latestTs,
					},
		hasCurrentUserParticipated: init.participated ?? false,
		initialEventsFetched: true,
		rootEvent: {
			getId: () => init.id,
			getSender: () => init.rootSender ?? "@alice:example.com",
			getTs: () => init.rootTs ?? 1000,
			getContent: () => ({
				msgtype: "m.text",
				body: init.rootBody ?? `root of ${init.id}`,
			}),
			isRedacted: () => false,
			isDecryptionFailure: () => false,
			unstableExtensibleEvent: undefined,
		},
	};
}

function setup(opts?: {
	rooms?: Map<string, ReturnType<typeof createMockRoom>>;
}) {
	const room = createMockRoom(
		ROOM_ID,
		[],
		[{ userId: "@alice:example.com", name: "Alice" }],
	);
	const rooms = opts?.rooms ?? new Map([[ROOM_ID, room]]);
	const client = createMockClient(rooms);
	return { room, client };
}

describe("rootSnippet", () => {
	const base = {
		isRedacted: () => false,
		isDecryptionFailure: () => false,
		unstableExtensibleEvent: undefined,
	};

	it("uses the body for text roots", () => {
		const ev = {
			...base,
			getContent: () => ({ msgtype: "m.text", body: " hello " }),
		} as unknown as MatrixEvent;
		expect(rootSnippet(ev)).toBe("hello");
	});

	it("uses the poll question for poll roots", () => {
		const ev = {
			...base,
			unstableExtensibleEvent: {
				question: { text: "Best pizza?" },
				answers: [{ id: "a", text: "A" }],
			},
			getContent: () => ({}),
		} as unknown as MatrixEvent;
		expect(rootSnippet(ev)).toBe("Best pizza?");
	});

	it("labels undecryptable roots", () => {
		const ev = {
			...base,
			isDecryptionFailure: () => true,
			getContent: () => ({}),
		} as unknown as MatrixEvent;
		expect(rootSnippet(ev)).toBe("Encrypted message");
	});

	it("falls back to a placeholder for bodyless roots", () => {
		const ev = {
			...base,
			getContent: () => ({ msgtype: "m.image" }),
		} as unknown as MatrixEvent;
		expect(rootSnippet(ev)).toBe("Message");
	});

	it("labels redacted roots instead of leaking leftover content", () => {
		const ev = {
			...base,
			isRedacted: () => true,
			getContent: () => ({ msgtype: "m.text", body: "stale" }),
		} as unknown as MatrixEvent;
		expect(rootSnippet(ev)).toBe("Message deleted");
	});
});

describe("useThreadList", () => {
	it("stays idle until opened, then fetches and projects rows newest-activity-first", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$old", fakeThread({ id: "$old", latestTs: 2000 }));
			room.threads.set(
				"$new",
				fakeThread({ id: "$new", latestTs: 9000, replyCount: 3 }),
			);
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			expect(list.status()).toBe("idle");
			expect(room.createThreadsTimelineSets).not.toHaveBeenCalled();

			setOpen(true);
			await flushMicrotasks();
			expect(room.createThreadsTimelineSets).toHaveBeenCalledOnce();
			expect(room.fetchRoomThreads).toHaveBeenCalledOnce();
			expect(list.status()).toBe("ready");
			expect(list.degraded()).toBe(false);
			expect(list.rows().map((r) => r.rootId)).toEqual(["$new", "$old"]);
			expect(list.rows()[0]?.summary.replyCount).toBe(3);
			expect(list.rows()[0]?.senderName).toBe("Alice");
			dispose();
		});
	});

	it("degrades gracefully when the server list fetch fails", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$known", fakeThread({ id: "$known" }));
			room.fetchRoomThreads.mockRejectedValue(new Error("M_UNRECOGNIZED"));
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			setOpen(true);
			await flushMicrotasks();
			expect(list.status()).toBe("ready");
			expect(list.degraded()).toBe(true);
			expect(list.hasMore()).toBe(false);
			// The session's known threads still render.
			expect(list.rows().map((r) => r.rootId)).toEqual(["$known"]);
			expect(consoleError).toHaveBeenCalled();
			consoleError.mockRestore();
			dispose();
		});
	});

	it("skips threads with no replies (no row for an empty panel)", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set(
				"$empty",
				fakeThread({ id: "$empty", replyCount: 0, latestTs: null }),
			);
			room.threads.set("$real", fakeThread({ id: "$real" }));
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			setOpen(true);
			await flushMicrotasks();
			expect(list.rows().map((r) => r.rootId)).toEqual(["$real"]);
			dispose();
		});
	});

	it("rebuilds on thread lifecycle emissions (new reply reorders the list)", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			const a = fakeThread({ id: "$a", latestTs: 2000 });
			const b = fakeThread({ id: "$b", latestTs: 3000 });
			room.threads.set("$a", a);
			room.threads.set("$b", b);
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			setOpen(true);
			await flushMicrotasks();
			expect(list.rows().map((r) => r.rootId)).toEqual(["$b", "$a"]);

			// A reply lands in $a: its Thread object advances, the room
			// re-emits NewReply, and the list reorders.
			a.replyToEvent = {
				getSender: () => "@bob:example.com",
				getTs: () => 9000,
			};
			a.length = 2;
			room.__emit(ThreadEvent.NewReply, a);
			await flushMicrotasks();
			expect(list.rows().map((r) => r.rootId)).toEqual(["$a", "$b"]);
			expect(list.rows()[0]?.summary.replyCount).toBe(2);
			dispose();
		});
	});

	it("folds per-thread unread counts in and tracks their updates", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$t", fakeThread({ id: "$t" }));
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			setOpen(true);
			await flushMicrotasks();
			expect(list.rows()[0]?.summary.unreadCount).toBe(0);

			room.__setThreadUnread("$t", 2);
			room.__emit(RoomEvent.UnreadNotifications, { total: 2 }, "$t");
			await flushMicrotasks();
			expect(list.rows()[0]?.summary.unreadCount).toBe(2);
			dispose();
		});
	});

	it("resets on room switch and refetches lazily for the new room", async () => {
		await createRoot(async (dispose) => {
			const roomA = createMockRoom("!a:example.com");
			const roomB = createMockRoom("!b:example.com");
			roomA.threads.set("$a", fakeThread({ id: "$a" }));
			roomB.threads.set("$b", fakeThread({ id: "$b" }));
			const client = createMockClient(
				new Map([
					["!a:example.com", roomA],
					["!b:example.com", roomB],
				]),
			);
			const [open, setOpen] = createSignal(true);
			const [rid, setRid] = createSignal("!a:example.com");
			const list = useThreadList(client as unknown as MatrixClient, rid, open);
			await flushMicrotasks();
			expect(list.rows().map((r) => r.rootId)).toEqual(["$a"]);

			// Close before switching (the real panel closes on navigation);
			// the new room's fetch must be lazy again.
			setOpen(false);
			setRid("!b:example.com");
			expect(list.status()).toBe("idle");
			expect(list.rows()).toEqual([]);
			expect(roomB.fetchRoomThreads).not.toHaveBeenCalled();

			setOpen(true);
			await flushMicrotasks();
			expect(roomB.fetchRoomThreads).toHaveBeenCalledOnce();
			expect(list.rows().map((r) => r.rootId)).toEqual(["$b"]);
			dispose();
		});
	});

	it("ignores a fetch that settles after the room switched (generation guard)", async () => {
		await createRoot(async (dispose) => {
			const roomA = createMockRoom("!a:example.com");
			const roomB = createMockRoom("!b:example.com");
			roomA.threads.set("$a", fakeThread({ id: "$a" }));
			roomB.threads.set("$b", fakeThread({ id: "$b" }));
			let resolveA: (() => void) | undefined;
			roomA.fetchRoomThreads.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						resolveA = resolve;
					}),
			);
			// Room A's list set would report more pages - the stale resolve
			// must not leak that into room B's state.
			roomA.threadsTimelineSets = [
				{ getLiveTimeline: () => ({ getPaginationToken: () => "tok" }) },
			];
			const client = createMockClient(
				new Map([
					["!a:example.com", roomA],
					["!b:example.com", roomB],
				]),
			);
			const [open] = createSignal(true);
			const [rid, setRid] = createSignal("!a:example.com");
			const list = useThreadList(client as unknown as MatrixClient, rid, open);
			await flushMicrotasks();
			// A's fetch still pending: rows already painted from known threads.
			expect(list.status()).toBe("loading");
			expect(list.rows().map((r) => r.rootId)).toEqual(["$a"]);

			setRid("!b:example.com");
			await flushMicrotasks();
			expect(list.rows().map((r) => r.rootId)).toEqual(["$b"]);

			resolveA?.();
			await flushMicrotasks();
			// The stale resolution must not flip status/hasMore or rebuild
			// against room A.
			expect(list.rows().map((r) => r.rootId)).toEqual(["$b"]);
			expect(list.hasMore()).toBe(false);
			dispose();
		});
	});

	it("paints known threads immediately while the server fetch is in flight", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$known", fakeThread({ id: "$known" }));
			room.fetchRoomThreads.mockImplementation(
				() => new Promise<void>(() => {}),
			);
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			setOpen(true);
			await flushMicrotasks();
			expect(list.status()).toBe("loading");
			expect(list.rows().map((r) => r.rootId)).toEqual(["$known"]);
			dispose();
		});
	});

	it("returns to idle when the fetch fails after the panel already closed", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$t", fakeThread({ id: "$t" }));
			let rejectFetch: ((e: Error) => void) | undefined;
			room.fetchRoomThreads.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectFetch = reject;
					}),
			);
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const [open, setOpen] = createSignal(true);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			await flushMicrotasks();
			expect(list.status()).toBe("loading");

			// Close while the fetch is in flight - the close edge sees
			// degraded=false and can't schedule the retry - then fail.
			setOpen(false);
			rejectFetch?.(new Error("late failure"));
			await flushMicrotasks();
			expect(list.status()).toBe("idle");

			// Reopen retries; this time the (default-resolved) fetch works.
			setOpen(true);
			await flushMicrotasks();
			expect(room.fetchRoomThreads).toHaveBeenCalledTimes(2);
			expect(list.degraded()).toBe(false);
			expect(list.status()).toBe("ready");
			consoleError.mockRestore();
			dispose();
		});
	});

	it("retries a degraded load on the next open", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$t", fakeThread({ id: "$t" }));
			room.fetchRoomThreads.mockRejectedValueOnce(new Error("blip"));
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const [open, setOpen] = createSignal(true);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			await flushMicrotasks();
			expect(list.degraded()).toBe(true);

			// Close resets a degraded list to idle; reopening refetches, and
			// this time the (transient) failure is gone.
			setOpen(false);
			setOpen(true);
			await flushMicrotasks();
			expect(room.fetchRoomThreads).toHaveBeenCalledTimes(2);
			expect(list.degraded()).toBe(false);
			consoleError.mockRestore();
			dispose();
		});
	});

	it("defers rebuilds while closed and applies them once on reopen", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			const a = fakeThread({ id: "$a", latestTs: 2000 });
			room.threads.set("$a", a);
			const [open, setOpen] = createSignal(true);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			await flushMicrotasks();
			expect(list.rows()[0]?.summary.replyCount).toBe(1);

			// Replies land while the popover is closed: no rebuild yet.
			setOpen(false);
			a.length = 5;
			room.__emit(ThreadEvent.NewReply, a);
			await flushMicrotasks();
			expect(list.rows()[0]?.summary.replyCount).toBe(1);

			setOpen(true);
			await flushMicrotasks();
			expect(list.rows()[0]?.summary.replyCount).toBe(5);
			dispose();
		});
	});

	it("preserves untouched rows' identity across rebuilds (keyed reconcile)", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			const a = fakeThread({ id: "$a", latestTs: 9000 });
			const b = fakeThread({ id: "$b", latestTs: 2000 });
			room.threads.set("$a", a);
			room.threads.set("$b", b);
			const [open] = createSignal(true);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			await flushMicrotasks();
			const rowA = list.rows()[0];
			expect(rowA?.rootId).toBe("$a");

			// A reply lands in $b only: $a's row must keep its object
			// identity, or the panel's reference-keyed <For> would remount
			// every row button and drop keyboard focus to <body>.
			b.length = 4;
			room.__emit(ThreadEvent.NewReply, b);
			await flushMicrotasks();
			expect(list.rows().find((r) => r.rootId === "$a")).toBe(rowA);
			expect(
				list.rows().find((r) => r.rootId === "$b")?.summary.replyCount,
			).toBe(4);
			dispose();
		});
	});

	it("skips even the coalesced rebuild for room-level unread changes (no threadId)", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			const t = fakeThread({ id: "$t" });
			room.threads.set("$t", t);
			const [open] = createSignal(true);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			await flushMicrotasks();
			// Mutate the thread WITHOUT an accompanying thread event, then
			// fire a room-level unread change: if the hook rebuilt, the new
			// count would leak through - it must not.
			t.length = 9;
			room.__emit(RoomEvent.UnreadNotifications, { total: 7 });
			await flushMicrotasks();
			expect(list.rows()[0]?.summary.replyCount).toBe(1);
			dispose();
		});
	});

	it("exposes pagination from the list set's token and appends fetched roots", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$first", fakeThread({ id: "$first", latestTs: 9000 }));
			let token: string | null = "page2";
			const liveTimeline = {
				getPaginationToken: () => token,
			};
			room.threadsTimelineSets = [{ getLiveTimeline: () => liveTimeline }];
			client.paginateEventTimeline.mockImplementation(async () => {
				// The SDK's thread-list pagination runs processThreadRoots,
				// which materializes the older thread; mirror that.
				room.threads.set(
					"$older",
					fakeThread({ id: "$older", latestTs: 1000 }),
				);
				token = null;
				return true;
			});
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			setOpen(true);
			await flushMicrotasks();
			expect(list.hasMore()).toBe(true);

			list.loadMore();
			expect(list.loadingMore()).toBe(true);
			await flushMicrotasks();
			expect(client.paginateEventTimeline).toHaveBeenCalledOnce();
			expect(list.rows().map((r) => r.rootId)).toEqual(["$first", "$older"]);
			expect(list.hasMore()).toBe(false);
			expect(list.loadingMore()).toBe(false);
			dispose();
		});
	});

	it("keeps hasMore set when pagination fails, so the button can retry", async () => {
		await createRoot(async (dispose) => {
			const { room, client } = setup();
			room.threads.set("$t", fakeThread({ id: "$t" }));
			room.threadsTimelineSets = [
				{ getLiveTimeline: () => ({ getPaginationToken: () => "tok" }) },
			];
			client.paginateEventTimeline.mockRejectedValue(new Error("network"));
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const [open, setOpen] = createSignal(false);
			const list = useThreadList(
				client as unknown as MatrixClient,
				() => ROOM_ID,
				open,
			);
			setOpen(true);
			await flushMicrotasks();
			list.loadMore();
			await flushMicrotasks();
			expect(list.hasMore()).toBe(true);
			expect(list.loadingMore()).toBe(false);
			expect(consoleError).toHaveBeenCalled();
			consoleError.mockRestore();
			dispose();
		});
	});
});
