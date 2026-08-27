import { describe, expect, it } from "vitest";
import { coverageNote, flattenGroups, searchStatusMessage } from "./panelRows";
import type { GlobalSearchHit } from "./useGlobalSearch";

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

describe("flattenGroups", () => {
	it("puts a heading in front of each room's hits", () => {
		// A listbox owns its options directly, so a heading has to be a
		// sibling of the options it introduces rather than a wrapper.
		const rows = flattenGroups([
			{
				roomId: "!a:x",
				hits: [hit({ eventId: "$1" }), hit({ eventId: "$2" })],
				total: 2,
			},
			{
				roomId: "!b:x",
				hits: [hit({ eventId: "$3", roomId: "!b:x" })],
				total: 1,
			},
		]);

		expect(rows.map((r) => r.kind)).toEqual([
			"header",
			"hit",
			"hit",
			"header",
			"hit",
		]);
		expect(rows[0]).toMatchObject({ roomId: "!a:x", count: 2 });
		expect(rows[3]).toMatchObject({ roomId: "!b:x", count: 1 });
	});

	it("heads a room with its whole count, not the page's", () => {
		// The page is a window: a room with 30 matches showing 20 of them
		// would otherwise head its section "20" directly under a status line
		// reading "30 results in 1 room".
		const rows = flattenGroups([
			{ roomId: "!a:x", hits: [hit({ eventId: "$1" })], total: 30 },
		]);
		expect(rows[0]).toMatchObject({ count: 30 });
	});

	it("produces nothing for no groups", () => {
		expect(flattenGroups([])).toEqual([]);
	});
});

describe("coverageNote", () => {
	it("says nothing when the server answered for every room", () => {
		// The common case must not carry a caveat, or the real ones stop
		// being read.
		expect(coverageNote("server", 0, 0, false, true)).toBeNull();
	});

	it("says encrypted rooms were covered locally, not skipped", () => {
		// They are searched - from this client's own history - so a note
		// saying they were not searched would send the user looking for a
		// result that is already on screen.
		const note = coverageNote("server", 3, 3, false, true) ?? "";
		expect(note).toContain("3 encrypted rooms");
		expect(note).toContain("local history only");
		expect(note).not.toContain("not searched");
	});

	it("agrees with itself for one room", () => {
		// `toContain("1 encrypted room")` was the original assertion, and it
		// passed against "1 encrypted room were not searched" - a prefix
		// match cannot see the verb, which is the half that was wrong.
		expect(coverageNote("server", 1, 1, false, true)).toBe(
			"1 encrypted room was searched from local history only: the server cannot read it.",
		);
	});

	it("admits a truncated encrypted scan under a working server", () => {
		// The server branch ignored scanTruncated entirely, so exactly the
		// case the local branch refuses to present as complete was being
		// presented as complete.
		// "N of M": naming only the rooms it finished reads as though that
		// was the whole set, when the rest were never opened at all.
		const note = coverageNote("server", 2, 40, true, true) ?? "";
		expect(note).toContain("2 of 40");
	});

	it("still says something when truncation left nothing claimable", () => {
		// The ceiling is shared across rooms, so it can trip inside the
		// first one - the case most in need of disclosure, and the one a
		// count-gated note would stay silent for.
		const note = coverageNote("server", 0, 12, true, true) ?? "";
		expect(note).toContain("0 of 12");
	});

	it("distinguishes a server without search from one that just failed", () => {
		// "unavailable" is a claim about the server, and only the latch knows
		// it. Saying it for a rate-limited or 502'd request tells the user
		// not to retry when retrying is exactly what would work.
		const unsupported = coverageNote("local", 0, 0, false, true) ?? "";
		const transient = coverageNote("local", 0, 0, false, false) ?? "";
		expect(unsupported).toContain("Server search is unavailable");
		expect(transient).toContain("could not be reached just now");
		expect(transient).not.toContain("unavailable");
	});

	it("explains a local answer, which covers different ground", () => {
		const note = coverageNote("local", 0, 0, false, true) ?? "";
		expect(note).toContain("already loaded");
		expect(note).not.toContain("encrypted");
	});

	it("admits when the local scan stopped early", () => {
		// A truncated scan reads exactly like an exhaustive one unless it
		// says otherwise, and there is no control that would continue it.
		const note = coverageNote("local", 0, 0, true, true) ?? "";
		expect(note).toContain("stopped scanning");
	});
});

describe("searchStatusMessage", () => {
	const base = {
		status: "results" as const,
		error: null,
		total: 3,
		totalRooms: 2,
		moreOnServer: false,
	};

	it("counts results and rooms", () => {
		expect(searchStatusMessage(base)).toBe("3 results in 2 rooms");
	});

	it("uses singulars for one of each", () => {
		expect(searchStatusMessage({ ...base, total: 1, totalRooms: 1 })).toBe(
			"1 result in 1 room",
		);
	});

	it("qualifies a count the server has more behind", () => {
		expect(searchStatusMessage({ ...base, moreOnServer: true })).toContain(
			"so far, more available",
		);
	});

	it("does not qualify a complete count that merely has more pages", () => {
		// The window is 20 rows wide, so a 35-hit answer has another page
		// behind it - but 35 is the whole count. This is easy to reach on a
		// server without /search, where the encrypted-room scan supplies most
		// of the hits and `next_batch` is never set.
		expect(
			searchStatusMessage({
				...base,
				total: 35,
				moreOnServer: false,
			}),
		).not.toContain("so far");
	});

	it("keeps the count and appends a page failure", () => {
		// The failed page's button is deliberately left in place so the
		// press can be repeated, so the error is not self-clearing -
		// replacing the count with it left the live region reading
		// "Couldn't load more results." for as long as the search stayed up.
		const line = searchStatusMessage({
			...base,
			error: "Couldn't load more results.",
		});
		expect(line).toContain("3 results in 2 rooms");
		expect(line).toContain("Couldn't load more results.");
	});

	it("keeps the empty state and appends a page failure", () => {
		// A page that projects to nothing but carries next_batch leaves the
		// status at "empty" with the pager mounted, so substituting the error
		// replaced the only text the panel shows - and the sidebar then never
		// said the search had found nothing again.
		const line = searchStatusMessage({
			...base,
			status: "empty",
			error: "Couldn't load more results.",
		});
		expect(line).toContain("No messages found.");
		expect(line).toContain("Couldn't load more results.");
	});

	it("says nothing at all when idle", () => {
		expect(searchStatusMessage({ ...base, status: "idle" })).toBe("");
	});
});
