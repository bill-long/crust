import { describe, expect, it } from "vitest";
import {
	displayNameOr,
	hasControlChar,
	stripControlChars,
} from "./controlChars";

// Written as escapes, never as literal bytes. A raw control character in a
// source file is invisible in a diff and in any review UI, survives until
// some editor or normalisation step silently eats it, and then the test
// asserts something else entirely with no sign of why.
const SOH = "\u0001";
const DEL = "\u007f";

describe("hasControlChar", () => {
	it("finds C0 characters and DEL", () => {
		expect(hasControlChar(`a${SOH}b`)).toBe(true);
		expect(hasControlChar(`a${DEL}b`)).toBe(true);
		expect(hasControlChar("line\nbreak")).toBe(true);
	});

	it("passes ordinary text, including astral characters", () => {
		expect(hasControlChar("Ann Smith")).toBe(false);
		expect(hasControlChar("\u{1F600}")).toBe(false);
	});
});

describe("stripControlChars", () => {
	it("removes them and leaves the rest intact", () => {
		expect(stripControlChars("Ann\nSmith")).toBe("AnnSmith");
	});
});

describe("displayNameOr", () => {
	it("returns an ordinary name, trimmed", () => {
		expect(displayNameOr("  Ann Smith  ", "@ann:x")).toBe("Ann Smith");
	});

	it("keeps a name that arrives behind padding", () => {
		// Trimming rather than windowing is what makes this work: a
		// sanitiser that took a fixed slice first would spend its budget on
		// the padding and silently render nothing at all.
		expect(displayNameOr(`${" ".repeat(200)}Ann Smith  `, "@ann:x")).toBe(
			"Ann Smith",
		);
	});

	it("falls back when even the padding is abusive", () => {
		// Past the bound the whole value is refused rather than searched.
		// The bound is 1024; Synapse caps a real name at 256. This fails
		// closed and visibly, where a silent empty string would not.
		expect(displayNameOr(`${" ".repeat(2000)}Ann`, "@ann:x")).toBe("@ann:x");
	});

	it("falls back rather than cleaning a name with control characters", () => {
		// Cleaning is not safe here. `RoomMember.name` is disambiguated by
		// the SDK against the raw displayname map, so `A<SOH>dmin` is not
		// seen as a duplicate of the real `Admin` and gets no user-ID
		// suffix - and stripping would then render exactly `Admin`.
		expect(displayNameOr(`A${SOH}dmin`, "@mallory:x")).toBe("@mallory:x");
	});

	it("falls back for a missing or blank name", () => {
		expect(displayNameOr(undefined, "@ann:x")).toBe("@ann:x");
		expect(displayNameOr(null, "@ann:x")).toBe("@ann:x");
		expect(displayNameOr("   ", "@ann:x")).toBe("@ann:x");
	});

	it("keeps a name whose only control character is edge whitespace", () => {
		// `trim` removes tab and newline, which are themselves control
		// characters - so judging before trimming rejected a perfectly good
		// pasted name and rendered the bare MXID. The poll watcher trims
		// before calling this, so it also made the same user render two
		// different ways in two panels.
		expect(displayNameOr("Ann Smith\n", "@ann:x")).toBe("Ann Smith");
		expect(displayNameOr("\tAnn Smith", "@ann:x")).toBe("Ann Smith");
	});

	it("still rejects a control character inside the name", () => {
		// Trimming must not reach the interior, which is where the
		// impersonation case lives.
		expect(displayNameOr(`Ann${SOH}Smith`, "@ann:x")).toBe("@ann:x");
	});

	it("rejects an unbounded name without scanning it", () => {
		// `displayname` is unbounded on the wire and re-checked for every
		// member on every membership or typing event, so the length test has
		// to come before the scan.
		expect(displayNameOr("a".repeat(500_000), "@ann:x")).toBe("@ann:x");
	});
});
