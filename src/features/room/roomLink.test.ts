import type { Room, RoomMember } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { buildRoomLink, buildRoomLinkById, pickViaServers } from "./roomLink";

function mkMember(userId: string, powerLevel: number | undefined): RoomMember {
	return { userId, powerLevel } as unknown as RoomMember;
}

function mkRoom(opts: {
	roomId?: string;
	alias?: string | null;
	members?: RoomMember[];
}): Room {
	return {
		roomId: opts.roomId ?? "!room:matrix.org",
		getCanonicalAlias: () => opts.alias ?? null,
		getJoinedMembers: () => opts.members ?? [],
	} as unknown as Room;
}

describe("buildRoomLink", () => {
	it("uses the canonical alias when present", () => {
		const r = mkRoom({ alias: "#general:matrix.org" });
		expect(buildRoomLink(r)).toEqual({
			url: "https://matrix.to/#/%23general%3Amatrix.org",
			displayLabel: "#general:matrix.org",
		});
	});

	it("ignores via servers when an alias exists", () => {
		const r = mkRoom({
			alias: "#general:matrix.org",
			members: [
				mkMember("@alice:hs1.example", 100),
				mkMember("@bob:hs2.example", 50),
			],
		});
		expect(buildRoomLink(r).url).toBe(
			"https://matrix.to/#/%23general%3Amatrix.org",
		);
	});

	it("falls back to encoded room ID + via servers", () => {
		const r = mkRoom({
			roomId: "!abc:matrix.org",
			alias: null,
			members: [
				mkMember("@alice:hs1.example", 100),
				mkMember("@bob:hs2.example", 50),
				mkMember("@carol:hs3.example", 0),
			],
		});
		expect(buildRoomLink(r)).toEqual({
			url: "https://matrix.to/#/!abc%3Amatrix.org?via=hs1.example&via=hs2.example&via=hs3.example",
			displayLabel: "!abc:matrix.org",
		});
	});

	it("orders via servers by descending power level", () => {
		const r = mkRoom({
			roomId: "!abc:matrix.org",
			members: [
				mkMember("@alice:low.example", 0),
				mkMember("@bob:high.example", 100),
				mkMember("@carol:mid.example", 50),
			],
		});
		const { url } = buildRoomLink(r);
		expect(url).toBe(
			"https://matrix.to/#/!abc%3Amatrix.org?via=high.example&via=mid.example&via=low.example",
		);
	});

	it("deduplicates servers and caps at the limit", () => {
		const r = mkRoom({
			roomId: "!abc:matrix.org",
			members: [
				mkMember("@a:hs1.example", 100),
				mkMember("@b:hs1.example", 90),
				mkMember("@c:hs2.example", 80),
				mkMember("@d:hs3.example", 70),
				mkMember("@e:hs4.example", 60),
			],
		});
		const { url } = buildRoomLink(r);
		expect(url).toContain("via=hs1.example");
		expect(url).toContain("via=hs2.example");
		expect(url).toContain("via=hs3.example");
		expect(url).not.toContain("via=hs4.example");
	});

	it("URL-encodes via servers (IPv6 / ports)", () => {
		const r = mkRoom({
			roomId: "!abc:matrix.org",
			members: [
				mkMember("@a:[::1]:8008", 100),
				mkMember("@b:example.com:8448", 50),
			],
		});
		const { url } = buildRoomLink(r);
		expect(url).toContain("via=%5B%3A%3A1%5D%3A8008");
		expect(url).toContain("via=example.com%3A8448");
	});

	it("omits the ?via= section when there are no joined members", () => {
		const r = mkRoom({ roomId: "!abc:matrix.org", members: [] });
		expect(buildRoomLink(r)).toEqual({
			url: "https://matrix.to/#/!abc%3Amatrix.org",
			displayLabel: "!abc:matrix.org",
		});
	});

	it("skips malformed user IDs that have no server part", () => {
		const r = mkRoom({
			roomId: "!abc:matrix.org",
			members: [mkMember("@noserver", 100), mkMember("@a:hs1.example", 50)],
		});
		const { url } = buildRoomLink(r);
		expect(url).toBe("https://matrix.to/#/!abc%3Amatrix.org?via=hs1.example");
	});

	it("skips user IDs with an empty localpart or missing @ prefix", () => {
		const r = mkRoom({
			roomId: "!abc:matrix.org",
			members: [
				mkMember("@:evil.example", 100),
				mkMember("alice:noat.example", 90),
				mkMember("@bob:good.example", 50),
			],
		});
		const { url } = buildRoomLink(r);
		expect(url).toBe("https://matrix.to/#/!abc%3Amatrix.org?via=good.example");
	});

	it("preserves the existing display label for IDs vs aliases", () => {
		expect(buildRoomLink(mkRoom({ alias: "#x:y.example" })).displayLabel).toBe(
			"#x:y.example",
		);
		expect(
			buildRoomLink(mkRoom({ roomId: "!z:y.example", alias: null }))
				.displayLabel,
		).toBe("!z:y.example");
	});
});

describe("pickViaServers", () => {
	it("returns an empty list when limit is zero", () => {
		const r = mkRoom({
			members: [mkMember("@a:hs1.example", 100)],
		});
		expect(pickViaServers(r, 0)).toEqual([]);
	});

	it("returns an empty list for an empty room", () => {
		expect(pickViaServers(mkRoom({ members: [] }))).toEqual([]);
	});

	it("treats missing powerLevel as 0 without producing NaN ordering", () => {
		// A member whose state event predates a power-level event has
		// powerLevel === undefined. Without normalization the subtraction
		// would be NaN and the sort would be unstable, potentially
		// swallowing the ranked members entirely.
		const r = mkRoom({
			members: [
				mkMember("@noplevel:hs-x.example", undefined),
				mkMember("@admin:hs-a.example", 100),
				mkMember("@mod:hs-b.example", 50),
			],
		});
		expect(pickViaServers(r, 3)).toEqual([
			"hs-a.example",
			"hs-b.example",
			"hs-x.example",
		]);
	});
});

describe("buildRoomLinkById", () => {
	it("builds a minimal matrix.to link from a room ID", () => {
		expect(buildRoomLinkById("!abc:matrix.org")).toEqual({
			url: "https://matrix.to/#/!abc%3Amatrix.org",
			displayLabel: "!abc:matrix.org",
		});
	});

	it("builds a minimal matrix.to link from an alias", () => {
		expect(buildRoomLinkById("#general:matrix.org")).toEqual({
			url: "https://matrix.to/#/%23general%3Amatrix.org",
			displayLabel: "#general:matrix.org",
		});
	});
});
