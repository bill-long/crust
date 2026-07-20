import { describe, expect, it } from "vitest";
import {
	buildEventBlock,
	EVENT_BLOCK_KEY,
	formatEventRelative,
	formatEventTime,
	parseEventBlock,
} from "./eventBlock";

// Valid EncryptedFile fixture: the crypto material must decode to the
// sizes parseEncryptedFile enforces (key 32B, IV 16B, sha256 32B) - the
// 43-char unpadded base64 below decodes to 32 bytes.
const VALID_FILE = {
	url: "mxc://server/file",
	v: "v2",
	key: { kty: "oct", k: "A".repeat(43), alg: "A256CTR", ext: true },
	iv: "AAAAAAAAAAAAAAAAAAAAAA==",
	hashes: { sha256: "A".repeat(43) },
};

describe("parseEventBlock", () => {
	const valid = {
		title: "Game night",
		start_ts: 1785412800000,
		end_ts: 1785416400000,
		room_id: "!voice:server",
		image: {
			url: "mxc://server/img",
			info: { w: 1200, h: 480, mimetype: "image/jpeg", size: 123456 },
		},
	};

	it("parses a fully-populated block", () => {
		const info = parseEventBlock({ [EVENT_BLOCK_KEY]: valid });
		expect(info).toEqual({
			title: "Game night",
			startTs: 1785412800000,
			endTs: 1785416400000,
			roomId: "!voice:server",
			image: {
				url: "mxc://server/img",
				file: null,
				info: { w: 1200, h: 480, mimetype: "image/jpeg", size: 123456 },
			},
		});
	});

	it("returns null when the block is absent (plain poll)", () => {
		expect(parseEventBlock({})).toBeNull();
		expect(parseEventBlock({ "org.matrix.msc3381.poll.start": {} })).toBeNull();
	});

	it.each([
		["non-object block", "string"],
		["missing title", { start_ts: 1785412800000 }],
		["empty title", { title: "  ", start_ts: 1785412800000 }],
		["non-numeric start", { title: "x", start_ts: "soon" }],
		["zero start", { title: "x", start_ts: 0 }],
		["negative start", { title: "x", start_ts: -5 }],
		["NaN start", { title: "x", start_ts: Number.NaN }],
	])("degrades to a plain poll on %s", (_label, block) => {
		expect(parseEventBlock({ [EVENT_BLOCK_KEY]: block })).toBeNull();
	});

	it("drops a malformed end_ts but keeps the card", () => {
		const info = parseEventBlock({
			[EVENT_BLOCK_KEY]: {
				title: "x",
				start_ts: 100,
				end_ts: 50, // before start
			},
		});
		expect(info?.endTs).toBeNull();
		const info2 = parseEventBlock({
			[EVENT_BLOCK_KEY]: { title: "x", start_ts: 100, end_ts: "later" },
		});
		expect(info2?.endTs).toBeNull();
	});

	it("rejects a non-room room_id but keeps the card", () => {
		const info = parseEventBlock({
			[EVENT_BLOCK_KEY]: {
				title: "x",
				start_ts: 100,
				room_id: "@user:server",
			},
		});
		expect(info?.roomId).toBeNull();
	});

	it("accepts a valid encrypted image (file wins over url)", () => {
		const info = parseEventBlock({
			[EVENT_BLOCK_KEY]: {
				title: "x",
				start_ts: 100,
				image: {
					url: "mxc://server/plain",
					file: VALID_FILE,
					info: { w: 10, h: 10, mimetype: "image/png", size: 99 },
				},
			},
		});
		expect(info?.image?.file?.url).toBe("mxc://server/file");
		// url is still carried for reference but the renderer prefers file.
		expect(info?.image?.url).toBe("mxc://server/plain");
	});

	it.each([
		["zero width", { w: 0, h: 10, mimetype: "image/png", size: 1 }],
		["negative height", { w: 10, h: -1, mimetype: "image/png", size: 1 }],
		["non-image mimetype", { w: 10, h: 10, mimetype: "text/html", size: 1 }],
		["zero size", { w: 10, h: 10, mimetype: "image/png", size: 0 }],
		["huge dimension", { w: 999_999, h: 10, mimetype: "image/png", size: 1 }],
	])("drops an image with %s", (_label, info) => {
		const parsed = parseEventBlock({
			[EVENT_BLOCK_KEY]: {
				title: "x",
				start_ts: 100,
				image: { url: "mxc://server/img", info },
			},
		});
		expect(parsed?.image).toBeNull();
		// The card itself survives the poisoned image.
		expect(parsed?.title).toBe("x");
	});

	it("drops an image with neither url nor file", () => {
		const parsed = parseEventBlock({
			[EVENT_BLOCK_KEY]: {
				title: "x",
				start_ts: 100,
				image: {
					url: "https://evil.example/x.png",
					info: { w: 10, h: 10, mimetype: "image/png", size: 1 },
				},
			},
		});
		expect(parsed?.image).toBeNull();
	});

	it("drops an encrypted file whose ciphertext url is not mxc://", () => {
		const parsed = parseEventBlock({
			[EVENT_BLOCK_KEY]: {
				title: "x",
				start_ts: 100,
				image: {
					file: { ...VALID_FILE, url: "https://evil.example/cipher" },
					info: { w: 10, h: 10, mimetype: "image/png", size: 1 },
				},
			},
		});
		// No usable source left -> the whole image degrades; the card
		// itself survives.
		expect(parsed?.image).toBeNull();
		expect(parsed?.title).toBe("x");
	});

	it("drops an image whose file fails EncryptedFile validation", () => {
		const parsed = parseEventBlock({
			[EVENT_BLOCK_KEY]: {
				title: "x",
				start_ts: 100,
				image: {
					file: { url: "mxc://server/f" }, // missing key/iv/hashes
					info: { w: 10, h: 10, mimetype: "image/png", size: 1 },
				},
			},
		});
		expect(parsed?.image).toBeNull();
	});
});

describe("buildEventBlock", () => {
	it("round-trips through parseEventBlock", () => {
		const input = {
			title: "Game night",
			startTs: 1785412800000,
			endTs: 1785416400000,
			roomId: "!voice:server",
			image: {
				url: "mxc://server/img",
				info: { w: 1200, h: 480, mimetype: "image/jpeg", size: 123456 },
			},
		};
		const wire = buildEventBlock(input);
		expect(parseEventBlock({ [EVENT_BLOCK_KEY]: wire })).toEqual({
			title: "Game night",
			startTs: 1785412800000,
			endTs: 1785416400000,
			roomId: "!voice:server",
			image: {
				url: "mxc://server/img",
				file: null,
				info: { w: 1200, h: 480, mimetype: "image/jpeg", size: 123456 },
			},
		});
	});

	it("emits nulls for absent optionals and omits image entirely", () => {
		const wire = buildEventBlock({ title: "x", startTs: 100 });
		expect(wire).toEqual({
			title: "x",
			start_ts: 100,
			end_ts: null,
			room_id: null,
		});
	});
});

describe("formatEventTime", () => {
	it("renders a local time string (locale- and timezone-stable)", () => {
		// Noon UTC on a known date. Assert against the runner's OWN locale
		// data (via Intl) rather than hard-coded English, so the test holds
		// under any LC_ALL.
		const ts = Date.UTC(2026, 6, 26, 12, 0);
		const s = formatEventTime(ts);
		const month = new Intl.DateTimeFormat(undefined, {
			month: "short",
		}).format(new Date(ts));
		// Day as a Latin-digit regex would flake in numeral-system locales
		// (e.g. ar-EG renders 26 as ٢٦) - derive it from Intl too.
		const day = new Intl.DateTimeFormat(undefined, {
			day: "numeric",
		}).format(new Date(ts));
		expect(s).toContain(month);
		expect(s).toContain(day);
	});
});

describe("formatEventRelative", () => {
	const now = Date.UTC(2026, 6, 19, 12, 0, 0);
	// Expected strings come from the same Intl API the implementation
	// uses, so the tests are stable under non-English locales.
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

	it("counts down to a future start", () => {
		expect(formatEventRelative(now + 3_600_000, null, now)).toBe(
			rtf.format(1, "hour"),
		);
		expect(formatEventRelative(now + 3 * 86_400_000, null, now)).toBe(
			rtf.format(3, "day"),
		);
	});

	it("reads 'starting now' within a minute of start", () => {
		expect(formatEventRelative(now + 30_000, null, now)).toBe("Starting now");
		expect(formatEventRelative(now - 30_000, null, now)).toBe("Starting now");
	});

	it("reports elapsed time after start when no end is set", () => {
		expect(formatEventRelative(now - 2 * 3_600_000, null, now)).toBe(
			rtf.format(-2, "hour"),
		);
	});

	it("reports Ended once end_ts passes", () => {
		expect(formatEventRelative(now - 3_600_000, now - 60_000, now)).toBe(
			"Ended",
		);
	});

	it("still counts down when an end is set in the future", () => {
		expect(formatEventRelative(now + 3_600_000, now + 7_200_000, now)).toBe(
			"in 1 hour",
		);
	});
});
