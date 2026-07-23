import {
	type EventTimelineSet,
	type IRoomEventFilter,
	type ISearchResults,
	type MatrixClient,
	type MatrixEvent,
	type Room,
	RoomStateEvent,
} from "matrix-js-sdk";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { threadJumpTarget } from "../../../lib/threadEvents";

/**
 * Server search returns results across all the user's rooms by default;
 * we restrict via `filter.rooms = [roomId]`. The Matrix spec supports
 * this field on the search filter but matrix-js-sdk's `IRoomEventFilter`
 * type omits it (it lives on `IRoomFilter` in the SDK typings). The
 * server still honors it, so we widen the type locally.
 */
type RoomScopedFilter = IRoomEventFilter & { rooms?: string[] };

export interface SearchHit {
	eventId: string;
	sender: string;
	senderName: string;
	timestamp: number;
	body: string;
	/** Set when the hit is a thread reply: the root whose panel shows it.
	 *  Jumps carry it so the room pane opens the thread panel instead of
	 *  anchoring the main timeline (issue #334). */
	threadRootId?: string;
}

export type SearchStatus = "idle" | "searching" | "results" | "empty" | "error";

export type SearchMode = "server" | "local";

export interface UseRoomSearch {
	query: Accessor<string>;
	setQuery: (q: string) => void;
	submit: (q: string) => void;
	reset: () => void;
	results: Accessor<SearchHit[]>;
	status: Accessor<SearchStatus>;
	mode: Accessor<SearchMode>;
	hasMore: Accessor<boolean>;
	loading: Accessor<boolean>;
	loadMore: () => void;
	error: Accessor<string | null>;
	/** Terms to highlight in snippets (from server highlights or the query). */
	highlights: Accessor<string[]>;
	isEncrypted: Accessor<boolean>;
}

const LOCAL_PAGE_SIZE = 25;
const MAX_QUERY_LEN = 256;

export { MAX_QUERY_LEN };

/** @internal Exported for tests. Splits a query into trimmed lowercase tokens. */
export function splitQueryTokens(q: string): string[] {
	return q
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

/** @internal Exported for tests. True iff `body` contains every token (case-insensitive). */
export function matchesAllTokens(body: string, tokens: string[]): boolean {
	if (tokens.length === 0) return false;
	const haystack = body.toLowerCase();
	return tokens.every((n) => haystack.includes(n));
}

/** @internal Exported for tests. */
export function projectEvent(
	room: Room | null,
	ev: MatrixEvent,
): SearchHit | null {
	const id = ev.getId();
	if (!id) return null;
	if (ev.isRedacted()) return null;
	const content = (ev.getContent?.() ?? {}) as Record<string, unknown>;
	const relates = content["m.relates_to"] as { rel_type?: string } | undefined;
	if (relates?.rel_type === "m.replace") return null;
	// Thread replies aren't part of the main timeline, but they ARE
	// searchable: carry the root id so the jump opens the thread panel
	// instead of the (doomed) main-timeline anchor (issue #334).
	const threadRootId = threadJumpTarget(ev);
	const body = typeof content.body === "string" ? content.body : "";
	if (!body) return null;
	const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
	if (msgtype !== "m.text" && msgtype !== "m.emote" && msgtype !== "m.notice") {
		return null;
	}
	const sender = ev.getSender() ?? "";
	const member = sender && room ? room.getMember(sender) : null;
	return {
		eventId: id,
		sender,
		senderName: member?.name ?? sender,
		timestamp: ev.getTs?.() ?? 0,
		body,
		threadRootId,
	};
}

function collectLocalEvents(room: Room): MatrixEvent[] {
	const out: MatrixEvent[] = [];
	const seen = new Set<string>();
	const collect = (set: EventTimelineSet): void => {
		for (const tl of set.getTimelines()) {
			for (const ev of tl.getEvents()) {
				if (ev.getType() !== "m.room.message") continue;
				const id = ev.getId();
				if (!id || seen.has(id)) continue;
				seen.add(id);
				out.push(ev);
			}
		}
	};
	collect(room.getUnfilteredTimelineSet());
	// Cached thread replies are searchable too (their hits carry
	// threadRootId, so a jump opens the panel). Only threads the SDK has
	// materialized are covered - consistent with local mode's "messages
	// already loaded in this client" caveat. The `seen` set dedupes thread
	// roots, which the SDK dual-homes into both timelines.
	for (const thread of room.getThreads()) {
		collect(thread.timelineSet);
	}
	return out;
}

export function useRoomSearch(
	client: MatrixClient,
	roomId: Accessor<string>,
): UseRoomSearch {
	const [query, setQuery] = createSignal("");
	const [results, setResults] = createSignal<SearchHit[]>([]);
	const [status, setStatus] = createSignal<SearchStatus>("idle");
	const [mode, setMode] = createSignal<SearchMode>("server");
	const [hasMore, setHasMore] = createSignal(false);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [highlights, setHighlights] = createSignal<string[]>([]);

	let gen = 0;
	// Server mode: owned ISearchResults object that backPaginate mutates.
	let serverResults: ISearchResults | null = null;
	// Local mode: pre-collected match array + cursor.
	let localAll: SearchHit[] = [];
	let localCursor = 0;

	const room = createMemo<Room | null>(() => client.getRoom(roomId()) ?? null);

	// Encryption state can be enabled mid-session; track room state events so
	// the search mode (server vs local) re-evaluates without a remount.
	const [stateTick, setStateTick] = createSignal(0);
	createEffect(() => {
		const r = room();
		if (!r) return;
		const onState = (ev: MatrixEvent) => {
			if (ev.getRoomId() !== r.roomId) return;
			if (ev.getType() !== "m.room.encryption") return;
			setStateTick((n) => n + 1);
		};
		client.on(RoomStateEvent.Events, onState);
		onCleanup(() => {
			client.off(RoomStateEvent.Events, onState);
		});
	});

	const isEncrypted = createMemo<boolean>(() => {
		stateTick();
		const r = room();
		return r ? r.hasEncryptionStateEvent() : false;
	});

	const reset = (): void => {
		gen += 1;
		serverResults = null;
		localAll = [];
		localCursor = 0;
		setQuery("");
		setResults([]);
		setStatus("idle");
		setHasMore(false);
		setLoading(false);
		setError(null);
		setHighlights([]);
		setMode(isEncrypted() ? "local" : "server");
	};

	// Reset when the active room changes (component reuse across rid).
	createEffect(
		on(
			roomId,
			() => {
				reset();
			},
			{ defer: true },
		),
	);

	onCleanup(() => {
		gen += 1; // invalidate any in-flight on unmount
	});

	const runLocal = (q: string, myGen: number): void => {
		const r = room();
		if (!r) {
			setStatus("error");
			setError("Room not available");
			setLoading(false);
			return;
		}
		const events = collectLocalEvents(r);
		const needles = splitQueryTokens(q);
		const hits: SearchHit[] = [];
		for (let i = events.length - 1; i >= 0; i--) {
			const proj = projectEvent(r, events[i]);
			if (!proj) continue;
			if (matchesAllTokens(proj.body, needles)) hits.push(proj);
		}
		// collectLocalEvents concatenates the main set's timelines and then
		// each thread's, so reverse iteration alone no longer yields
		// newest-first. Stable-sort by timestamp to interleave them.
		hits.sort((a, b) => b.timestamp - a.timestamp);
		if (myGen !== gen) return;
		localAll = hits;
		localCursor = Math.min(LOCAL_PAGE_SIZE, hits.length);
		setMode("local");
		setHighlights(Array.from(new Set(needles)));
		setResults(hits.slice(0, localCursor));
		setHasMore(localCursor < hits.length);
		setStatus(hits.length === 0 ? "empty" : "results");
		setLoading(false);
	};

	const projectServerResults = (sr: ISearchResults): SearchHit[] => {
		const r = room();
		const hits: SearchHit[] = [];
		const seen = new Set<string>();
		for (const item of sr.results) {
			const ev = item.context.getEvent();
			const proj = projectEvent(r, ev);
			if (!proj) continue;
			if (seen.has(proj.eventId)) continue;
			seen.add(proj.eventId);
			hits.push(proj);
		}
		return hits;
	};

	const runServer = async (q: string, myGen: number): Promise<void> => {
		const filter: RoomScopedFilter = { rooms: [roomId()] };
		try {
			const sr = await client.searchRoomEvents({
				term: q,
				filter: filter as IRoomEventFilter,
			});
			if (myGen !== gen) return;
			serverResults = sr;
			setMode("server");
			setHighlights(
				sr.highlights.length > 0
					? Array.from(new Set(sr.highlights))
					: Array.from(new Set(splitQueryTokens(q))),
			);
			const hits = projectServerResults(sr);
			setResults(hits);
			setHasMore(Boolean(sr.next_batch));
			setStatus(hits.length === 0 && !sr.next_batch ? "empty" : "results");
		} catch (e) {
			if (myGen !== gen) return;
			console.error("Room search failed:", e);
			// Server search may not be implemented (e.g. Conduwuity) — fall
			// back to a local scan of cached events.
			runLocal(q, myGen);
			return;
		} finally {
			if (myGen === gen) setLoading(false);
		}
	};

	const submit = (raw: string): void => {
		const q = raw.trim().slice(0, MAX_QUERY_LEN);
		if (q.length === 0) {
			reset();
			return;
		}
		gen += 1;
		const myGen = gen;
		serverResults = null;
		localAll = [];
		localCursor = 0;
		setQuery(q);
		setResults([]);
		setError(null);
		setHighlights([]);
		setHasMore(false);
		setLoading(true);
		setStatus("searching");
		const encrypted = isEncrypted();
		setMode(encrypted ? "local" : "server");
		if (encrypted) {
			// Server doesn't index encrypted bodies; go straight to local.
			runLocal(q, myGen);
		} else {
			void runServer(q, myGen);
		}
	};

	const loadMore = (): void => {
		if (loading() || !hasMore()) return;
		const myGen = gen;
		if (mode() === "local") {
			const next = Math.min(localCursor + LOCAL_PAGE_SIZE, localAll.length);
			localCursor = next;
			setResults(localAll.slice(0, next));
			setHasMore(next < localAll.length);
			return;
		}
		const sr = serverResults;
		if (!sr?.next_batch) return;
		setLoading(true);
		client
			.backPaginateRoomEventsSearch(sr)
			.then((updated) => {
				if (myGen !== gen || serverResults !== sr) return;
				serverResults = updated;
				setResults(projectServerResults(updated));
				setHasMore(Boolean(updated.next_batch));
			})
			.catch((e) => {
				if (myGen !== gen) return;
				console.error("Room search paginate failed:", e);
				setError("Failed to load more results");
				setHasMore(false);
			})
			.finally(() => {
				if (myGen === gen) setLoading(false);
			});
	};

	return {
		query,
		setQuery,
		submit,
		reset,
		results,
		status,
		mode,
		hasMore,
		loading,
		loadMore,
		error,
		highlights,
		isEncrypted,
	};
}
