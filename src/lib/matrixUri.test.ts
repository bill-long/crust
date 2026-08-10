import { describe, expect, it } from "vitest";
import { parseMatrixUri } from "./matrixUri";

describe("parseMatrixUri - matrix.to room links", () => {
	it("parses a room ID link", () => {
		expect(parseMatrixUri("https://matrix.to/#/!abc:example.org")).toEqual({
			kind: "room",
			idOrAlias: "!abc:example.org",
			viaServers: [],
		});
	});

	it("parses a percent-encoded alias link", () => {
		expect(
			parseMatrixUri("https://matrix.to/#/%23general:example.org"),
		).toEqual({
			kind: "room",
			idOrAlias: "#general:example.org",
			viaServers: [],
		});
	});

	it("collects via servers, de-duplicated, ignoring unknown params", () => {
		expect(
			parseMatrixUri(
				"https://matrix.to/#/!abc:example.org?via=s1.org&via=s2.org&via=s1.org&action=join",
			),
		).toEqual({
			kind: "room",
			idOrAlias: "!abc:example.org",
			viaServers: ["s1.org", "s2.org"],
		});
	});

	it("drops via servers that fail hostname validation", () => {
		expect(
			parseMatrixUri(
				"https://matrix.to/#/!abc:example.org?via=not a host&via=s1.org",
			),
		).toEqual({
			kind: "room",
			idOrAlias: "!abc:example.org",
			viaServers: ["s1.org"],
		});
	});

	it("caps via servers on wire-controlled hrefs", () => {
		const vias = Array.from({ length: 15 }, (_, i) => `via=s${i}.org`).join(
			"&",
		);
		const target = parseMatrixUri(
			`https://matrix.to/#/!abc:example.org?${vias}`,
		);
		expect(target?.kind).toBe("room");
		if (target?.kind !== "room") return;
		expect(target.viaServers).toHaveLength(10);
		expect(target.viaServers[0]).toBe("s0.org");
	});

	it("accepts http and case-insensitive host", () => {
		expect(parseMatrixUri("http://MATRIX.TO/#/!abc:example.org")).toEqual({
			kind: "room",
			idOrAlias: "!abc:example.org",
			viaServers: [],
		});
	});

	it("rejects a matrix.to URL without a fragment identifier", () => {
		expect(parseMatrixUri("https://matrix.to/")).toBeNull();
		expect(parseMatrixUri("https://matrix.to/#")).toBeNull();
	});

	it("rejects a room address with no server portion", () => {
		expect(parseMatrixUri("https://matrix.to/#/!abc")).toBeNull();
	});

	it("rejects malformed percent-encoding", () => {
		expect(parseMatrixUri("https://matrix.to/#/%E0%A4%A")).toBeNull();
	});
});

describe("parseMatrixUri - matrix.to event permalinks", () => {
	it("parses a room ID + event ID link", () => {
		expect(
			parseMatrixUri("https://matrix.to/#/!abc:example.org/$ev:example.org"),
		).toEqual({
			kind: "event",
			roomIdOrAlias: "!abc:example.org",
			eventId: "$ev:example.org",
			viaServers: [],
		});
	});

	it("parses an alias + event ID link with via servers", () => {
		expect(
			parseMatrixUri(
				"https://matrix.to/#/%23general:example.org/$ev:example.org?via=s1.org",
			),
		).toEqual({
			kind: "event",
			roomIdOrAlias: "#general:example.org",
			eventId: "$ev:example.org",
			viaServers: ["s1.org"],
		});
	});

	it("accepts event IDs without a server portion (v3+ rooms)", () => {
		expect(
			parseMatrixUri("https://matrix.to/#/!abc:example.org/$- barehash")?.kind,
		).not.toBe("event");
		expect(
			parseMatrixUri("https://matrix.to/#/!abc:example.org/$hashvalue"),
		).toEqual({
			kind: "event",
			roomIdOrAlias: "!abc:example.org",
			eventId: "$hashvalue",
			viaServers: [],
		});
	});

	it("rejects an event segment without the $ sigil", () => {
		expect(
			parseMatrixUri("https://matrix.to/#/!abc:example.org/ev:example.org"),
		).toBeNull();
	});

	it("rejects extra path segments", () => {
		expect(
			parseMatrixUri(
				"https://matrix.to/#/!abc:example.org/$ev:example.org/extra",
			),
		).toBeNull();
	});
});

describe("parseMatrixUri - matrix.to user links", () => {
	it("parses a user link", () => {
		expect(parseMatrixUri("https://matrix.to/#/@alice:example.org")).toEqual({
			kind: "user",
			userId: "@alice:example.org",
		});
	});

	it("rejects a user link with an event segment", () => {
		expect(
			parseMatrixUri("https://matrix.to/#/@alice:example.org/$ev:example.org"),
		).toBeNull();
	});

	it("rejects a user link without a server", () => {
		expect(parseMatrixUri("https://matrix.to/#/@alice")).toBeNull();
	});
});

describe("parseMatrixUri - matrix: URIs", () => {
	it("parses matrix:r/ as a room alias", () => {
		expect(parseMatrixUri("matrix:r/general:example.org")).toEqual({
			kind: "room",
			idOrAlias: "#general:example.org",
			viaServers: [],
		});
	});

	it("parses matrix:roomid/ as a room ID with via servers", () => {
		expect(
			parseMatrixUri("matrix:roomid/abc:example.org?via=s1.org&action=join"),
		).toEqual({
			kind: "room",
			idOrAlias: "!abc:example.org",
			viaServers: ["s1.org"],
		});
	});

	it("parses matrix:u/ as a user", () => {
		expect(parseMatrixUri("matrix:u/alice:example.org")).toEqual({
			kind: "user",
			userId: "@alice:example.org",
		});
	});

	it("parses matrix:roomid/<id>/e/<event> as an event permalink", () => {
		expect(
			parseMatrixUri("matrix:roomid/abc:example.org/e/ev:example.org"),
		).toEqual({
			kind: "event",
			roomIdOrAlias: "!abc:example.org",
			eventId: "$ev:example.org",
			viaServers: [],
		});
	});

	it("is case-insensitive on the scheme", () => {
		expect(parseMatrixUri("MATRIX:u/alice:example.org")).toEqual({
			kind: "user",
			userId: "@alice:example.org",
		});
	});

	it("rejects an event deep link under matrix:r/", () => {
		expect(
			parseMatrixUri("matrix:r/general:example.org/e/ev:example.org"),
		).toBeNull();
	});

	it("rejects unknown type segments and missing ids", () => {
		expect(parseMatrixUri("matrix:x/abc:example.org")).toBeNull();
		expect(parseMatrixUri("matrix:u/")).toBeNull();
		expect(parseMatrixUri("matrix:roomid/")).toBeNull();
	});
});

describe("parseMatrixUri - non-permalinks", () => {
	it("returns null for ordinary URLs", () => {
		expect(parseMatrixUri("https://example.org/foo")).toBeNull();
		expect(
			parseMatrixUri("https://matrix.to.evil.org/#/!abc:example.org"),
		).toBeNull();
	});

	it("returns null for other schemes and non-URLs", () => {
		expect(parseMatrixUri("mailto:a@example.org")).toBeNull();
		expect(parseMatrixUri("mxc://example.org/media")).toBeNull();
		expect(parseMatrixUri("not a url")).toBeNull();
		expect(parseMatrixUri("")).toBeNull();
		expect(parseMatrixUri("#general:example.org")).toBeNull();
	});
});
