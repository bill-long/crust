import type { ISearchResults, MatrixClient, Room } from "matrix-js-sdk";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import { projectEvent } from "../../client/searchProjection";
import {
	MAX_QUERY_LEN,
	matchesAllTokens,
	type SearchHit,
	splitQueryTokens,
} from "../../lib/searchHit";

/** A hit plus the room it came from, which global results are grouped by. */
export interface GlobalSearchHit extends SearchHit {
	roomId: string;
}

/** One room's worth of results, newest first. */
export interface RoomHitGroup {
	roomId: string;
	/** The hits on the current page. */
	hits: GlobalSearchHit[];
	/**
	 * Hits for this room across the whole result set.
	 *
	 * Not `hits.length`: the page is a window, so a room with 30 matches
	 * would head its section "20" directly under a status line reading "30
	 * results in 1 room" - two counts for the same set, disagreeing.
	 */
	total: number;
}

export type GlobalSearchStatus =
	| "idle"
	| "searching"
	| "results"
	| "empty"
	| "error";

/**
 * Where the results came from, which decides what the panel promises.
 *
 * `server` is the homeserver's index: everything it can read, which excludes
 * encrypted rooms entirely. `local` is a scan of what this client already has
 * in memory. The distinction is surfaced rather than hidden, because the two
 * cover genuinely different sets and a user who searches for something they
 * remember sending needs to know which one answered.
 */
export type GlobalSearchMode = "server" | "local";

export interface UseGlobalSearch {
	query: Accessor<string>;
	/** Increments on every submit, including a repeat of the same text. */
	submissions: Accessor<number>;
	submit: (q: string) => void;
	reset: () => void;
	groups: Accessor<RoomHitGroup[]>;
	total: Accessor<number>;
	/** Rooms across the whole result set - `groups()` only holds the page. */
	totalRooms: Accessor<number>;
	status: Accessor<GlobalSearchStatus>;
	mode: Accessor<GlobalSearchMode>;
	hasMore: Accessor<boolean>;
	/** Whether an earlier page exists. The window is one page wide, so
	 *  stepping forward has to be reversible. */
	hasPrevious: Accessor<boolean>;
	loadPrevious: () => void;
	loading: Accessor<boolean>;
	loadMore: () => void;
	error: Accessor<string | null>;
	highlights: Accessor<string[]>;
	/**
	 * Encrypted rooms the server could not read, which were scanned locally
	 * instead. Their results are merged in, so this is a statement about
	 * *depth* - local history only - not about anything being missing.
	 */
	locallyCovered: Accessor<number>;
	/** Encrypted rooms the scan was offered, whether or not it reached them. */
	encryptedRoomCount: Accessor<number>;
	/**
	 * Whether the local scan stopped at its ceiling rather than reaching the
	 * end. A truncated scan must not read as an exhaustive one, and there is
	 * no "load more" that would continue it.
	 */
	scanTruncated: Accessor<boolean>;
	/**
	 * Whether the server was found not to implement `/search` at all, as
	 * opposed to one request having failed. Only the first tells the user
	 * not to bother retrying.
	 */
	serverUnsupported: Accessor<boolean>;
	/**
	 * Whether the *server* is holding more results, as opposed to this client
	 * merely having more of the counted hits to page through.
	 *
	 * `hasMore` conflates the two: it is true whenever the window has
	 * anything behind it, including hits the encrypted-room scan supplied.
	 * Only this one may qualify a count as partial.
	 */
	moreOnServer: Accessor<boolean>;
}

/**
 * Hits rendered at once, in either mode.
 *
 * Small enough that the list never needs virtualizing: worst case is one
 * room per hit, so 20 hits is 40 rows. That is deliberate - a virtualized
 * list has to move focus to rows that are not mounted, and every attempt to
 * do that here ran into another of virtua's asynchronous stages (scheduled
 * scrolling, deferred measurement, `visibility: hidden` until measured).
 * Paging costs a click; virtualizing cost a keyboard trap.
 */
const PAGE_SIZE = 20;

/**
 * How many messages the local scan will look at, across all rooms.
 *
 * A local scan walks cached timelines synchronously, and on a homeserver
 * without `/search` it is the path every search takes. It does not run in
 * the submit handler - it is reached after an awaited rejection, or after an
 * awaited server answer - so it does not block the keystroke, but it does
 * occupy a task, and a long one is a dropped frame either way.
 *
 * This is a count, not a time bound, and it would be dishonest to call it
 * one: 5,000 events cost what 5,000 `getContent()` and `toLowerCase()` calls
 * cost on the machine in question. It is a ceiling low enough that the worst
 * case stays in the low milliseconds on a warm client, paired with testing
 * the body before projecting the event so a non-match costs a substring
 * check rather than a member lookup and an allocation. If it ever needs to
 * cover more, the answer is chunking across tasks, not a bigger number.
 *
 * The panel says when the ceiling was reached rather than presenting a
 * truncated scan as a complete one.
 */
const LOCAL_SCAN_CEILING = 5_000;

/**
 * Whether a `/search` rejection means the server has no search at all, as
 * opposed to this one request having failed.
 *
 * Conduwuity does not implement the endpoint; a server that never did
 * answers `M_UNRECOGNIZED`. Both are permanent for the session, and worth
 * remembering so every later query does not spend a round trip rediscovering
 * it. Everything else - timeouts, 5xx, rate limits - is transient.
 */
function meansSearchUnsupported(e: unknown): boolean {
	// An errcode, not a bare status. A 404 with no Matrix error body is a
	// proxy or an ingress mid-restart, not evidence about the endpoint - and
	// because this answer is latched for the session, one unlucky query in
	// that window would downgrade every later search to local history until
	// the page was reloaded. A server that genuinely lacks the endpoint says
	// so in the body.
	const err = e as { errcode?: unknown } | null;
	return err?.errcode === "M_UNRECOGNIZED" || err?.errcode === "M_NOT_FOUND";
}

/**
 * The client whose homeserver was found not to implement `/search`.
 *
 * Module-level rather than per-hook, and keyed by client rather than a bare
 * boolean. `GlobalSearchPane` lives inside `Layout`, which remounts on a
 * route-shape change (`/home` to `/space` to `/dm`), so a hook-local latch
 * lasted until the user switched space - and on the one homeserver the
 * fallback exists for, every switch then cost another failing round trip
 * before the local scan started. Keying on the client makes it reset on
 * logout and login, where the server may genuinely differ.
 */
let searchUnsupportedClient: MatrixClient | null = null;

function roomsNewestFirst(client: MatrixClient): Room[] {
	return (
		client
			.getRooms()
			.filter((r) => r.getMyMembership() === "join")
			// Spaces are joined rooms too, and their timelines are almost
			// entirely `m.space.child` and membership state - which can never
			// match, but is counted against the scan ceiling all the same, so a
			// user with thirty spaces spends the budget on rooms that cannot
			// answer. A stray message in one would also produce a hit whose jump
			// renders a room view for a space.
			.filter((r) => !r.isSpaceRoom())
			.sort(
				(a, b) =>
					(b.getLastActiveTimestamp?.() ?? 0) -
					(a.getLastActiveTimestamp?.() ?? 0),
			)
	);
}

/** @internal Exported for tests. Groups hits by room, preserving hit order. */
export function groupByRoom(hits: GlobalSearchHit[]): RoomHitGroup[] {
	const byRoom = new Map<string, GlobalSearchHit[]>();
	for (const hit of hits) {
		const list = byRoom.get(hit.roomId);
		if (list) list.push(hit);
		else byRoom.set(hit.roomId, [hit]);
	}
	// Map preserves insertion order, and hits arrive newest-first, so the
	// room whose newest hit is newest comes first - the order a reader
	// scanning for "where did I see that" expects.
	// `total` defaults to the page count; `publish` overrides it with the
	// count across the whole result set.
	return Array.from(byRoom, ([roomId, roomHits]) => ({
		roomId,
		hits: roomHits,
		total: roomHits.length,
	}));
}

/**
 * Search every joined room.
 *
 * Server-first with a local fallback, the same shape the per-room panel
 * uses and for the same reason: `/search` is optional in the spec and
 * Conduwuity does not implement it, so a client that only knows how to ask
 * the server has no search at all on this project's own homeserver.
 *
 * Encrypted rooms are the wrinkle that per-room search does not have. There
 * the panel knows the one room's state and picks a mode; here the set is
 * mixed, and a server answer silently omits every encrypted room. Rather
 * than quietly returning a partial answer, the count of skipped rooms is
 * reported so the panel can say so.
 */
export function useGlobalSearch(client: MatrixClient): UseGlobalSearch {
	const [query, setQuery] = createSignal("");
	const [groups, setGroups] = createSignal<RoomHitGroup[]>([]);
	// How many hits are known, which is not how many are on screen: local
	// mode pages through its results, so the count has to come from the full
	// set or it announces the page size as the answer.
	const [total, setTotalKnown] = createSignal(0);
	const [totalRooms, setTotalRooms] = createSignal(0);
	const [hasPrevious, setHasPrevious] = createSignal(false);
	const [status, setStatus] = createSignal<GlobalSearchStatus>("idle");
	const [mode, setMode] = createSignal<GlobalSearchMode>("server");
	const [hasMore, setHasMore] = createSignal(false);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [highlights, setHighlights] = createSignal<string[]>([]);
	const [locallyCovered, setLocallyCovered] = createSignal(0);
	const [encryptedRoomCount, setEncryptedRoomCount] = createSignal(0);
	const [scanTruncated, setScanTruncated] = createSignal(false);
	const [serverUnsupported, setServerUnsupported] = createSignal(
		searchUnsupportedClient === client,
	);
	const [moreOnServer, setMoreOnServer] = createSignal(false);
	// Bumped by every submit. `query` cannot serve this: a Solid signal does
	// not notify when the value is unchanged, so re-running the same search
	// left anything keyed on it - the panel's rescue disarm, its focus reset
	// - silently not running.
	const [submissions, setSubmissions] = createSignal(0);

	// Monotonic generation: every submit invalidates whatever is in flight,
	// so a slow first query cannot overwrite a fast second one.
	let gen = 0;
	let serverResults: ISearchResults | null = null;
	// Every hit known so far, and where the rendered window starts. The
	// window is exactly one page wide - it does not grow - which is what
	// lets this list skip virtualization: an accumulating cursor would put
	// 240 rows on screen after five pages, past the bar AGENTS.md sets, and
	// re-sanitize every one of them on each publish.
	let allHits: GlobalSearchHit[] = [];
	let pageStart = 0;
	let encryptedHits: GlobalSearchHit[] = [];

	onCleanup(() => {
		gen += 1;
	});

	const publish = (hits: GlobalSearchHit[]): void => {
		const totals = new Map<string, number>();
		for (const hit of allHits) {
			totals.set(hit.roomId, (totals.get(hit.roomId) ?? 0) + 1);
		}
		setGroups(
			groupByRoom(hits).map((group) => ({
				...group,
				total: totals.get(group.roomId) ?? group.hits.length,
			})),
		);
	};

	/** Render exactly the current page's worth of `hits`. */
	const publishPage = (hits: GlobalSearchHit[]): void => {
		publish(hits.slice(pageStart, pageStart + PAGE_SIZE));
	};

	/** Rooms across the whole result set, not just the page on screen. */
	const setTotals = (all: GlobalSearchHit[]): void => {
		setTotalKnown(all.length);
		setTotalRooms(new Set(all.map((h) => h.roomId)).size);
	};

	/**
	 * Server hits plus the locally-scanned encrypted ones, newest first.
	 *
	 * Recomputed on every page rather than appended to, because a later page
	 * can carry hits older than the local ones already merged in.
	 */
	const mergeServer = (serverHits: GlobalSearchHit[]): GlobalSearchHit[] => {
		if (encryptedHits.length === 0) return serverHits;
		const seen = new Set(serverHits.map((h) => h.eventId));
		const merged = serverHits.concat(
			encryptedHits.filter((h) => !seen.has(h.eventId)),
		);
		merged.sort((a, b) => b.timestamp - a.timestamp);
		return merged;
	};

	const projectServerResults = (sr: ISearchResults): GlobalSearchHit[] => {
		const hits: GlobalSearchHit[] = [];
		const seen = new Set<string>();
		for (const item of sr.results) {
			const ev = item.context.getEvent();
			const roomId = ev.getRoomId();
			if (!roomId) continue;
			const room = client.getRoom(roomId);
			// The same gate the local scan applies. `/search` with no room
			// filter covers rooms we have *left* - history visibility
			// permits it - and a hit in one navigates to a room whose pane
			// mounts with an unusable timeline and composer. Spaces are
			// excluded for the reason the local filter gives: a stray
			// message in one would render a room view for a space.
			if (!room) continue;
			if (room.getMyMembership() !== "join") continue;
			if (room.isSpaceRoom()) continue;
			const proj = projectEvent(room, ev);
			if (!proj) continue;
			if (seen.has(proj.eventId)) continue;
			seen.add(proj.eventId);
			hits.push({ ...proj, roomId });
		}
		return hits;
	};

	const runLocal = (q: string, myGen: number): void => {
		try {
			runLocalUnguarded(q, myGen);
		} catch (e) {
			if (myGen !== gen) return;
			// This is the fallback: if it throws, there is nothing behind it.
			// Without this the status would sit at "searching" forever, since
			// only `loading` is cleared by the caller's finally.
			console.error("Local search scan failed:", e);
			allHits = [];
			pageStart = 0;
			publish([]);
			setTotals([]);
			setHighlights([]);
			// `mode` too, and it is the one that matters: the local-mode
			// branch of `coverageNote` never reads the other three, so a
			// local query following a local one still rendered "Server
			// search is unavailable. Showing matches from messages already
			// loaded" over an empty list beside "Search failed." On a server
			// without /search that is the normal path, not an edge case.
			setMode("server");
			setLocallyCovered(0);
			setEncryptedRoomCount(0);
			setScanTruncated(false);
			setStatus("error");
			setError("Search failed.");
			setLoading(false);
		}
	};

	/**
	 * Walk cached timelines and collect matches.
	 *
	 * Takes the rooms to walk rather than reading them itself, because this
	 * serves two callers: the whole-account fallback, and the encrypted-only
	 * pass that fills the hole in a server answer.
	 */
	const scanRooms = (
		q: string,
		rooms: Room[],
	): {
		hits: GlobalSearchHit[];
		truncated: boolean;
		roomsWalked: number;
		roomsOffered: number;
	} => {
		const needles = splitQueryTokens(q);
		const hits: GlobalSearchHit[] = [];
		let examined = 0;
		let truncated = false;

		const seen = new Set<string>();
		// Rooms actually walked, which is not `rooms.length`: the ceiling is
		// shared across all of them, so a single room with a deep cache can
		// exhaust it before the second is touched.
		let roomsWalked = 0;
		outer: for (const room of rooms) {
			// Budget checked on entry, and the room counted only if it had
			// some. A room reached with nothing left was never searched and
			// must not be reported as covered - while a room with an empty
			// cache genuinely was searched, and would be missed by counting
			// examined events instead.
			if (examined >= LOCAL_SCAN_CEILING) {
				truncated = true;
				break;
			}
			roomsWalked++;
			const roomId = room.roomId;
			// Thread replies as well as the main timeline. The SDK keeps
			// replies out of the unfiltered set, so walking only that set
			// would make a thread reply unfindable - and since Conduwuity
			// does not implement /search, this scan is the only mode users
			// on this project's own homeserver ever get. The per-room panel
			// walks `getThreads()` for the same reason.
			const sets = [
				room.getUnfilteredTimelineSet(),
				...room.getThreads().map((t) => t.timelineSet),
			];
			for (const set of sets) {
				for (const timeline of set.getTimelines()) {
					for (const ev of timeline.getEvents()) {
						// Counted before the type test, not after: the ceiling
						// is there to bound the walk, and a room whose cache is
						// mostly state events would otherwise cost the whole
						// scan while never advancing the count.
						if (examined >= LOCAL_SCAN_CEILING) {
							truncated = true;
							break outer;
						}
						examined++;
						if (ev.getType() !== "m.room.message") continue;
						// Cheap test first. `projectEvent` allocates a hit and
						// does a member lookup, and the overwhelming majority
						// of events do not match - paying that for each of
						// them is what put this over the handler budget.
						const raw = ev.getContent?.()?.body;
						if (typeof raw !== "string") continue;
						if (!matchesAllTokens(raw, needles)) continue;
						const proj = projectEvent(room, ev);
						if (!proj) continue;
						// The SDK dual-homes a thread root into both the main
						// set and the thread's own, so without this the root
						// of every matching thread would appear twice.
						if (seen.has(proj.eventId)) continue;
						seen.add(proj.eventId);
						hits.push({ ...proj, roomId });
					}
				}
			}
		}

		hits.sort((a, b) => b.timestamp - a.timestamp);
		// Rooms *reached*, including the one the ceiling stopped inside.
		// Excluding it read worse than including it: stopping partway
		// through the first room reported "0 of 40" while that room's hits
		// were on screen. The note says "reached", which is true of a
		// partial room, and `truncated` carries the incompleteness.
		return {
			hits,
			truncated,
			roomsWalked,
			roomsOffered: rooms.length,
		};
	};

	const runLocalUnguarded = (q: string, myGen: number): void => {
		const { hits, truncated } = scanRooms(q, roomsNewestFirst(client));
		if (myGen !== gen) return;
		allHits = hits;
		pageStart = 0;
		setMode("local");
		// A local scan reads every room this client has cached, encrypted
		// ones included - so nothing was skipped for being encrypted, whether
		// or not the scan hit its ceiling.
		setLocallyCovered(0);
		setEncryptedRoomCount(0);
		setHighlights(Array.from(new Set(splitQueryTokens(q))));
		setTotals(hits);
		publishPage(hits);
		setScanTruncated(truncated);
		// Truncation is deliberately NOT `hasMore`. There is nothing further
		// to hand out - `loadMore` would page through what was already found
		// and stop - so folding it in here would offer a control that cannot
		// do what it says. The panel discloses it instead.
		// A local scan found everything it is going to find.
		setMoreOnServer(false);
		setHasMore(PAGE_SIZE < hits.length);
		setStatus(hits.length === 0 ? "empty" : "results");
		setLoading(false);
	};

	const runServer = async (q: string, myGen: number): Promise<void> => {
		// Once rejected, do not ask again this session. Conduwuity does not
		// implement /search, and re-asking spends a round trip per query on
		// a request whose answer is already known.
		if (searchUnsupportedClient === client) {
			// A real task, not a microtask. An async function runs
			// synchronously up to its first await, and this branch is taken
			// by every search after the first on a server without /search -
			// so the scan has to leave the keystroke's frame entirely.
			// `await Promise.resolve()` does not do that: microtasks drain at
			// the end of the current task, before the browser can paint, so
			// the walk still delayed the same frame and only stopped being
			// lexically inside `submit`. AGENTS.md's budget is about the
			// frame.
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (myGen !== gen) return;
			runLocal(q, myGen);
			setLoading(false);
			return;
		}
		let sr: ISearchResults;
		try {
			// Only the request is guarded. Everything after it succeeded is
			// outside the catch: a throw from the local encrypted scan would
			// otherwise be read as "this server has no /search", discarding
			// an answer that had already arrived and downgrading the whole
			// session to local mode with its caveat banner.
			//
			// No filter: `searchRoomEvents` with the room filter omitted is
			// the whole-account search, and it returns the same processed
			// shape the per-room panel already knows how to project.
			sr = await client.searchRoomEvents({ term: q });
		} catch (e) {
			if (myGen !== gen) return;
			console.error("Global search failed:", e);
			// Latch only for "this server does not do search". A timeout or a
			// 5xx is transient, and treating it as permanent would downgrade
			// the whole session to local scanning on one bad request - the
			// same distinction the presence publisher draws before it
			// contradicts its own optimistic write.
			const unsupported = meansSearchUnsupported(e);
			if (unsupported) searchUnsupportedClient = client;
			setServerUnsupported(unsupported);
			// The server may not implement /search at all (Conduwuity), in
			// which case falling back is the difference between having the
			// feature and not.
			runLocal(q, myGen);
			setLoading(false);
			return;
		}
		try {
			if (myGen !== gen) return;
			serverResults = sr;
			setMode("server");
			setHighlights(
				sr.highlights.length > 0
					? Array.from(new Set(sr.highlights))
					: Array.from(new Set(splitQueryTokens(q))),
			);
			// The server index cannot read encrypted rooms, so a server answer
			// has a hole in it exactly where a user's private conversations
			// are. Counting the hole is not enough: the per-room panel finds
			// that text by scanning locally, so global search would be
			// strictly worse than per-room search for the same query. Scan
			// those rooms here and merge, and report them as locally covered
			// rather than as skipped.
			//
			// `hasEncryptionStateEvent`, not `client.isRoomEncrypted`: the
			// latter is deprecated and documented as not correctly supported
			// under the Rust crypto stack, which is the one Crust uses.
			const encrypted = roomsNewestFirst(client).filter((r) =>
				r.hasEncryptionStateEvent(),
			);
			// Guarded on its own. This scan enhances an answer the server has
			// already given, so a single malformed room must degrade to
			// "server results without the encrypted ones" rather than turn a
			// complete result set into a blanket failure.
			let local: ReturnType<typeof scanRooms>;
			try {
				local = scanRooms(q, encrypted);
			} catch (e) {
				console.error("Encrypted-room scan failed:", e);
				// `truncated: true`, not false. With zero rooms walked and
				// nothing truncated, `coverageNote` falls through every
				// branch and returns null - so every encrypted room would be
				// skipped entirely and the panel would say nothing at all,
				// which is exactly the silence this feature exists to avoid.
				local = {
					hits: [],
					truncated: true,
					roomsWalked: 0,
					roomsOffered: encrypted.length,
				};
			}
			if (myGen !== gen) return;
			encryptedHits = local.hits;
			// What was covered, not what was selected: the ceiling is shared
			// across rooms, so claiming 40 when it stopped inside the first
			// is the same lie the note exists to prevent.
			setLocallyCovered(local.roomsWalked);
			// The rooms it never opened matter more than the ones it did: a
			// ceiling that trips in room 3 of 40 leaves 37 untouched, and a
			// note reporting only "2 searched" reads as though 2 was the
			// whole set.
			setEncryptedRoomCount(local.roomsOffered);
			setScanTruncated(local.truncated);
			const hits = mergeServer(projectServerResults(sr));
			allHits = hits;
			pageStart = 0;
			setTotals(hits);
			publishPage(hits);
			setMoreOnServer(Boolean(sr.next_batch));
			setHasMore(PAGE_SIZE < hits.length || Boolean(sr.next_batch));
			// Empty is about what we have, not about whether more exists. A
			// server can return a `next_batch` whose page projects to nothing
			// - every result an image, a redaction or an edit - and calling
			// that "results" renders "0 results in 0 rooms so far, more
			// available" over an empty list, with the honest empty state
			// unreachable on such a server.
			setStatus(hits.length === 0 ? "empty" : "results");
		} catch (e) {
			if (myGen !== gen) return;
			// The server answered; something after it failed. That is an
			// error, not a reason to claim the server has no search.
			console.error("Global search post-processing failed:", e);
			// Retaining the previous answer is for the wait, not for a
			// failure: leaving it up under "Search failed." shows one
			// query's rows marked up with another query's terms.
			allHits = [];
			pageStart = 0;
			publish([]);
			setTotals([]);
			setHighlights([]);
			// The coverage numbers may already have been written a few lines
			// above, and they describe a result set that no longer exists -
			// "3 encrypted rooms were searched from local history only" over
			// zero rows, beside "Search failed."
			setLocallyCovered(0);
			setEncryptedRoomCount(0);
			setScanTruncated(false);
			setStatus("error");
			setError("Search failed.");
		} finally {
			if (myGen === gen) setLoading(false);
		}
	};

	const reset = (): void => {
		gen += 1;
		serverResults = null;
		allHits = [];
		pageStart = 0;
		encryptedHits = [];
		setQuery("");
		setGroups([]);
		setTotalKnown(0);
		setTotalRooms(0);
		setStatus("idle");
		setHasMore(false);
		setHasPrevious(false);
		setMoreOnServer(false);
		setLoading(false);
		setError(null);
		setHighlights([]);
		setLocallyCovered(0);
		setEncryptedRoomCount(0);
		setScanTruncated(false);
		// `mode` too. `serverUnsupported` is latched for the session, so a
		// cleared search that had fallen back left "Server search is
		// unavailable" pinned in the pane's live region - visible between
		// the field and the room list, and announced again on every clear.
		setMode("server");
	};

	const submit = (raw: string): void => {
		const q = raw.trim().slice(0, MAX_QUERY_LEN);
		if (q.length === 0) {
			reset();
			return;
		}
		gen += 1;
		const myGen = gen;
		setSubmissions((n) => n + 1);
		serverResults = null;
		allHits = [];
		pageStart = 0;
		encryptedHits = [];
		setQuery(q);
		// `groups` and its counters are deliberately NOT cleared here. Every
		// path that finishes a search replaces them, and clearing up front
		// emptied the panel for the whole round trip - so refining a query
		// left the sidebar blank but for "Searching...", which is the exact
		// failure the pane's latch exists to avoid. The previous answer
		// stays on screen until the new one is ready.
		setError(null);
		// `highlights` is kept for the same reason `groups` is: the retained
		// results are still on screen, and clearing the terms strips their
		// marks and re-centres every snippet on the start of the message -
		// the exact reflow that retaining them exists to avoid. Every path
		// that finishes a search sets them.
		setHasMore(false);
		setHasPrevious(false);
		setMoreOnServer(false);
		// `mode` and the coverage numbers are kept, like `groups` and
		// `highlights`: they describe the answer still on screen. Clearing
		// them here was right when a search blanked the panel, and became
		// wrong when it stopped doing that - on a server without /search it
		// left the previous local-scan results rendered with "Server search
		// is unavailable" removed, which presents them as a complete server
		// answer. Every finishing path sets all four.
		setLoading(true);
		setStatus("searching");
		void runServer(q, myGen);
	};

	const loadPrevious = (): void => {
		if (pageStart === 0) return;
		pageStart = Math.max(0, pageStart - PAGE_SIZE);
		setError(null);
		// Flags before rows - see the note in `loadMore`.
		setHasPrevious(pageStart > 0);
		setHasMore(
			pageStart + PAGE_SIZE < allHits.length ||
				Boolean(serverResults?.next_batch),
		);
		publishPage(allHits);
	};

	const loadMore = (): void => {
		if (loading() || !hasMore()) return;
		const myGen = gen;
		// Move the window over what has already arrived before asking for
		// more.
		if (pageStart + PAGE_SIZE < allHits.length) {
			pageStart += PAGE_SIZE;
			// A failure belongs to the page it happened on. Left set, it
			// replaced the result count for the rest of the search, even
			// after paging back to one that had loaded fine.
			setError(null);
			// Flags before rows. Solid flushes each write's effects
			// synchronously, and the panel's focus rescue runs on the rows
			// changing - so publishing first meant it ran while the button
			// was still mounted and enabled, stood down, and was disarmed
			// just before the next write removed the button under the
			// user's focus.
			setHasMore(
				pageStart + PAGE_SIZE < allHits.length ||
					Boolean(serverResults?.next_batch),
			);
			setHasPrevious(pageStart > 0);
			publishPage(allHits);
			return;
		}
		const sr = serverResults;
		if (!sr?.next_batch) return;
		setLoading(true);
		client
			.backPaginateRoomEventsSearch(sr)
			.then((updated) => {
				// `serverResults !== sr` as well as the generation: a second
				// page can land after a new query replaced the result set.
				if (myGen !== gen || serverResults !== sr) return;
				serverResults = updated;
				// The SDK merges each page's highlights into the same object,
				// so a term the stemmer only returned on page 2 would
				// otherwise never be marked in the rows that page added.
				if (updated.highlights.length > 0) {
					setHighlights(Array.from(new Set(updated.highlights)));
				}
				// One page forward, page-aligned - not anchored on a hit.
				//
				// Anchoring was an attempt to resume exactly after the last
				// row shown, and it cannot work here: `mergeServer` re-sorts
				// the whole set by timestamp, so a hit from the new server
				// page can sort *before* the anchor. Those hits then sat in a
				// region the window had already passed - counted in the total
				// but unreachable by paging forward. Aligned windows have no
				// such region: every hit belongs to exactly one page, and
				// both directions step whole pages.
				const merged = mergeServer(projectServerResults(updated));
				// Advance only if the page was already full *before* this
				// fetch. The server branch is reached when the current page is
				// partial, so the arriving hits finish filling it - and
				// stepping past them leaves the rows that filled it counted
				// but never shown. Comparing against the merged length was
				// the same mistake one step along: a fetch that both fills
				// the page and spills past it still skipped what filled it.
				const pageWasFull = allHits.length >= pageStart + PAGE_SIZE;
				allHits = merged;
				if (pageWasFull) pageStart += PAGE_SIZE;
				// A re-projection can come back *smaller* - a room left
				// between pages drops out - which can leave the window past
				// the end, publishing an empty page under a "results" status
				// with no listbox, no empty state and no note. Snap to the
				// last whole page.
				if (pageStart >= merged.length) {
					pageStart = Math.max(
						0,
						(Math.ceil(merged.length / PAGE_SIZE) - 1) * PAGE_SIZE,
					);
				}
				setTotals(merged);
				publishPage(merged);
				setHasPrevious(pageStart > 0);
				setError(null);
				// The first page can project to nothing while the server still
				// offers more; without this the list fills up underneath "No
				// messages found."
				setStatus(merged.length === 0 ? "empty" : "results");
				setMoreOnServer(Boolean(updated.next_batch));
				setHasMore(
					pageStart + PAGE_SIZE < merged.length || Boolean(updated.next_batch),
				);
			})
			.catch((e) => {
				if (myGen !== gen) return;
				console.error("Global search pagination failed:", e);
				// `hasMore` is left alone. Clearing it unmounted the button,
				// so one dropped request ended paging for the whole query
				// with no way back - and `next_batch` is still valid, so the
				// press that failed can simply be repeated.
				setError("Couldn't load more results.");
				// Republish the same page. Nothing else changes `groups` on
				// this path, and the panel's focus rescue is keyed on the
				// rows changing - so without this a keyboard user whose page
				// failed is left on <body>, with the rescue still armed to
				// fire on some later unrelated publish.
				publishPage(allHits);
			})
			.finally(() => {
				if (myGen === gen) setLoading(false);
			});
	};

	return {
		query,
		submissions,
		submit,
		reset,
		groups,
		total,
		totalRooms,
		status,
		mode,
		hasMore,
		hasPrevious,
		loadPrevious,
		loading,
		loadMore,
		error,
		highlights,
		locallyCovered,
		encryptedRoomCount,
		scanTruncated,
		serverUnsupported,
		moreOnServer,
	};
}
