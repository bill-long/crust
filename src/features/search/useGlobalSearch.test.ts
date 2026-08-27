import type { ISearchResults, MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	type GlobalSearchHit,
	groupByRoom,
	useGlobalSearch,
} from "./useGlobalSearch";

function hit(over: Partial<GlobalSearchHit> = {}): GlobalSearchHit {
	return {
		eventId: "$e",
		sender: "@ann:x",
		senderName: "Ann",
		timestamp: 0,
		body: "hello",
		roomId: "!a:x",
		...over,
	};
}

interface FakeEventInit {
	id?: string;
	roomId?: string | null;
	body?: string;
	ts?: number;
	type?: string;
}

function fakeEvent(init: FakeEventInit = {}): MatrixEvent {
	return {
		getId: () => init.id ?? "$e",
		getRoomId: () => (init.roomId === undefined ? "!a:x" : init.roomId),
		getType: () => init.type ?? "m.room.message",
		getTs: () => init.ts ?? 0,
		getSender: () => "@ann:x",
		isRedacted: () => false,
		getContent: () => ({ msgtype: "m.text", body: init.body ?? "hello" }),
	} as unknown as MatrixEvent;
}

function fakeRoom(
	roomId: string,
	events: MatrixEvent[],
	encrypted = false,
	threads: {
		timelineSet: { getTimelines: () => { getEvents: () => MatrixEvent[] }[] };
	}[] = [],
) {
	return {
		roomId,
		getMyMembership: () => "join",
		getLastActiveTimestamp: () => 0,
		hasEncryptionStateEvent: () => encrypted,
		isSpaceRoom: () => false,
		getMember: () => null,
		getUnfilteredTimelineSet: () => ({
			getTimelines: () => [{ getEvents: () => events }],
		}),
		getThreads: () => threads,
	};
}

interface FakeClientInit {
	rooms?: ReturnType<typeof fakeRoom>[];
	search?: () => Promise<ISearchResults>;
}

function fakeClient(init: FakeClientInit = {}) {
	const rooms = init.rooms ?? [];
	const searchRoomEvents = vi.fn(
		init.search ??
			(async () =>
				({
					results: [],
					highlights: [],
					count: 0,
				}) as unknown as ISearchResults),
	);
	return {
		client: {
			getRooms: () => rooms,
			getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
			searchRoomEvents,
			backPaginateRoomEventsSearch: vi.fn(),
		} as unknown as MatrixClient,
		searchRoomEvents,
	};
}

/** Runs far enough for a search to settle. Microtasks alone are not enough:
 *  the latched path defers its scan with a real timer, deliberately, so that
 *  it leaves the keystroke's frame rather than merely its call stack. */
async function settle(): Promise<void> {
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < 6; i++) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Runs the hook in its own root and hands back the disposer, so awaits
 *  happen in the test body rather than inside an un-awaited callback. */
function withSearch(client: MatrixClient) {
	return createRoot((dispose) => ({
		search: useGlobalSearch(client),
		dispose,
	}));
}

describe("groupByRoom", () => {
	it("keeps each room's hits together in first-seen order", () => {
		const grouped = groupByRoom([
			hit({ eventId: "$1", roomId: "!a:x" }),
			hit({ eventId: "$2", roomId: "!b:x" }),
			hit({ eventId: "$3", roomId: "!a:x" }),
		]);

		expect(grouped.map((g) => g.roomId)).toEqual(["!a:x", "!b:x"]);
		expect(grouped[0].hits.map((h) => h.eventId)).toEqual(["$1", "$3"]);
		expect(grouped[1].hits.map((h) => h.eventId)).toEqual(["$2"]);
	});

	it("returns nothing for no hits", () => {
		expect(groupByRoom([])).toEqual([]);
	});
});

describe("useGlobalSearch", () => {
	it("searches every room, with no room filter", async () => {
		const { client, searchRoomEvents } = fakeClient();
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();

		// The filter being absent is what makes this global rather than a
		// per-room search: `searchRoomEvents` scopes by `filter.rooms`.
		expect(searchRoomEvents).toHaveBeenCalledWith({ term: "hello" });
		dispose();
	});

	it("falls back to a local scan when the server has no search", async () => {
		// Conduwuity, this project's homeserver, does not implement /search.
		// Without the fallback the feature would simply not exist there.
		const rooms = [
			fakeRoom("!a:x", [fakeEvent({ id: "$1", body: "find me please" })]),
		];
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw new Error("M_UNRECOGNIZED");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("find me");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.mode()).toBe("local");
		expect(search.total()).toBe(1);
		expect(search.groups()[0].hits[0].eventId).toBe("$1");
		dispose();
	});

	it("scans the encrypted rooms the server cannot read", async () => {
		// A server answer has a hole exactly where private conversations
		// are, and the per-room panel finds that text by scanning locally -
		// so counting the hole rather than filling it would make global
		// search strictly worse than per-room search for the same query.
		const secret = fakeEvent({ id: "$secret", body: "hello in private" });
		const rooms = [
			fakeRoom("!a:x", [], false),
			fakeRoom("!b:x", [secret], true),
			fakeRoom("!c:x", [], true),
		];
		const { client } = fakeClient({ rooms });
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.mode()).toBe("server");
		expect(search.locallyCovered()).toBe(2);
		// The hit from the encrypted room is merged into the server answer,
		// not merely counted.
		expect(search.total()).toBe(1);
		expect(search.groups()[0].hits[0].eventId).toBe("$secret");
		dispose();
	});

	it("counts rooms across the whole result set, not the page", async () => {
		// `groups()` holds only the page, so reading the room count from it
		// reported "N results in 3 rooms" and changed the room count on
		// every Load more.
		const rooms = Array.from({ length: 5 }, (_, r) =>
			fakeRoom(
				`!r${r}:x`,
				Array.from({ length: 10 }, (_, i) =>
					fakeEvent({
						id: `$r${r}e${i}`,
						roomId: `!r${r}:x`,
						body: "match me",
					}),
				),
			),
		);
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.total()).toBe(50);
		expect(search.totalRooms()).toBe(5);
		// The page shows fewer rooms than the result set spans.
		expect(search.groups().length).toBeLessThan(5);
		dispose();
	});

	it("separates 'the server has more' from 'this window has more'", async () => {
		// The status line may only call a count partial when the server is
		// holding some. A 35-hit answer with no next_batch still has another
		// page behind the 20-row window, and on a server without /search the
		// encrypted scan supplies most of those hits.
		const many = Array.from({ length: 35 }, (_, i) => ({
			context: {
				getEvent: () => fakeEvent({ id: `$e${i}`, body: "match" }),
			},
		}));
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results: many,
					highlights: [],
					count: 35,
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();

		expect(search.total()).toBe(35);
		// More to page through...
		expect(search.hasMore()).toBe(true);
		// ...but nothing more to fetch.
		expect(search.moreOnServer()).toBe(false);
		dispose();
	});

	it("reports more on the server when a next_batch is offered", async () => {
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results: [
						{
							context: {
								getEvent: () => fakeEvent({ id: "$a", body: "match" }),
							},
						},
					],
					highlights: [],
					count: 1,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();

		expect(search.moreOnServer()).toBe(true);
		dispose();
	});

	it("heads each room with its count across the set, not the page", async () => {
		// The header sits directly under a status line reporting the set-wide
		// total, so counting the page there puts two numbers for the same
		// set next to each other, disagreeing.
		const many = Array.from({ length: 40 }, (_, i) =>
			fakeEvent({ id: `$e${i}`, body: "match", ts: i }),
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", many)],
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();

		expect(search.groups()[0].hits.length).toBe(20);
		expect(search.groups()[0].total).toBe(40);
		dispose();
	});

	it("does not spend the scan budget on spaces", async () => {
		// Spaces are joined rooms whose timelines are state events that can
		// never match, so walking them makes truncation more likely for the
		// rooms that can - and a stray message in one would produce a hit
		// that navigates to a room view for a space.
		const spaceEvents = Array.from({ length: 6000 }, (_, i) =>
			fakeEvent({ id: `$s${i}`, roomId: "!space:x", body: "noise" }),
		);
		const space = {
			...fakeRoom("!space:x", spaceEvents),
			isSpaceRoom: () => true,
		};
		const rooms = [
			space as unknown as ReturnType<typeof fakeRoom>,
			fakeRoom("!real:x", [fakeEvent({ id: "$hit", body: "find me" })]),
		];
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("find me");
		await Promise.resolve();
		await Promise.resolve();

		// The space's 6000 events would have exhausted the ceiling before
		// the real room was reached.
		expect(search.scanTruncated()).toBe(false);
		expect(search.total()).toBe(1);
		dispose();
	});

	it("does not count a room entered with no budget left", async () => {
		// The first room uses the budget exactly, so its own loop ends
		// normally and the inner check never fires. Without a check on entry
		// the next rooms are walked - finding nothing, since there is nothing
		// cached - and reported as covered, with truncation never noticed.
		const exact = Array.from({ length: 5000 }, (_, i) =>
			fakeEvent({ id: `$x${i}`, roomId: "!full:x", body: "nothing" }),
		);
		const rooms = [
			fakeRoom("!full:x", exact, true),
			fakeRoom("!never:x", [], true),
			fakeRoom("!alsonever:x", [], true),
		];
		const { client } = fakeClient({ rooms });
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();

		expect(search.scanTruncated()).toBe(true);
		expect(search.locallyCovered()).toBe(1);
		expect(search.encryptedRoomCount()).toBe(3);
		dispose();
	});

	it("does not claim rooms the ceiling never reached", async () => {
		// The ceiling is shared across every room, so a single deep cache
		// exhausts it before the second room is touched - and the note must
		// not then report all of them as covered.
		const deep = Array.from({ length: 6000 }, (_, i) =>
			fakeEvent({ id: `$d${i}`, roomId: "!deep:x", body: "nothing here" }),
		);
		const rooms = [
			fakeRoom("!deep:x", deep, true),
			fakeRoom("!other:x", [], true),
			fakeRoom("!third:x", [], true),
		];
		const { client } = fakeClient({ rooms });
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.scanTruncated()).toBe(true);
		expect(search.locallyCovered()).toBeLessThan(3);
		// The note needs the denominator too, or "2 searched" reads as
		// though 2 was the whole set.
		expect(search.encryptedRoomCount()).toBe(3);
		dispose();
	});

	it("keeps a server answer when the encrypted-room scan throws", async () => {
		// That scan enhances an answer already in hand, so one malformed
		// room must degrade to "server results without the encrypted ones"
		// rather than turn a complete result set into a blanket failure.
		const exploding = {
			roomId: "!enc:x",
			getMyMembership: () => "join",
			isSpaceRoom: () => false,
			getLastActiveTimestamp: () => 0,
			hasEncryptionStateEvent: () => true,
			getMember: () => null,
			getThreads: () => [],
			getUnfilteredTimelineSet: () => {
				throw new Error("boom");
			},
		};
		const { client } = fakeClient({
			rooms: [
				fakeRoom("!a:x", []),
				exploding as unknown as ReturnType<typeof fakeRoom>,
			],
			search: async () =>
				({
					results: [
						{
							context: {
								getEvent: () => fakeEvent({ id: "$s", body: "match" }),
							},
						},
					],
					highlights: [],
					count: 1,
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();

		expect(search.status()).toBe("results");
		expect(search.total()).toBe(1);
		expect(search.groups()[0].hits[0].eventId).toBe("$s");
		// Nothing claimed as covered, since nothing was - and the panel has
		// to say so. With `scanTruncated` false as well, `coverageNote`
		// falls through every branch and returns null, so every encrypted
		// room would be skipped in silence.
		expect(search.locallyCovered()).toBe(0);
		expect(search.encryptedRoomCount()).toBe(1);
		expect(search.scanTruncated()).toBe(true);
		dispose();
	});

	it("does not fall back to local mode when the server already answered", async () => {
		// A throw from the encrypted scan was being read as "this server has
		// no /search", discarding an answer that had already arrived.
		// The throw has to come from post-processing while a *local scan
		// would have succeeded*, or "stayed in server mode" proves nothing:
		// a scan that also throws leaves the mode untouched either way.
		const { client } = fakeClient({
			rooms: [fakeRoom("!ok:x", [fakeEvent({ body: "hello there" })])],
			search: async () =>
				({
					results: [
						{
							context: {
								getEvent: () => {
									throw new Error("boom");
								},
							},
						},
					],
					highlights: [],
					count: 1,
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.mode()).toBe("server");
		expect(search.status()).toBe("error");
		dispose();
	});

	it("reports the number found, not the size of the page shown", async () => {
		// Local mode pages at 25; announcing "25 results" for 40 matches
		// tells the user the search found less than it did.
		const many = Array.from({ length: 40 }, (_, i) =>
			fakeEvent({ id: `$e${i}`, body: "match me", ts: i }),
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", many)],
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.total()).toBe(40);
		expect(search.groups()[0].hits.length).toBe(20);
		expect(search.hasMore()).toBe(true);
		dispose();
	});

	it("claims nothing was skipped when the local scan answered", async () => {
		// The local scan reads encrypted rooms too, so the caveat that
		// applies to a server answer must not be carried over to this one.
		const rooms = [fakeRoom("!a:x", [fakeEvent({ body: "hello" })], true)];
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.mode()).toBe("local");
		expect(search.locallyCovered()).toBe(0);
		dispose();
	});

	it("does not let a slow first query overwrite a fast second one", async () => {
		let release: ((r: ISearchResults) => void) | undefined;
		const first = new Promise<ISearchResults>((res) => {
			release = res;
		});
		let call = 0;
		const { client } = fakeClient({
			search: () => {
				call++;
				return call === 1
					? first
					: Promise.resolve({
							results: [],
							highlights: ["second"],
							count: 0,
						} as unknown as ISearchResults);
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("first");
		search.submit("second");
		await Promise.resolve();
		await Promise.resolve();
		release?.({
			results: [],
			highlights: ["first"],
			count: 0,
		} as unknown as ISearchResults);
		await Promise.resolve();
		await Promise.resolve();

		expect(search.query()).toBe("second");
		expect(search.highlights()).toEqual(["second"]);
		dispose();
	});

	it("clears everything when the query is emptied", async () => {
		const rooms = [fakeRoom("!a:x", [fakeEvent({ body: "hello" })])];
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();
		await Promise.resolve();
		expect(search.total()).toBe(1);

		search.submit("   ");

		expect(search.status()).toBe("idle");
		expect(search.total()).toBe(0);
		expect(search.groups()).toEqual([]);
		expect(search.scanTruncated()).toBe(false);
		dispose();
	});

	it("finds thread replies, which are not in the main timeline", async () => {
		// The SDK keeps replies out of the unfiltered set. Local mode is the
		// only mode on a server without /search, so missing them here would
		// mean thread replies are globally unfindable on this homeserver.
		const reply = fakeEvent({ id: "$reply", body: "buried in a thread" });
		const rooms = [
			fakeRoom("!a:x", [], false, [
				{ timelineSet: { getTimelines: () => [{ getEvents: () => [reply] }] } },
			]),
		];
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("buried");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.total()).toBe(1);
		expect(search.groups()[0].hits[0].eventId).toBe("$reply");
		dispose();
	});

	it("counts a thread root once, not once per timeline", async () => {
		// The SDK dual-homes a root into both the main set and its thread's,
		// so the same event arrives twice.
		const root = fakeEvent({ id: "$root", body: "shared root" });
		const rooms = [
			fakeRoom("!a:x", [root], false, [
				{ timelineSet: { getTimelines: () => [{ getEvents: () => [root] }] } },
			]),
		];
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("shared");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.total()).toBe(1);
		dispose();
	});

	it("keeps the caveat while the results it describes are still shown", async () => {
		// This reverses an earlier decision. Clearing `mode` and the coverage
		// numbers on submit was right when a search blanked the panel; once
		// the previous answer began being retained across the round trip, it
		// left those results rendered with "Server search is unavailable"
		// removed - presenting a local scan as a complete server answer.
		const rooms = [fakeRoom("!a:x", [fakeEvent({ body: "hello" })])];
		const { client } = fakeClient({
			rooms,
			search: async () => {
				throw Object.assign(new Error("nope"), {
					httpStatus: 404,
					errcode: "M_UNRECOGNIZED",
				});
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await settle();
		expect(search.mode()).toBe("local");
		expect(search.total()).toBe(1);

		search.submit("hello");
		// Mid-flight: the previous answer is still on screen, so the caveat
		// that qualifies it has to be too.
		expect(search.mode()).toBe("local");
		expect(search.total()).toBe(1);

		await settle();
		expect(search.mode()).toBe("local");
		dispose();
	});

	it("clears the coverage caveat when the local scan itself fails", async () => {
		// Local after local is the normal sequence on a server without
		// /search. `coverageNote`'s local branch reads none of the counts -
		// only `mode` - so leaving that behind rendered "Server search is
		// unavailable. Showing matches from messages already loaded" over an
		// empty list beside "Search failed."
		let broken = false;
		const room = {
			roomId: "!a:x",
			getMyMembership: () => "join",
			isSpaceRoom: () => false,
			getLastActiveTimestamp: () => 0,
			hasEncryptionStateEvent: () => false,
			getMember: () => null,
			getThreads: () => [],
			getUnfilteredTimelineSet: () => {
				if (broken) throw new Error("boom");
				return {
					getTimelines: () => [
						{ getEvents: () => [fakeEvent({ body: "match me" })] },
					],
				};
			},
		};
		const { client } = fakeClient({
			rooms: [room as unknown as ReturnType<typeof fakeRoom>],
			search: async () => {
				throw Object.assign(new Error("nope"), {
					httpStatus: 404,
					errcode: "M_UNRECOGNIZED",
				});
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		expect(search.mode()).toBe("local");
		expect(search.total()).toBe(1);

		broken = true;
		search.submit("match");
		await settle();

		expect(search.status()).toBe("error");
		// Back to `server`, so the local-mode caveat stops being rendered
		// over a result set that no longer exists.
		expect(search.mode()).toBe("server");
		expect(search.locallyCovered()).toBe(0);
		expect(search.scanTruncated()).toBe(false);
		dispose();
	});

	it("reports an error rather than searching forever if the scan throws", async () => {
		// The local scan is the fallback: nothing catches it downstream, and
		// only `loading` is cleared by the caller, so a throw would leave the
		// status at "searching" permanently.
		const broken = {
			roomId: "!a:x",
			getMyMembership: () => "join",
			getLastActiveTimestamp: () => 0,
			hasEncryptionStateEvent: () => false,
			isSpaceRoom: () => false,
			getMember: () => null,
			getUnfilteredTimelineSet: () => {
				throw new Error("timeline exploded");
			},
			getThreads: () => [],
		};
		const { client } = fakeClient({
			rooms: [broken as unknown as ReturnType<typeof fakeRoom>],
			search: async () => {
				throw new Error("nope");
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.status()).toBe("error");
		expect(search.loading()).toBe(false);
		dispose();
	});

	it("shows more of what arrived before asking the server again", async () => {
		// Cursor paging: a server page larger than PAGE_SIZE is revealed in
		// steps, and only when it runs out is another page fetched.
		const results = Array.from({ length: 30 }, (_, i) => ({
			context: {
				getEvent: () => fakeEvent({ id: `$s${i}`, body: "match me" }),
			},
		}));
		const backPaginate = vi.fn();
		const { client } = fakeClient({
			// The room has to be joined and non-space for the server filter
			// to keep its hits, same gate the local scan applies.
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results,
					highlights: [],
					count: 30,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.total()).toBe(30);
		expect(search.groups()[0].hits.length).toBe(20);
		expect(search.hasMore()).toBe(true);

		search.loadMore();

		// The window moved rather than grew: page two is the remaining ten,
		// and no second request was needed for them.
		expect(search.groups()[0].hits.length).toBe(10);
		expect(search.hasPrevious()).toBe(true);
		expect(backPaginate).not.toHaveBeenCalled();

		search.loadPrevious();
		expect(search.groups()[0].hits.length).toBe(20);
		expect(search.hasPrevious()).toBe(false);
		dispose();
	});

	it("asks the server for another page once the cursor runs out", async () => {
		const results = [
			{ context: { getEvent: () => fakeEvent({ id: "$a", body: "match" }) } },
		];
		const backPaginate = vi.fn(
			async () =>
				({
					results,
					highlights: [],
					count: 1,
				}) as unknown as ISearchResults,
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results,
					highlights: [],
					count: 1,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await Promise.resolve();
		await Promise.resolve();
		expect(search.hasMore()).toBe(true);

		search.loadMore();
		await Promise.resolve();
		await Promise.resolve();

		expect(backPaginate).toHaveBeenCalledTimes(1);
		// The follow-up page has no next_batch, so there is nothing further.
		expect(search.hasMore()).toBe(false);
		dispose();
	});

	it("does not return hits from rooms we have left", async () => {
		// /search with no room filter covers left rooms - history visibility
		// permits it - and a hit in one navigates to a pane with an unusable
		// timeline and composer.
		const left = { ...fakeRoom("!gone:x", []), getMyMembership: () => "leave" };
		const { client } = fakeClient({
			rooms: [left as unknown as ReturnType<typeof fakeRoom>],
			search: async () =>
				({
					results: [
						{
							context: {
								getEvent: () => fakeEvent({ roomId: "!gone:x" }),
							},
						},
					],
					highlights: [],
					count: 1,
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.total()).toBe(0);
		dispose();
	});

	it("stops asking a server that has no search, but retries after a blip", async () => {
		// Conduwuity does not implement /search, and re-asking spends a
		// round trip per query rediscovering that. A 5xx is a different
		// thing and must not downgrade the session permanently.
		let calls = 0;
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [fakeEvent({ body: "hello" })])],
			search: async () => {
				calls++;
				throw Object.assign(new Error("nope"), {
					httpStatus: 404,
					errcode: "M_UNRECOGNIZED",
				});
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await settle();
		expect(calls).toBe(1);

		search.submit("hello again");
		await settle();

		expect(calls).toBe(1);
		expect(search.mode()).toBe("local");
		dispose();
	});

	it("advances a whole page after fetching from the server", async () => {
		// Page-aligned, not anchored on a hit: `mergeServer` re-sorts, so a
		// newly fetched hit can sort before the last one rendered, and a
		// window resumed after that hit would step past a region it had
		// never shown.
		const page = (from: number, n: number) =>
			Array.from({ length: n }, (_, i) => ({
				context: {
					getEvent: () => fakeEvent({ id: `$e${from + i}`, body: "match" }),
				},
			}));
		const first = page(0, 20);
		const backPaginate = vi.fn(
			async () =>
				({
					results: [...first, ...page(20, 20)],
					highlights: [],
					count: 40,
				}) as unknown as ISearchResults,
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results: first,
					highlights: [],
					count: 20,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		expect(search.groups()[0].hits.map((h) => h.eventId)).toContain("$e0");

		search.loadMore();
		await settle();

		// The whole second page, and none of the first.
		const shown = search.groups()[0].hits.map((h) => h.eventId);
		expect(shown).toContain("$e20");
		expect(shown).not.toContain("$e0");
		expect(search.hasPrevious()).toBe(true);

		// And back, landing on the page boundary rather than off-grid.
		search.loadPrevious();
		expect(search.groups()[0].hits.map((h) => h.eventId)).toContain("$e0");
		expect(search.hasPrevious()).toBe(false);
		dispose();
	});

	it("treats a bodiless 404 as transient, not as a missing endpoint", async () => {
		// A 404 with no Matrix error body is a proxy or an ingress
		// mid-restart. Latching on it downgraded every later search in the
		// session to local history, recoverable only by reloading the page.
		let calls = 0;
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [fakeEvent({ body: "match" })])],
			search: async () => {
				calls++;
				throw Object.assign(new Error("gateway"), { httpStatus: 404 });
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		expect(calls).toBe(1);

		search.submit("match");
		await settle();

		// Asked again, rather than assuming the endpoint is gone.
		expect(calls).toBe(2);
		expect(search.serverUnsupported()).toBe(false);
		dispose();
	});

	it("does not leave a cleared search's caveat behind", async () => {
		// `serverUnsupported` is latched for the session and the pane renders
		// the note unconditionally, so a fallback that was cleared left
		// "Server search is unavailable" pinned between the field and the
		// room list, and announced again on every clear.
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [fakeEvent({ body: "match" })])],
			search: async () => {
				throw Object.assign(new Error("nope"), {
					httpStatus: 404,
					errcode: "M_UNRECOGNIZED",
				});
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		expect(search.mode()).toBe("local");

		search.reset();

		expect(search.status()).toBe("idle");
		expect(search.mode()).toBe("server");
		dispose();
	});

	it("does not scan inside the submit handler once the server is known bad", async () => {
		// An async function runs synchronously to its first await, and the
		// latched branch sits before any - so the whole scan would block the
		// form's submit.
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [fakeEvent({ body: "hello" })])],
			search: async () => {
				throw Object.assign(new Error("nope"), {
					httpStatus: 404,
					errcode: "M_UNRECOGNIZED",
				});
			},
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await settle();
		expect(search.mode()).toBe("local");

		// Second query takes the latched path: nothing may have happened yet
		// when submit returns.
		// Same query, so the same hit is expected back - the point is when
		// the work happens, not what it finds.
		const before = search.groups();
		search.submit("hello");
		expect(search.status()).toBe("searching");
		// Microtasks alone must not be enough. `await Promise.resolve()`
		// drains at the end of the current task, before the browser can
		// paint, so deferring with one moved the scan out of the call stack
		// but left it on the same frame - which is what the budget is about.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(search.status()).toBe("searching");
		// Still the previous answer, not an empty panel: nothing has run yet,
		// which is the point - and the results only change once there is
		// something to change them to.
		expect(search.groups()).toBe(before);

		await settle();
		expect(search.status()).toBe("results");
		dispose();
	});

	it("clears a pagination error once another page loads", async () => {
		// The error replaced the result count for the rest of the search,
		// even after paging back to one that had loaded fine.
		const results = Array.from({ length: 40 }, (_, i) => ({
			context: {
				getEvent: () => fakeEvent({ id: `$e${i}`, body: "match" }),
			},
		}));
		const backPaginate = vi.fn(async () => {
			throw new Error("flaky");
		});
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results,
					highlights: [],
					count: 40,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();

		// Page two comes from what already arrived.
		search.loadMore();
		expect(search.hasPrevious()).toBe(true);
		// Page three needs the server, which fails.
		search.loadMore();
		await settle();
		expect(search.error()).not.toBeNull();

		search.loadPrevious();

		expect(search.error()).toBeNull();
		dispose();
	});

	it("stops saying 'no messages' once a later page finds some", async () => {
		// Page one can project to nothing while the server still offers more
		// - every result an image, an edit, or in a room we have left. The
		// list then filled up underneath "No messages found."
		let first = true;
		const good = [
			{ context: { getEvent: () => fakeEvent({ id: "$a", body: "match" }) } },
		];
		const backPaginate = vi.fn(
			async () =>
				({
					results: good,
					highlights: [],
					count: 1,
				}) as unknown as ISearchResults,
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () => {
				first = false;
				return {
					results: [],
					highlights: [],
					count: 0,
					next_batch: "more",
				} as unknown as ISearchResults;
			},
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		expect(first).toBe(false);
		expect(search.status()).toBe("empty");
		expect(search.hasMore()).toBe(true);

		search.loadMore();
		await settle();

		expect(search.total()).toBe(1);
		expect(search.status()).toBe("results");
		dispose();
	});

	it("does not loop forever when a fetched page projects to nothing", async () => {
		// Every result an image, an edit, or in a room we have left: `merged`
		// is unchanged, so clamping the window into the array dragged it back
		// onto the last row already seen - and with `next_batch` still set,
		// every further click repeated that same row.
		const real = Array.from({ length: 25 }, (_, i) => ({
			context: {
				getEvent: () => fakeEvent({ id: `$e${i}`, body: "match" }),
			},
		}));
		const junk = Array.from({ length: 10 }, (_, i) => ({
			context: {
				getEvent: () =>
					({
						getId: () => `$img${i}`,
						getRoomId: () => "!a:x",
						getType: () => "m.room.message",
						getTs: () => 0,
						getSender: () => "@a:x",
						isRedacted: () => false,
						getContent: () => ({ msgtype: "m.image", body: "pic" }),
					}) as unknown as MatrixEvent,
			},
		}));
		const backPaginate = vi.fn(
			async () =>
				({
					results: [...real, ...junk],
					highlights: [],
					count: 35,
					next_batch: "yet more",
				}) as unknown as ISearchResults,
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results: real,
					highlights: [],
					count: 25,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		// Page two is the rest of what arrived.
		search.loadMore();
		expect(search.groups()[0].hits.length).toBe(5);

		// Page three needs the server, which returns only unprojectable
		// results. The window must not slide backwards onto a seen row.
		search.loadMore();
		await settle();

		expect(search.groups()[0].hits.map((h) => h.eventId)).toEqual([
			"$e20",
			"$e21",
			"$e22",
			"$e23",
			"$e24",
		]);
		dispose();
	});

	it("does not leave one query's results under another query's failure", async () => {
		// Retaining the previous answer is for the wait, not for a failure -
		// otherwise the old rows sit there marked up with the old terms
		// under "Search failed."
		let explode = false;
		const { client } = fakeClient({
			// An encrypted room, so the coverage numbers are actually written
			// before the throw - without one they are zero either way and the
			// reset is invisible.
			rooms: [fakeRoom("!a:x", []), fakeRoom("!enc:x", [], true)],
			search: async () =>
				({
					results: [
						{
							context: {
								getEvent: () => {
									if (explode) throw new Error("boom");
									return fakeEvent({ id: "$ok", body: "match" });
								},
							},
						},
					],
					highlights: ["match"],
					count: 1,
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		expect(search.total()).toBe(1);

		explode = true;
		search.submit("other");
		await settle();

		expect(search.status()).toBe("error");
		expect(search.groups()).toEqual([]);
		expect(search.highlights()).toEqual([]);
		// The coverage numbers describe a result set that no longer exists.
		expect(search.locallyCovered()).toBe(0);
		expect(search.encryptedRoomCount()).toBe(0);
		expect(search.scanTruncated()).toBe(false);
		dispose();
	});

	it("republishes the page when one fails, so the panel can react", async () => {
		// Nothing else changes `groups` on the failure path, and the panel's
		// focus rescue is keyed on the rows changing - so a keyboard user
		// whose page failed was left on <body> with the rescue still armed
		// to fire on some later unrelated publish.
		const results = [
			{ context: { getEvent: () => fakeEvent({ id: "$a", body: "match" }) } },
		];
		const backPaginate = vi.fn(async () => {
			throw new Error("blip");
		});
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results,
					highlights: [],
					count: 1,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		const before = search.groups();

		search.loadMore();
		await settle();

		// A new array, so anything watching the rows runs.
		expect(search.groups()).not.toBe(before);
		expect(search.error()).not.toBeNull();
		dispose();
	});

	it("steps to the page boundary, not to wherever the last page ended", async () => {
		// A first page that projects to fewer than PAGE_SIZE hits leaves the
		// count off-grid; resuming from it would show a window straddling
		// two pages, and stepping back from there lands on a third.
		const page = (from: number, n: number) =>
			Array.from({ length: n }, (_, i) => ({
				context: {
					getEvent: () => fakeEvent({ id: `$e${from + i}`, body: "match" }),
				},
			}));
		const first = page(0, 15);
		const backPaginate = vi.fn(
			async () =>
				({
					results: [...first, ...page(15, 20)],
					highlights: [],
					count: 35,
				}) as unknown as ISearchResults,
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results: first,
					highlights: [],
					count: 15,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		// A partial first page: 15 of a 20-row window.
		expect(search.groups()[0].hits.length).toBe(15);

		search.loadMore();
		await settle();
		// The fetch fills the page the user is on rather than stepping past
		// it - those five rows would otherwise be counted and never shown.
		expect(search.groups()[0].hits[0].eventId).toBe("$e0");
		expect(search.groups()[0].hits.length).toBe(20);

		search.loadMore();
		await settle();
		// Now the page was full, so this one advances - to the boundary, not
		// to wherever the previous page's hits happened to run out.
		expect(search.groups()[0].hits[0].eventId).toBe("$e20");
		dispose();
	});

	it("keeps the window inside a result set that shrank", async () => {
		// A later page is re-projected from scratch and can come back
		// smaller - a room left between pages drops out. With the anchor
		// gone too, the window stayed past the end and published an empty
		// page under a "results" status.
		const page = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				context: {
					getEvent: () => fakeEvent({ id: `$e${i}`, body: "match" }),
				},
			}));
		let shrink = false;
		const backPaginate = vi.fn(
			async () =>
				({
					results: page(shrink ? 3 : 40),
					highlights: [],
					count: 3,
				}) as unknown as ISearchResults,
		);
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results: page(40),
					highlights: [],
					count: 40,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();
		search.loadMore();
		await settle();
		expect(search.groups()[0].hits.length).toBeGreaterThan(0);

		// The next page comes back smaller than the window's offset.
		shrink = true;
		search.loadMore();
		await settle();

		expect(search.total()).toBe(3);
		expect(search.groups()[0].hits.length).toBeGreaterThan(0);
		dispose();
	});

	it("lets a failed page be retried rather than ending the results", async () => {
		// `next_batch` is still valid after a dropped request, so clearing
		// `hasMore` - which unmounts the button - turned a blip into the end
		// of the result set.
		const results = [
			{ context: { getEvent: () => fakeEvent({ id: "$a", body: "match" }) } },
		];
		let failNext = true;
		const backPaginate = vi.fn(async () => {
			if (failNext) throw new Error("blip");
			return { results, highlights: [], count: 1 } as unknown as ISearchResults;
		});
		const { client } = fakeClient({
			rooms: [fakeRoom("!a:x", [])],
			search: async () =>
				({
					results,
					highlights: [],
					count: 1,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		(
			client as unknown as { backPaginateRoomEventsSearch: unknown }
		).backPaginateRoomEventsSearch = backPaginate;
		const { search, dispose } = withSearch(client);

		search.submit("match");
		await settle();

		search.loadMore();
		await settle();
		expect(search.error()).not.toBeNull();
		// Still offered, so the press can be repeated.
		expect(search.hasMore()).toBe(true);

		failNext = false;
		search.loadMore();
		await settle();
		expect(search.error()).toBeNull();
		dispose();
	});

	it("treats a page that projects to nothing as empty", async () => {
		// A server can return a next_batch whose page is entirely images,
		// redactions or edits. Calling that "results" renders a counter and
		// a Load-more button over an empty list.
		const { client } = fakeClient({
			search: async () =>
				({
					results: [],
					highlights: [],
					count: 0,
					next_batch: "more",
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("nothing");
		await Promise.resolve();
		await Promise.resolve();

		expect(search.status()).toBe("empty");
		dispose();
	});

	it("skips a result whose room it cannot identify", async () => {
		// Grouping and navigation both key off the room, so a hit without one
		// has nowhere to go.
		const { client } = fakeClient({
			search: async () =>
				({
					results: [
						{ context: { getEvent: () => fakeEvent({ roomId: null }) } },
					],
					highlights: [],
					count: 1,
				}) as unknown as ISearchResults,
		});
		const { search, dispose } = withSearch(client);

		search.submit("hello");
		await Promise.resolve();

		expect(search.total()).toBe(0);
		dispose();
	});
});
