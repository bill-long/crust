import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { describe, expect, it, vi } from "vitest";
import type { TimelineEvent } from "./timelineTypes";
import { useUnreadMarker } from "./useUnreadMarker";

const ME = "@me:example.com";
const THEM = "@them:example.com";

let nextTs = 1000;
function row(
	eventId: string,
	senderId: string = THEM,
	timestamp = nextTs++,
): TimelineEvent {
	return { eventId, senderId, timestamp, stateNotice: null } as TimelineEvent;
}

/** Raw-window stand-in: only getId() is read by the resolver. */
function raw(eventId: string): MatrixEvent {
	return { getId: () => eventId } as MatrixEvent;
}

interface Scope {
	readUpTo: string | null;
}

interface MountOptions {
	/** Raw SDK window; defaults to mirroring the rendered rows. */
	windowEvents?: MatrixEvent[];
	threads?: Record<string, Scope>;
	/** Withhold the room from the store until `events` next changes. */
	roomMissingAtFirst?: boolean;
}

function mount(
	scope: Scope,
	events: readonly TimelineEvent[],
	options: MountOptions = {},
) {
	const roomStub = {
		getEventReadUpTo: vi.fn(() => scope.readUpTo),
		getThread: vi.fn((id: string) => {
			const t = options.threads?.[id];
			return t ? { getEventReadUpTo: () => t.readUpTo } : null;
		}),
	};
	let roomAvailable = !options.roomMissingAtFirst;
	// The hook subscribes to RoomEvent.Receipt so a receipt landing after the
	// rows have settled still re-triggers the capture.
	const receiptListeners = new Set<
		(e: unknown, r: { roomId: string }) => void
	>();
	const client = {
		getUserId: () => ME,
		getRoom: vi.fn(() => (roomAvailable ? roomStub : null)),
		on: vi.fn(
			(_event: string, fn: (e: unknown, r: { roomId: string }) => void) => {
				receiptListeners.add(fn);
			},
		),
		off: vi.fn(
			(_event: string, fn: (e: unknown, r: { roomId: string }) => void) => {
				receiptListeners.delete(fn);
			},
		),
	} as unknown as MatrixClient;

	const [roomId, setRoomId] = createSignal("!a:example.com");
	const [thread, setThread] = createSignal<{ threadId: string } | undefined>(
		undefined,
	);
	// A store, not a signal: production passes `useTimeline`'s store array, and
	// a signal would hide the fact that reading the accessor alone tracks
	// nothing on a store proxy.
	const [rows, setRowStore] = createStore<TimelineEvent[]>([...events]);
	const setRows = (next: readonly TimelineEvent[]): void =>
		setRowStore(reconcile([...next]));
	const [windowEvents, setWindowEvents] = createSignal<MatrixEvent[]>(
		options.windowEvents ?? events.map((e) => raw(e.eventId)),
	);

	const marker = createRoot(() =>
		useUnreadMarker(client, roomId, thread, {
			events: () => rows,
			getWindowEvents: () => windowEvents(),
		}),
	);
	return {
		marker,
		setRoomId,
		setThread,
		setRows,
		setWindowEvents,
		makeRoomAvailable: () => {
			roomAvailable = true;
		},
		hideRoom: () => {
			roomAvailable = false;
		},
		emitReceipt: (room = "!a:example.com") => {
			for (const fn of receiptListeners) fn({}, { roomId: room });
		},
	};
}

describe("useUnreadMarker divider placement", () => {
	it("points at the first row after our receipt", () => {
		const { marker } = mount({ readUpTo: "$a" }, [
			row("$a"),
			row("$b"),
			row("$c"),
		]);
		expect(marker.firstUnreadEventId()).toBe("$b");
	});

	it("holds the boundary still as our receipt moves on", () => {
		// The whole reason this is a snapshot: opening a room sends a receipt
		// for the newest event straight away, so reading live would erase the
		// divider in the same frame the user arrived to look at it.
		const scope: Scope = { readUpTo: "$a" };
		const { marker, setRows, setWindowEvents } = mount(scope, [
			row("$a"),
			row("$b"),
		]);
		expect(marker.firstUnreadEventId()).toBe("$b");

		scope.readUpTo = "$b";
		setRows([row("$a"), row("$b"), row("$c")]);
		setWindowEvents([raw("$a"), raw("$b"), raw("$c")]);

		expect(marker.firstUnreadEventId()).toBe("$b");
	});

	it("re-snapshots when the user opens a different room", () => {
		const scope: Scope = { readUpTo: "$a" };
		const { marker, setRoomId, setRows, setWindowEvents } = mount(scope, [
			row("$a"),
			row("$b"),
		]);
		expect(marker.firstUnreadEventId()).toBe("$b");

		scope.readUpTo = "$c";
		setRows([row("$c"), row("$d")]);
		setWindowEvents([raw("$c"), raw("$d")]);
		setRoomId("!other:example.com");

		expect(marker.firstUnreadEventId()).toBe("$d");
	});

	it("reads the thread's own receipt in the thread panel", () => {
		const { marker, setThread, setRows, setWindowEvents } = mount(
			{ readUpTo: "$main" },
			[row("$main"), row("$after")],
			{ threads: { $root: { readUpTo: "$t1" } } },
		);
		expect(marker.firstUnreadEventId()).toBe("$after");

		setRows([row("$t1"), row("$t2")]);
		setWindowEvents([raw("$t1"), raw("$t2")]);
		setThread({ threadId: "$root" });

		expect(marker.firstUnreadEventId()).toBe("$t2");
	});

	it("resolves a receipt that landed on a row we never draw", () => {
		// Reacting from another client leaves our receipt on the m.reaction,
		// which the timeline filters out. Without the walk-back the boundary
		// would vanish even though it sits well inside the window.
		const { marker } = mount(
			{ readUpTo: "$reaction" },
			[row("$a"), row("$b"), row("$c")],
			{ windowEvents: [raw("$a"), raw("$b"), raw("$reaction"), raw("$c")] },
		);
		expect(marker.firstUnreadEventId()).toBe("$c");
	});

	it("recovers when the scope is not in the store yet", () => {
		// The real shape of a cold open: no rows and no room yet. A thread's
		// Thread object in particular is created lazily, and the room subtree
		// is keyed - nothing re-mounts to try again, so a miss at the first
		// evaluation would disable the divider for the whole visit.
		const { marker, setRows, setWindowEvents, makeRoomAvailable } = mount(
			{ readUpTo: "$a" },
			[],
			{ roomMissingAtFirst: true },
		);
		expect(marker.firstUnreadEventId()).toBeNull();

		makeRoomAvailable();
		setRows([row("$a"), row("$b")]);
		setWindowEvents([raw("$a"), raw("$b")]);

		expect(marker.firstUnreadEventId()).toBe("$b");
	});

	it("does not mark a message that arrives while the user is watching", () => {
		// The failure this guards: the snapshot sits behind the newest event,
		// so anything arriving afterwards looks unread and pulls a red
		// divider in above itself - for a message the user watched land.
		const scope: Scope = { readUpTo: "$b" };
		const { marker, setRows, setWindowEvents } = mount(scope, [
			row("$a"),
			row("$b"),
		]);
		expect(marker.firstUnreadEventId()).toBeNull();

		setRows([row("$a"), row("$b"), row("$c")]);
		setWindowEvents([raw("$a"), raw("$b"), raw("$c")]);

		expect(marker.firstUnreadEventId()).toBeNull();
	});

	it("does not move the boundary as the conversation continues", () => {
		const scope: Scope = { readUpTo: "$a" };
		const { marker, setRows, setWindowEvents } = mount(scope, [
			row("$a"),
			row("$b"),
		]);
		expect(marker.firstUnreadEventId()).toBe("$b");

		setRows([row("$a"), row("$b"), row("$c"), row("$d")]);
		setWindowEvents([raw("$a"), raw("$b"), raw("$c"), raw("$d")]);

		expect(marker.firstUnreadEventId()).toBe("$b");
	});

	it("keeps trying while the receipt has not arrived", () => {
		// A room can reach the store before its m.receipt ephemeral is
		// applied. Freezing on that would disable the divider for the visit.
		const scope: Scope = { readUpTo: null };
		const { marker, setRows, setWindowEvents } = mount(scope, [
			row("$a"),
			row("$b"),
		]);
		expect(marker.firstUnreadEventId()).toBeNull();

		scope.readUpTo = "$a";
		setRows([row("$a"), row("$b"), row("$c")]);
		setWindowEvents([raw("$a"), raw("$b"), raw("$c")]);

		expect(marker.firstUnreadEventId()).toBe("$b");
	});

	it("places the boundary once back-pagination reaches it", () => {
		// More unread than the initial window: the receipt resolves to nothing
		// at first. Freezing on that failure would leave the divider off for
		// the whole visit even after the user scrolls back to it - and this
		// is the case where they most need it.
		const scope: Scope = { readUpTo: "$old" };
		const { marker, setRows, setWindowEvents } = mount(scope, [
			row("$c"),
			row("$d"),
		]);
		expect(marker.firstUnreadEventId()).toBeNull();

		setRows([row("$old"), row("$c"), row("$d")]);
		setWindowEvents([raw("$old"), raw("$c"), raw("$d")]);

		expect(marker.firstUnreadEventId()).toBe("$c");
	});

	it("does not decide a room from the previous room's rows", () => {
		// The scope switches before the store swaps its rows, which is the
		// production ordering. Deciding in that window resolves the new
		// room's receipt against the old room's events, finds nothing, and
		// would freeze the new room with no divider at all.
		const scope: Scope = { readUpTo: "$a" };
		const { marker, setRoomId, setRows, setWindowEvents } = mount(scope, [
			row("$a"),
			row("$b"),
		]);
		expect(marker.firstUnreadEventId()).toBe("$b");

		scope.readUpTo = "$x";
		setRoomId("!other:example.com");
		expect(marker.firstUnreadEventId()).toBeNull();

		setRows([row("$x"), row("$y")]);
		setWindowEvents([raw("$x"), raw("$y")]);

		expect(marker.firstUnreadEventId()).toBe("$y");
	});

	it("captures a receipt that arrives after the rows have settled", () => {
		// m.receipt is an ephemeral: it touches no timeline event, so without
		// the receipt subscription nothing would re-run the capture.
		const scope: Scope = { readUpTo: null };
		const { marker, emitReceipt } = mount(scope, [row("$a"), row("$b")]);
		expect(marker.firstUnreadEventId()).toBeNull();

		scope.readUpTo = "$a";
		emitReceipt();

		expect(marker.firstUnreadEventId()).toBe("$b");
	});

	it("marks nothing when we have never read the room", () => {
		const { marker } = mount({ readUpTo: null }, [row("$a"), row("$b")]);
		expect(marker.firstUnreadEventId()).toBeNull();
	});
});

describe("useUnreadMarker scope changes", () => {
	it("does not carry a receipt into a room whose store entry is missing", () => {
		// Between the switch and the store catching up, holding the previous
		// snapshot would place this room's divider from another room's
		// receipt - and offer a jump to an event it has never seen.
		const scope: Scope = { readUpTo: "$a" };
		const { marker, setRoomId, setRows, setWindowEvents, hideRoom } = mount(
			scope,
			[row("$a"), row("$b")],
		);
		expect(marker.firstUnreadEventId()).toBe("$b");

		hideRoom();
		setRows([row("$x"), row("$y")]);
		setWindowEvents([raw("$x"), raw("$y")]);
		setRoomId("!other:example.com");

		expect(marker.firstUnreadEventId()).toBeNull();
	});
});
