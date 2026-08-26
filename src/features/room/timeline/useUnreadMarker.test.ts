import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { describe, expect, it, vi } from "vitest";
import type { TimelineEvent } from "./timelineTypes";
import { useUnreadMarker } from "./useUnreadMarker";

const ME = "@me:example.com";
const THEM = "@them:example.com";

function row(eventId: string, senderId: string = THEM): TimelineEvent {
	return { eventId, senderId, stateNotice: null } as TimelineEvent;
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
	/** Newer events exist beyond the loaded slice. */
	canLoadNewer?: boolean;
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
	const client = {
		getUserId: () => ME,
		getRoom: vi.fn(() => (roomAvailable ? roomStub : null)),
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
	const [canLoadNewer, setCanLoadNewer] = createSignal(
		options.canLoadNewer ?? false,
	);
	const [windowEvents, setWindowEvents] = createSignal<MatrixEvent[]>(
		options.windowEvents ?? events.map((e) => raw(e.eventId)),
	);

	const marker = createRoot(() =>
		useUnreadMarker(client, roomId, thread, {
			events: () => rows,
			getWindowEvents: () => windowEvents(),
			canLoadNewer,
		}),
	);
	return {
		marker,
		setRoomId,
		setThread,
		setRows,
		setCanLoadNewer,
		setWindowEvents,
		makeRoomAvailable: () => {
			roomAvailable = true;
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

	it("marks nothing when we have never read the room", () => {
		const { marker } = mount({ readUpTo: null }, [row("$a"), row("$b")]);
		expect(marker.firstUnreadEventId()).toBeNull();
	});
});

describe("useUnreadMarker jump target", () => {
	it("is the divider row when the boundary is in the window", () => {
		const { marker } = mount({ readUpTo: "$a" }, [row("$a"), row("$b")]);
		expect(marker.jumpTargetEventId()).toBe("$b");
	});

	it("falls back to the receipt when the boundary is off the window", () => {
		// More than a window's worth arrived since the last read: the divider
		// cannot be drawn, which is exactly when the user most needs a way
		// back. jumpToEvent loads that context.
		const { marker } = mount({ readUpTo: "$older" }, [row("$b"), row("$c")]);
		expect(marker.firstUnreadEventId()).toBeNull();
		expect(marker.jumpTargetEventId()).toBe("$older");
	});

	it("offers nothing while the user is reading back through history", () => {
		// Paginated away from the live end: an unfound receipt is just as
		// likely to be newer than the window as older, so pointing anywhere
		// would be a guess.
		const { marker } = mount({ readUpTo: "$older" }, [row("$b"), row("$c")], {
			canLoadNewer: true,
		});
		expect(marker.jumpTargetEventId()).toBeNull();
	});

	it("offers nothing once the receipt is the newest row", () => {
		const { marker } = mount({ readUpTo: "$b" }, [row("$a"), row("$b")]);
		expect(marker.jumpTargetEventId()).toBeNull();
	});
});
