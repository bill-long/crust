import type { MatrixClient, MatrixEvent, Room, Thread } from "matrix-js-sdk";
import { Direction, RoomEvent, ThreadEvent } from "matrix-js-sdk";
import {
	type Accessor,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { reportError } from "../../../lib/reportError";
import { parsePollStart } from "../poll/pollSnapshot";
import {
	buildThreadSummaryFromThread,
	type ThreadSummary,
	threadUnreadCount,
} from "./threadSummary";

/** Plain-data row for the room-wide thread list (issue #331). */
export interface ThreadListRow {
	rootId: string;
	senderName: string;
	/** One-line description of the root message (body, poll question, or a
	 *  typed placeholder). */
	snippet: string;
	/** Reply count / latest activity / unread, shared with the timeline's
	 *  ThreadSummaryChip renderer. */
	summary: ThreadSummary;
	/** Sort key: the latest reply's ts, falling back to the root's. */
	lastActivityTs: number;
}

export type ThreadListStatus = "idle" | "loading" | "ready";

export interface UseThreadList {
	status: Accessor<ThreadListStatus>;
	rows: Accessor<ThreadListRow[]>;
	/** True when the server-side thread list couldn't be fetched (e.g. no
	 *  MSC3856 support): rows then cover only threads this client has seen
	 *  this session, and pagination is unavailable. */
	degraded: Accessor<boolean>;
	hasMore: Accessor<boolean>;
	loadingMore: Accessor<boolean>;
	loadMore: () => void;
}

/** Page size for thread-list backfill, matching Element's panel. */
const PAGE_SIZE = 20;

/** @internal Exported for tests.
 *  One-line snippet for a thread root. Poll roots show their question
 *  (the body of a poll start is a text fallback for non-poll clients and
 *  often stale); redacted and encrypted-but-undecrypted roots get fixed
 *  labels. */
export function rootSnippet(event: MatrixEvent): string {
	if (event.isRedacted?.()) return "Message deleted";
	if (event.isDecryptionFailure?.()) return "Encrypted message";
	const poll = parsePollStart(event);
	if (poll) return poll.question;
	const content = event.getContent?.() ?? {};
	const body = typeof content.body === "string" ? content.body.trim() : "";
	if (body) return body;
	return "Message";
}

/**
 * Reactive room-wide thread list (issue #331), driving the header's
 * Threads panel the way usePinnedEvents drives the pins panel.
 *
 * Source of truth is `room.getThreads()` - the SDK creates a `Thread` for
 * every root it sees, whether it arrived via ambient /sync, the thread-list
 * fetch, or pagination - so one projection covers both the healthy path
 * and the degraded one. The server fetch (`createThreadsTimelineSets` +
 * `fetchRoomThreads`) exists to POPULATE that set with roots this client
 * hasn't seen; it runs lazily on first open per room. When it fails
 * (continuwuity's MSC3856 support is unverified - the issue requires
 * graceful degradation), the list still renders the session's known
 * threads and flags `degraded` so the panel can say so.
 *
 * Rows are sorted by last activity (newest first), matching Element.
 */
export function useThreadList(
	client: MatrixClient,
	roomId: Accessor<string>,
	open: Accessor<boolean>,
): UseThreadList {
	const [status, setStatus] = createSignal<ThreadListStatus>("idle");
	// Store + keyed reconcile (the useTimeline pattern): unchanged rows keep
	// their object identity across rebuilds, so the panel's reference-keyed
	// <For> preserves their DOM. A plain signal of fresh arrays would
	// remount EVERY row button on any live update, dropping keyboard focus
	// to <body> mid-navigation whenever a reply lands anywhere in the room.
	const [rowsStore, setRowsStore] = createStore<ThreadListRow[]>([]);
	const rows: Accessor<ThreadListRow[]> = () => rowsStore;
	const [degraded, setDegraded] = createSignal(false);
	const [hasMore, setHasMore] = createSignal(false);
	const [loadingMore, setLoadingMore] = createSignal(false);

	// Generation guard: bumped on room switch and unmount so in-flight
	// fetches for a previous room can't write into the new one's state.
	let gen = 0;

	function projectRow(room: Room, thread: Thread): ThreadListRow | null {
		const summary = buildThreadSummaryFromThread(
			thread,
			threadUnreadCount(room, thread.id),
		);
		// No replies (all redacted, or a freshly created empty Thread) - the
		// timeline chip hides too; a list row would open an empty panel.
		if (!summary) return null;
		const root = thread.rootEvent;
		if (!root) return null;
		const senderId = root.getSender() ?? "";
		const member = senderId ? room.getMember(senderId) : null;
		return {
			rootId: thread.id,
			senderName: member?.name ?? senderId,
			snippet: rootSnippet(root),
			summary,
			lastActivityTs: summary.latestTs ?? root.getTs(),
		};
	}

	function rebuild(room: Room): void {
		const next: ThreadListRow[] = [];
		for (const thread of room.getThreads()) {
			const row = projectRow(room, thread);
			if (row) next.push(row);
		}
		next.sort((a, b) => b.lastActivityTs - a.lastActivityTs);
		setRowsStore(reconcile(next, { key: "rootId", merge: false }));
	}

	/** Pagination availability: the All-threads list set's backward token.
	 *  Optional chaining throughout - a degraded room never created the
	 *  sets, and mock rooms may lack them entirely. */
	function readHasMore(room: Room): boolean {
		const tl = room.threadsTimelineSets?.[0]?.getLiveTimeline();
		return !!tl && tl.getPaginationToken(Direction.Backward) !== null;
	}

	async function ensureLoaded(room: Room, myGen: number): Promise<void> {
		setStatus("loading");
		// Paint what the client already knows in the same frame (AGENTS.md:
		// no spinner for synchronously available content); the server fetch
		// below only augments the set with roots this client hasn't seen.
		rebuild(room);
		try {
			await room.createThreadsTimelineSets();
			await room.fetchRoomThreads();
			if (myGen !== gen) return;
			setDegraded(false);
			setHasMore(readHasMore(room));
		} catch (e) {
			if (myGen !== gen) return;
			// No userMessage: the panel renders its own degraded notice (the
			// error-handling convention's "own failure surface" case).
			reportError(e, {
				logLabel: `Thread list fetch failed in ${room.roomId}`,
			});
			setDegraded(true);
			setHasMore(false);
		}
		rebuild(room);
		setStatus("ready");
	}

	// Coalesce burst emissions (Update+NewReply fire per incoming reply)
	// into one rebuild per microtask. While the popover is CLOSED, emissions
	// only mark the list stale - the reopen effect rebuilds once - so a busy
	// room doesn't pay a projection+sort per reply for an invisible list.
	let rebuildQueued = false;
	let staleWhileClosed = false;
	function queueRebuild(room: Room): void {
		if (status() === "idle") return;
		if (!open()) {
			staleWhileClosed = true;
			return;
		}
		if (rebuildQueued) return;
		rebuildQueued = true;
		const myGen = gen;
		queueMicrotask(() => {
			rebuildQueued = false;
			if (myGen !== gen) return;
			if (status() !== "idle") rebuild(room);
		});
	}

	// Live updates while the panel has loaded once: same room-level
	// emissions the timeline's thread watcher uses. (Re)subscribed per
	// room; reset drops state so a stale list never shows under a new
	// room's header.
	createEffect(
		on(roomId, (rid, prevRid) => {
			if (prevRid !== undefined) {
				gen++;
				staleWhileClosed = false;
				setStatus("idle");
				setRowsStore(reconcile([], { key: "rootId", merge: false }));
				setDegraded(false);
				setHasMore(false);
				setLoadingMore(false);
			}
			const room = client.getRoom(rid);
			if (!room) return;
			const onThreadChange = (): void => queueRebuild(room);
			// Room-level unread changes (threadId undefined) don't affect any
			// row; only thread-scoped ones re-project (threadWatcher's rule).
			const onUnread = (_counts: unknown, threadId?: string): void => {
				if (threadId) queueRebuild(room);
			};
			room.on(ThreadEvent.Update, onThreadChange);
			room.on(ThreadEvent.NewReply, onThreadChange);
			room.on(ThreadEvent.Delete, onThreadChange);
			room.on(RoomEvent.UnreadNotifications, onUnread);
			onCleanup(() => {
				room.off(ThreadEvent.Update, onThreadChange);
				room.off(ThreadEvent.NewReply, onThreadChange);
				room.off(ThreadEvent.Delete, onThreadChange);
				room.off(RoomEvent.UnreadNotifications, onUnread);
			});
		}),
	);

	// A degraded load retries on the NEXT open: a network blip must not
	// brand the server "can't list threads" for the rest of the session.
	createEffect(
		on(open, (isOpen, wasOpen) => {
			if (wasOpen && !isOpen && degraded()) setStatus("idle");
		}),
	);

	// Lazy load on first open per room (status resets to idle on switch and
	// after a degraded close); reopening a loaded list applies any updates
	// that arrived while it was closed.
	createEffect(() => {
		if (!open()) return;
		const room = client.getRoom(roomId());
		if (!room) return;
		if (status() === "idle") {
			void ensureLoaded(room, gen);
			return;
		}
		if (staleWhileClosed) {
			staleWhileClosed = false;
			rebuild(room);
		}
	});

	onCleanup(() => {
		gen++;
	});

	function loadMore(): void {
		if (loadingMore() || !hasMore() || degraded()) return;
		const room = client.getRoom(roomId());
		const tl = room?.threadsTimelineSets?.[0]?.getLiveTimeline();
		if (!room || !tl) return;
		const myGen = gen;
		setLoadingMore(true);
		client
			.paginateEventTimeline(tl, { backwards: true, limit: PAGE_SIZE })
			.then(() => {
				if (myGen !== gen) return;
				// paginateEventTimeline ran processThreadRoots on the page, so
				// the new roots are in room.getThreads() already.
				rebuild(room);
				setHasMore(readHasMore(room));
			})
			.catch((e: unknown) => {
				if (myGen !== gen) return;
				// Leave hasMore set so the user can retry the button; no
				// userMessage - the button itself is the failure surface.
				reportError(e, {
					logLabel: `Thread list pagination failed in ${room.roomId}`,
				});
			})
			.finally(() => {
				if (myGen === gen) setLoadingMore(false);
			});
	}

	return { status, rows, degraded, hasMore, loadingMore, loadMore };
}
