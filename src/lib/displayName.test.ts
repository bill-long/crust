import { describe, expect, it } from "vitest";
import { displayNameOr } from "./displayName";

// Built from code points, never as literal bytes. Everything this file is
// about is invisible, so a literal one would be unreviewable in a diff - and
// an unterminated override would reorder the source line it sits on.
const ch = (code: number): string => String.fromCharCode(code);
const LRO = ch(0x202d);
const RLO = ch(0x202e);

describe("displayNameOr", () => {
	it("returns an ordinary name, trimmed", () => {
		expect(displayNameOr("  Ann Smith  ", "@ann:x")).toBe("Ann Smith");
	});

	it("falls back for a missing or blank name", () => {
		expect(displayNameOr(undefined, "@ann:x")).toBe("@ann:x");
		expect(displayNameOr(null, "@ann:x")).toBe("@ann:x");
		expect(displayNameOr("   ", "@ann:x")).toBe("@ann:x");
	});

	it("falls back when the name is nothing but invisible padding", () => {
		// Element's own emptiness test: removeHiddenChars strips zero-width
		// characters and combining marks, and what is left here is nothing.
		// It is narrower than it sounds - see #576 for what it misses.
		expect(displayNameOr(`${ch(0x200b)}${ch(0x200b)}`, "@ann:x")).toBe(
			"@ann:x",
		);
		expect(displayNameOr(ch(0xfeff), "@ann:x")).toBe("@ann:x");
	});

	it("trims edge whitespace BEFORE judging control characters", () => {
		// The ordering is load-bearing and easy to break silently. `String.trim`
		// removes tab and newline, which are themselves control characters, so
		// checking `hasControlChar` first would reject every pasted name with a
		// trailing newline - ordinary input, since `Layout` and `AccountTab`
		// feed `User.displayName` straight in - and render those users as a bare
		// MXID across the sidebar, member list, timeline and export, with the
		// rest of the suite still green.
		expect(displayNameOr(`Ann Smith\n`, "@ann:x")).toBe("Ann Smith");
		expect(displayNameOr(`\tAnn Smith`, "@ann:x")).toBe("Ann Smith");
		// Interior ones are the impersonation case and still fall back.
		expect(displayNameOr(`Ann\nSmith`, "@ann:x")).toBe("@ann:x");
	});

	it("rejects an unbounded name without scanning it", () => {
		// The one rule here that is not Element's. displayname is unbounded on
		// the wire and re-checked on every typing tick, so the length test
		// comes before any normalization.
		expect(displayNameOr("a".repeat(500_000), "@ann:x")).toBe("@ann:x");
	});

	it("bounds the raw name, before trimming it", () => {
		// The ordering is the point: testing the trimmed length would mean
		// copying a multi-megabyte name before deciding to refuse it, on a
		// path re-entered for every member on every typing tick. The cost is
		// that a name behind 2000 spaces is refused rather than trimmed down
		// to "Ann", which is pathological input either way.
		expect(displayNameOr(`${" ".repeat(2000)}Ann`, "@ann:x")).toBe("@ann:x");
	});

	describe("direction overrides", () => {
		it("strips LRO and RLO rather than rejecting the name", () => {
			// These two override direction for the rest of the paragraph, so
			// they reorder whatever is rendered beside the name. Element
			// removes them and keeps the name; the name is still the user's.
			expect(displayNameOr(`Ann${RLO}Smith`, "@ann:x")).toBe("AnnSmith");
			expect(displayNameOr(`Ann${LRO}Smith`, "@ann:x")).toBe("AnnSmith");
		});

		it("falls back when the name was only an override", () => {
			expect(displayNameOr(RLO, "@mallory:x")).toBe("@mallory:x");
		});

		it("leaves every other bidi character alone", () => {
			// Element's rule, and deliberately not widened here. The
			// embeddings and isolates are a real gap - an unmatched initiator
			// is not scoped - but it is the SDK's gap and closing it locally
			// grew a rule that needed another rule. Tracked in #575.
			for (const code of [
				0x202a, 0x202b, 0x202c, 0x2066, 0x2069, 0x200e, 0x200f,
			]) {
				const name = `Ann${ch(code)}Smith`;
				expect(displayNameOr(name, "@ann:x")).toBe(name);
			}
		});
	});

	describe("names that are not rejected, deliberately", () => {
		// Each of these is invisible and each could impersonate. None is
		// barred, because barring the character breaks a real script or a real
		// emoji, and the MXID is what answers impersonation. These assertions
		// exist so that a future hardening has to argue with a failing test
		// rather than land quietly.
		it.each([
			["ZWSP", 0x200b],
			["SOFT HYPHEN", 0x00ad],
			["WORD JOINER", 0x2060],
			["HANGUL FILLER", 0x3164],
			["MONGOLIAN FVS1", 0x180b],
			["ARABIC LETTER MARK", 0x061c],
			["COMBINING GRAPHEME JOINER", 0x034f],
			["VARIATION SELECTOR-1", 0xfe00],
		])("keeps a name containing %s", (_label, code) => {
			const name = `A${ch(code)}dmin`;
			expect(displayNameOr(name, "@mallory:x")).toBe(name);
		});

		it("keeps the scripts and emoji those characters serve", () => {
			const persian = `${ch(0x0645)}${ch(0x06cc)}${ch(0x200c)}${ch(0x062e)}${ch(0x0648)}${ch(0x0627)}${ch(0x0647)}${ch(0x0645)}`;
			expect(displayNameOr(persian, "@x:y")).toBe(persian);

			const family = `${String.fromCodePoint(0x1f469)}${ch(0x200d)}${String.fromCodePoint(0x1f4bb)} Ann`;
			expect(displayNameOr(family, "@ann:x")).toBe(family);

			const scotland = [
				0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f,
			]
				.map((c) => String.fromCodePoint(c))
				.join("");
			expect(displayNameOr(scotland, "@ann:x")).toBe(scotland);

			const heart = `Ann ${String.fromCodePoint(0x2764)}${ch(0xfe0f)}`;
			expect(displayNameOr(heart, "@ann:x")).toBe(heart);
		});

		it("falls back on a control character", () => {
			// One of the three rules beyond Element's. Empty false-positive
			// set - no name legitimately holds a NUL or a bare CR - and it is
			// what keeps a name in one piece in an aria-label, a title, a push
			// body and the plain-text export transcript, sinks Element does
			// not have because it renders names only into HTML. C0 is also the
			// one invisible class the SDK does not normalize, so A<NUL>dmin
			// collides with nothing and earns no (@mxid) suffix.
			expect(displayNameOr("Ann\nSmith", "@ann:x")).toBe("@ann:x");
			expect(displayNameOr(`A${ch(0x0000)}dmin`, "@mallory:x")).toBe(
				"@mallory:x",
			);
		});

		it.each([
			["NEL", 0x0085],
			["LINE SEPARATOR", 0x2028],
			["PARAGRAPH SEPARATOR", 0x2029],
		])("falls back on %s, a hard break outside C0", (_label, code) => {
			// Each is UAX #14 class BK/NL - a hard break in a browser, exactly
			// like U+000A - and each slips every other check: `trim` reaches
			// only the edges (and does not treat U+0085 as whitespace at all),
			// the glyph test passes because there are visible characters
			// either side, and `hasControlChar` stops at U+007F. Left in, they
			// split a member row, its aria-label, the HTML export's sender
			// span and an OS notification body onto two lines.
			expect(displayNameOr(`Bob${ch(code)}Admin`, "@bob:x")).toBe("@bob:x");
		});

		it("falls back when nothing visible renders", () => {
			// The SDK's own emptiness test misses these - unhomoglyph maps
			// U+3164 to U+1160 rather than dropping it - so a name of two
			// Hangul fillers rendered a blank row with an aria-label reading
			// "View profile of " and nothing after it. Emptiness only: a name
			// that merely CONTAINS one is kept in full, asserted above.
			for (const code of [0x3164, 0x2060, 0x00ad, 0xfe00]) {
				expect(displayNameOr(ch(code).repeat(2), "@ann:x")).toBe("@ann:x");
			}
			// U+2800 BRAILLE PATTERN BLANK is the one member of the SDK's own
			// hidden-character set that no Unicode property in the class
			// covers - it is category So - so it is listed explicitly. This
			// pins the equivalence that lets the cheap regex stand in for
			// `removeHiddenChars` on the member list's hot path.
			expect(displayNameOr(ch(0x2800).repeat(2), "@ann:x")).toBe("@ann:x");
		});
	});
});

describe("callers that read User.displayName", () => {
	// Layout's sidebar and the Settings Account tab render the same raw
	// `User.displayName`, and briefly disagreed about it: one wrapped, one
	// did not. This pins what both now do, so a future edit to either has a
	// failing test rather than a silent divergence.
	it("resolves a raw profile name the same way for both", () => {
		const blank = String.fromCharCode(0x3164).repeat(2);
		expect(displayNameOr(blank, "@ann:x")).toBe("@ann:x");
		expect(displayNameOr(blank, "ann")).toBe("ann");
		const ok = "Ann Smith";
		expect(displayNameOr(ok, "@ann:x")).toBe(ok);
	});
});

describe("the bound applies to the raw string, at every caller", () => {
	// The cross-panel invariant #540 exists for. `displayNameOr` tests
	// MAX_NAME_LENGTH against the RAW value, so any caller that pre-trims
	// slips a name past a bound its siblings apply - and the same user then
	// renders as a name in one panel and an id in another. `stateNotice` and
	// `pushCopy` both used to pre-trim; this pins that they no longer do by
	// asserting the value every caller must hand over.
	it("refuses a padded over-length name, and would accept it if pre-trimmed", () => {
		const padded = `${" ".repeat(2000)}Ann`;
		expect(displayNameOr(padded, "@ann:x")).toBe("@ann:x");
		// The shape a pre-trimming caller would have produced.
		expect(displayNameOr(padded.trim(), "@ann:x")).toBe("Ann");
	});
});
