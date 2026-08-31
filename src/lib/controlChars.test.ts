import { describe, expect, it } from "vitest";
import {
	hasControlChar,
	hasLineBreaker,
	stripControlChars,
	stripLineBreakers,
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

describe("line breakers", () => {
	const NEL = String.fromCharCode(0x85);
	const LS = String.fromCharCode(0x2028);
	const PS = String.fromCharCode(0x2029);

	it("finds the hard breaks above DEL that hasControlChar misses", () => {
		// UAX #14 class BK/NL - hard breaks in a browser, exactly like U+000A -
		// but above DEL, so the control-character predicate does not see them.
		for (const ch of [NEL, LS, PS]) {
			expect(hasControlChar(`Bob${ch}Admin`)).toBe(false);
			expect(hasLineBreaker(`Bob${ch}Admin`)).toBe(true);
		}
		expect(hasLineBreaker(`Bob${String.fromCharCode(0x0a)}Admin`)).toBe(true);
		expect(hasLineBreaker("Bob Admin")).toBe(false);
	});

	it("strips them while keeping the rest of the text", () => {
		// The single-line sink escape: keep the text, lose only what would
		// force a second line.
		expect(stripLineBreakers(`Bob${LS}Security: verify`)).toBe(
			"BobSecurity: verify",
		);
		expect(
			stripLineBreakers(`a${NEL}b${PS}c${String.fromCharCode(0x0a)}d`),
		).toBe("abcd");
	});

	it("leaves stripControlChars alone, which is the filename rule", () => {
		// A filename with U+2028 is odd but harmless; a heading with one
		// silently becomes two lines. Different rules, deliberately.
		expect(stripControlChars(`report${LS}2026.pdf`)).toBe(
			`report${LS}2026.pdf`,
		);
	});
});
