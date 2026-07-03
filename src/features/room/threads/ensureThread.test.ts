import type { Room, Thread } from "matrix-js-sdk";
import { ThreadEvent } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { ensureThread } from "./ensureThread";

function emitterThread(overrides?: {
	initialEventsFetched?: boolean;
}): Thread & {
	__emitUpdate: () => void;
	__emitDelete: () => void;
	__setFetched: () => void;
} {
	const listeners = new Map<unknown, Set<(...args: unknown[]) => void>>();
	const listenersFor = (event: unknown) => {
		let set = listeners.get(event);
		if (!set) {
			set = new Set();
			listeners.set(event, set);
		}
		return set;
	};
	const thread = {
		id: "$root",
		initialEventsFetched: overrides?.initialEventsFetched ?? true,
		on: (event: unknown, handler: (...args: unknown[]) => void) => {
			listenersFor(event).add(handler);
			return thread;
		},
		off: (event: unknown, handler: (...args: unknown[]) => void) => {
			listenersFor(event).delete(handler);
			return thread;
		},
		__emitUpdate: () => {
			for (const h of [...listenersFor(ThreadEvent.Update)]) h(thread);
		},
		__emitDelete: () => {
			for (const h of [...listenersFor(ThreadEvent.Delete)]) h(thread);
		},
		__setFetched: () => {
			(thread as { initialEventsFetched: boolean }).initialEventsFetched = true;
		},
	};
	return thread as unknown as Thread & {
		__emitUpdate: () => void;
		__emitDelete: () => void;
		__setFetched: () => void;
	};
}

describe("ensureThread", () => {
	it("returns an existing, fetched Thread immediately", async () => {
		const thread = emitterThread();
		const room = {
			getThread: () => thread,
		} as unknown as Room;
		expect(await ensureThread(room, "$root")).toBe(thread);
	});

	it("creates the Thread from the loaded root event when absent", async () => {
		const thread = emitterThread();
		const rootEvent = { getId: () => "$root" };
		const createThread = vi.fn(() => thread);
		const room = {
			getThread: () => null,
			findEventById: (id: string) => (id === "$root" ? rootEvent : null),
			createThread,
		} as unknown as Room;
		expect(await ensureThread(room, "$root")).toBe(thread);
		expect(createThread).toHaveBeenCalledWith("$root", rootEvent, [], false);
	});

	it("fetches the root from the server when not loaded (deep-link)", async () => {
		const thread = emitterThread();
		const createThread = vi.fn((..._args: unknown[]) => thread);
		const fetchRoomEvent = vi.fn(async () => ({
			event_id: "$root",
			type: "m.room.message",
			content: { msgtype: "m.text", body: "root" },
		}));
		const room = {
			roomId: "!r:hs",
			getThread: () => null,
			findEventById: () => null,
			createThread,
			client: { fetchRoomEvent, decryptEventIfNeeded: vi.fn(async () => {}) },
		} as unknown as Room;
		expect(await ensureThread(room, "$root")).toBe(thread);
		expect(fetchRoomEvent).toHaveBeenCalledWith("!r:hs", "$root");
		// createThread got a MatrixEvent wrapping the fetched root.
		expect(createThread).toHaveBeenCalledTimes(1);
		expect(createThread.mock.calls[0][0]).toBe("$root");
	});

	it("returns null when the server fetch fails (unloaded + unreachable)", async () => {
		const room = {
			roomId: "!r:hs",
			getThread: () => null,
			findEventById: () => null,
			client: {
				fetchRoomEvent: vi.fn(async () => {
					throw new Error("404");
				}),
			},
		} as unknown as Room;
		expect(await ensureThread(room, "$root")).toBeNull();
	});

	it("waits for the initial relations fetch before resolving", async () => {
		const thread = emitterThread({ initialEventsFetched: false });
		const room = {
			getThread: () => thread,
		} as unknown as Room;
		let resolved = false;
		const promise = ensureThread(room, "$root").then((t) => {
			resolved = true;
			return t;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(resolved).toBe(false);
		// The fetch settles: metadata update fires with the flag set.
		thread.__setFetched();
		thread.__emitUpdate();
		expect(await promise).toBe(thread);
	});

	it("settles early when the thread is deleted mid-wait (root redacted)", async () => {
		const thread = emitterThread({ initialEventsFetched: false });
		const room = {
			getThread: () => thread,
		} as unknown as Room;
		let resolved = false;
		const promise = ensureThread(room, "$root").then((t) => {
			resolved = true;
			return t;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(resolved).toBe(false);
		thread.__emitDelete();
		expect(await promise).toBe(thread);
	});

	it("resolves anyway after the timeout when the fetch never settles", async () => {
		vi.useFakeTimers();
		try {
			const thread = emitterThread({ initialEventsFetched: false });
			const room = {
				getThread: () => thread,
			} as unknown as Room;
			const promise = ensureThread(room, "$root");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await promise).toBe(thread);
		} finally {
			vi.useRealTimers();
		}
	});
});
