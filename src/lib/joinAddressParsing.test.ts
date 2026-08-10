import { describe, expect, it } from "vitest";
import { formatJoinAddress, parseJoinAddress } from "./joinAddressParsing";

describe("parseJoinAddress", () => {
	it("parses a bare alias", () => {
		expect(parseJoinAddress("#general:example.org")).toEqual({
			ok: true,
			address: { idOrAlias: "#general:example.org", viaServers: [] },
		});
	});

	it("trims surrounding whitespace", () => {
		expect(parseJoinAddress("  #general:example.org \n")).toEqual({
			ok: true,
			address: { idOrAlias: "#general:example.org", viaServers: [] },
		});
	});

	it("parses a bare room ID", () => {
		expect(parseJoinAddress("!abc123:example.org")).toEqual({
			ok: true,
			address: { idOrAlias: "!abc123:example.org", viaServers: [] },
		});
	});

	it("parses a room ID with trailing via servers", () => {
		expect(
			parseJoinAddress("!abc123:example.org one.org two.org:8448"),
		).toEqual({
			ok: true,
			address: {
				idOrAlias: "!abc123:example.org",
				viaServers: ["one.org", "two.org:8448"],
			},
		});
	});

	it("dedupes repeated via servers", () => {
		const r = parseJoinAddress("!abc123:example.org one.org one.org");
		expect(r).toEqual({
			ok: true,
			address: {
				idOrAlias: "!abc123:example.org",
				viaServers: ["one.org"],
			},
		});
	});

	it("parses a matrix.to room-ID link with via params", () => {
		expect(
			parseJoinAddress(
				"https://matrix.to/#/!abc123:example.org?via=one.org&via=two.org",
			),
		).toEqual({
			ok: true,
			address: {
				idOrAlias: "!abc123:example.org",
				viaServers: ["one.org", "two.org"],
			},
		});
	});

	it("parses a matrix.to alias link (percent-encoded #)", () => {
		expect(
			parseJoinAddress("https://matrix.to/#/%23general:example.org"),
		).toEqual({
			ok: true,
			address: { idOrAlias: "#general:example.org", viaServers: [] },
		});
	});

	it("parses a matrix.to link without the scheme", () => {
		expect(parseJoinAddress("matrix.to/#/!abc123:example.org")).toEqual({
			ok: true,
			address: { idOrAlias: "!abc123:example.org", viaServers: [] },
		});
	});

	it("ignores non-via query params", () => {
		expect(
			parseJoinAddress(
				"https://matrix.to/#/!abc123:example.org?action=join&via=one.org",
			),
		).toEqual({
			ok: true,
			address: {
				idOrAlias: "!abc123:example.org",
				viaServers: ["one.org"],
			},
		});
	});

	it("rejects empty input", () => {
		expect(parseJoinAddress("   ")).toEqual({
			ok: false,
			error: "Enter a room address or link (e.g. #general:example.org).",
		});
	});

	it("rejects an address without a sigil", () => {
		const r = parseJoinAddress("general:example.org");
		expect(r).toEqual({
			ok: false,
			error: "Room address must start with # (alias) or ! (room ID).",
		});
	});

	it("rejects an address without a server", () => {
		const r = parseJoinAddress("#general");
		expect(r).toEqual({
			ok: false,
			error: "Room address must include a server (e.g. #general:example.org).",
		});
	});

	it("rejects an empty localpart", () => {
		const r = parseJoinAddress("#:example.org");
		expect(r).toEqual({
			ok: false,
			error: "Room address is missing a name before the ':'.",
		});
	});

	it("rejects an invalid server portion", () => {
		const r = parseJoinAddress("#general:example.org/");
		expect(r).toEqual({
			ok: false,
			error: "Server portion is not a valid hostname.",
		});
	});

	it("rejects an invalid via server in the bare form", () => {
		const r = parseJoinAddress("!abc123:example.org one.org/");
		expect(r).toEqual({
			ok: false,
			error: '"one.org/" is not a valid server name.',
		});
	});

	it("rejects an invalid via server in a matrix.to link", () => {
		expect(
			parseJoinAddress("https://matrix.to/#/!abc123:example.org?via=one.org/"),
		).toEqual({
			ok: false,
			error: 'Via server "one.org/" is not a valid hostname.',
		});
	});

	it("rejects invalid characters in the localpart", () => {
		// A bare form tokenizes on whitespace, so a space in the localpart is
		// only reachable via a percent-encoded matrix.to link.
		expect(parseJoinAddress("https://matrix.to/#/!ab%20c:example.org")).toEqual(
			{
				ok: false,
				error: "Room address contains invalid characters.",
			},
		);
	});

	it("rejects a malformed percent-encoding in a via param", () => {
		expect(
			parseJoinAddress("https://matrix.to/#/!abc123:example.org?via=%zz"),
		).toEqual({
			ok: false,
			error: "That matrix.to link is malformed.",
		});
	});

	it("points bare user IDs at New direct message", () => {
		const r = parseJoinAddress("@alice:example.org");
		expect(r).toEqual({
			ok: false,
			error: "That's a user ID - use New direct message instead.",
		});
	});

	it("points matrix.to user links at New direct message", () => {
		const r = parseJoinAddress("https://matrix.to/#/@alice:example.org");
		expect(r).toEqual({
			ok: false,
			error: "That's a user link - use New direct message instead.",
		});
	});

	it("rejects a malformed percent-encoding in a matrix.to link", () => {
		const r = parseJoinAddress("https://matrix.to/#/%zz:example.org");
		expect(r).toEqual({
			ok: false,
			error: "That matrix.to link is malformed.",
		});
	});
});

describe("formatJoinAddress", () => {
	it("formats a bare alias with no via servers", () => {
		expect(
			formatJoinAddress({ idOrAlias: "#general:example.org", viaServers: [] }),
		).toBe("#general:example.org");
	});

	it("appends via servers as trailing tokens", () => {
		expect(
			formatJoinAddress({
				idOrAlias: "!abc123:example.org",
				viaServers: ["one.org", "two.org:8448"],
			}),
		).toBe("!abc123:example.org one.org two.org:8448");
	});

	it("round-trips through parseJoinAddress", () => {
		const address = {
			idOrAlias: "!abc123:example.org",
			viaServers: ["one.org", "two.org"],
		};
		expect(parseJoinAddress(formatJoinAddress(address))).toEqual({
			ok: true,
			address,
		});
	});
});
