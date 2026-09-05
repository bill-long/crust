import type { MatrixClient, MatrixEvent, RoomMember } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	buildReplySnippet,
	capStoreToRealLimit,
	isSyntheticEventId,
	mergeRowsByTimestamp,
	normalizeReason,
	sanitizeMultiline,
	senderProfileFields,
	syntheticCallLeaveId,
} from "./timelineHelpers";
import type { TimelineEvent } from "./timelineTypes";

// Code points, never literal characters - an unterminated one would reorder
// the source line it sits on.
const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const CAMERA = String.fromCodePoint(0x1f4f7);
const MOVIE_CAMERA = String.fromCodePoint(0x1f3ac);
const MICROPHONE = String.fromCodePoint(0x1f3a4);
const SPEAKER = String.fromCodePoint(0x1f50a);
const PAPERCLIP = String.fromCodePoint(0x1f4ce);

function fileEvent(content: Record<string, unknown>): MatrixEvent {
	return event("m.room.message", { msgtype: "m.file", ...content });
}

function event(type: string, content: Record<string, unknown>): MatrixEvent {
	return {
		getContent: () => content,
		getType: () => type,
	} as unknown as MatrixEvent;
}

function row(eventId: string, timestamp: number): TimelineEvent {
	return { eventId, timestamp } as unknown as TimelineEvent;
}

describe("senderProfileFields", () => {
	it("resolves a member name and requests a 48px cropped avatar", () => {
		const mxcUrlToHttp = vi.fn(() => "https://media.example/avatar");
		const client = { mxcUrlToHttp } as unknown as MatrixClient;
		const member = {
			name: "Alice",
			getMxcAvatarUrl: () => "mxc://example/avatar",
		} as unknown as RoomMember;

		expect(senderProfileFields(client, member, "@alice:example.org")).toEqual({
			name: "Alice",
			avatarUrl: "https://media.example/avatar",
		});
		expect(mxcUrlToHttp).toHaveBeenCalledWith(
			"mxc://example/avatar",
			48,
			48,
			"crop",
		);
	});

	it("falls back to the sender ID without a member", () => {
		const mxcUrlToHttp = vi.fn();
		const client = { mxcUrlToHttp } as unknown as MatrixClient;

		expect(senderProfileFields(client, null, "@missing:example.org")).toEqual({
			name: "@missing:example.org",
			avatarUrl: null,
		});
		expect(mxcUrlToHttp).not.toHaveBeenCalled();
	});
});

describe("sanitizeMultiline", () => {
	it("normalizes carriage returns while retaining line feeds", () => {
		expect(sanitizeMultiline("one\r\ntwo\rthree\nfour")).toBe(
			"one\ntwo\nthree\nfour",
		);
	});

	it("strips non-newline controls without damaging surrounding text", () => {
		expect(sanitizeMultiline(`a${NUL}b\tc${DEL}d\ne`)).toBe("abcd\ne");
	});
});

describe("buildReplySnippet for an attachment", () => {
	it("derives the name through the same rule as the chip, bidi controls stripped", () => {
		// A reply quote sits one line above the chip that now shows the real
		// extension; it must not show the spoofed one.
		expect(
			buildReplySnippet(
				fileEvent({
					body: `invoice${RLO}gnp.exe`,
					filename: `invoice${RLO}gnp.exe`,
				}),
			),
		).toBe("📎 invoicegnp.exe");
	});

	it("names the attachment exactly as the chip does, including no name", () => {
		// The same selection rule as the projection: an empty explicit
		// filename yields to the body, a control-bearing one is refused and
		// does NOT yield, so the snippet and the chip agree on "no name".
		expect(
			buildReplySnippet(fileEvent({ body: "report.pdf", filename: "  " })),
		).toBe("📎 report.pdf");
		expect(
			buildReplySnippet(
				fileEvent({ body: "report.pdf", filename: `a${NUL}b.pdf` }),
			),
		).toBe("📎 File");
		expect(buildReplySnippet(fileEvent({ body: `a${NUL}b.pdf` }))).toBe(
			"📎 File",
		);
	});
});

describe("buildReplySnippet", () => {
	it.each([
		["m.sticker", {}, "Sticker"],
		["m.room.message", { msgtype: "m.image" }, `${CAMERA} Image`],
		["m.room.message", { msgtype: "m.video" }, `${MOVIE_CAMERA} Video`],
		["m.room.message", { msgtype: "m.audio" }, `${SPEAKER} Audio`],
	])(
		"builds the expected media placeholder for %s",
		(type, content, expected) => {
			expect(buildReplySnippet(event(type, content))).toBe(expected);
		},
	);

	it("distinguishes voice messages from ordinary audio", () => {
		expect(
			buildReplySnippet(
				event("m.room.message", {
					msgtype: "m.audio",
					"org.matrix.msc3245.voice": {},
				}),
			),
		).toBe(`${MICROPHONE} Voice message`);
	});

	it("uses a readable poll question before other fallback text", () => {
		const poll = event("m.poll.start", {
			body: "legacy fallback",
			"m.poll.start": {
				question: { "m.text": "  Which option?  " },
			},
		});

		expect(buildReplySnippet(poll)).toBe("Poll: Which option?");
	});

	it("strips a reply fallback and keeps only the first reply line", () => {
		const body =
			"> <@alice:example.org> quoted\n\n  actual reply  \nsecond line";

		expect(
			buildReplySnippet(event("m.room.message", { msgtype: "m.text", body })),
		).toBe("actual reply");
	});

	it("tolerates a missing body and strips controls from text", () => {
		expect(buildReplySnippet(event("m.room.message", {}))).toBe("");
		expect(
			buildReplySnippet(event("m.room.message", { body: `safe${NUL} text` })),
		).toBe("safe text");
	});

	it("caps long snippets after sanitation", () => {
		const snippet = buildReplySnippet(
			event("m.room.message", { body: "x".repeat(101) }),
		);

		expect(snippet).toBe(`${"x".repeat(100)}…`);
	});

	it("uses the generic file placeholder when no filename is readable", () => {
		expect(buildReplySnippet(fileEvent({ body: "" }))).toBe(
			`${PAPERCLIP} File`,
		);
	});
});

describe("synthetic event IDs", () => {
	it("encodes variable segments and recognizes only the reserved prefix", () => {
		const id = syntheticCallLeaveId({
			userId: "@alice:example.org",
			deviceId: "phone:one",
			expiresAt: 1234,
		});

		expect(id).toBe(
			"~call-expiry-leave:%40alice%3Aexample.org:phone%3Aone:1234",
		);
		expect(isSyntheticEventId(id)).toBe(true);
		expect(isSyntheticEventId("$real-event")).toBe(false);
	});

	it("keeps ambiguous user/device colon placements collision-free", () => {
		const first = syntheticCallLeaveId({
			userId: "@a:b:c",
			deviceId: "d",
			expiresAt: 1,
		});
		const second = syntheticCallLeaveId({
			userId: "@a:b",
			deviceId: "c:d",
			expiresAt: 1,
		});

		expect(first).not.toBe(second);
	});
});

describe("capStoreToRealLimit", () => {
	it("trims through the oldest excess real row and its leading synthetic rows", () => {
		const rows = [
			row("~call-expiry-leave:before", 0),
			row("$one", 1),
			row("~call-expiry-leave:between", 2),
			row("$two", 3),
			row("$three", 4),
		];

		capStoreToRealLimit(rows, 2);

		expect(rows.map((entry) => entry.eventId)).toEqual([
			"~call-expiry-leave:between",
			"$two",
			"$three",
		]);
	});

	it("removes every row through the last real event when the limit is zero", () => {
		const rows = [
			row("$one", 1),
			row("~call-expiry-leave:between", 2),
			row("$two", 3),
		];

		capStoreToRealLimit(rows, 0);

		expect(rows).toEqual([]);
	});

	it("does not trim when the real-row count is within the limit", () => {
		const rows = [row("~call-expiry-leave:only", 1), row("$real", 2)];

		capStoreToRealLimit(rows, 1);

		expect(rows.map((entry) => entry.eventId)).toEqual([
			"~call-expiry-leave:only",
			"$real",
		]);
	});
});

describe("mergeRowsByTimestamp", () => {
	it("orders inserts around base rows, placing timestamp ties after the base", () => {
		const base = [row("$base-1", 10), row("$base-2", 20)];
		const inserts = [
			row("~call-expiry-leave:early", 5),
			row("~call-expiry-leave:tied", 20),
			row("~call-expiry-leave:late", 30),
		];

		const merged = mergeRowsByTimestamp(base, inserts);

		expect(merged.map((entry) => entry.eventId)).toEqual([
			"~call-expiry-leave:early",
			"$base-1",
			"$base-2",
			"~call-expiry-leave:tied",
			"~call-expiry-leave:late",
		]);
		expect(base.map((entry) => entry.eventId)).toEqual(["$base-1", "$base-2"]);
		expect(inserts.map((entry) => entry.timestamp)).toEqual([5, 20, 30]);
	});

	it("returns a shallow base copy when there are no inserts", () => {
		const base = [row("$base", 10)];
		const merged = mergeRowsByTimestamp(base, []);

		expect(merged).toEqual(base);
		expect(merged).not.toBe(base);
	});
});

describe("normalizeReason", () => {
	it("trims a non-empty reason", () => {
		expect(normalizeReason("  off topic  ")).toBe("off topic");
	});

	it("omits missing and effectively empty reasons", () => {
		expect(normalizeReason(undefined)).toBeUndefined();
		expect(normalizeReason(" \n\t ")).toBeUndefined();
	});
});
