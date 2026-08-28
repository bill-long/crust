import { describe, expect, it } from "vitest";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import {
	assembleHtml,
	assembleJson,
	assembleText,
	type ExportBundle,
	type ExportRow,
	htmlRow,
	jsonRow,
	textRow,
} from "./serializers";

function row(
	overrides: Parameters<typeof makeTimelineEvent>[0] = {},
	extra: Partial<ExportRow> = {},
): ExportRow {
	const te = makeTimelineEvent(overrides);
	return {
		te,
		bodyText: te.body,
		undecryptable: false,
		attachmentPath: null,
		attachmentFailed: false,
		...extra,
	};
}

function bundle(count = 1, encrypted = false): ExportBundle {
	return {
		roomId: "!room:example.com",
		roomName: "Test Room",
		exportedAt: new Date("2026-08-27T12:00:00Z"),
		rangeLabel: "last 100 messages",
		encryptedRoom: encrypted,
		messageCount: count,
		mxcToHttp: (mxc) => `https://hs.example/media/${mxc.slice(6)}`,
	};
}

function jsonOf(
	rows: ExportRow[],
	encrypted = false,
): ReturnType<JSON["parse"]> {
	return JSON.parse(
		assembleJson(bundle(rows.length, encrypted), rows.map(jsonRow)),
	);
}

function htmlOf(rows: ExportRow[], encrypted = false): string {
	const b = bundle(rows.length, encrypted);
	return assembleHtml(
		b,
		rows.map((r) => htmlRow(r, b)),
	);
}

function textOf(rows: ExportRow[], encrypted = false): string {
	return assembleText(bundle(rows.length, encrypted), rows.map(textRow));
}

describe("JSON export", () => {
	it("emits room metadata and the projected message fields", () => {
		const out = jsonOf([
			row({ body: "hello", isEdited: true, replyToId: "$parent" }),
		]);
		expect(out.room_id).toBe("!room:example.com");
		expect(out.room_name).toBe("Test Room");
		expect(out.message_count).toBe(1);
		expect(out.messages[0]).toMatchObject({
			event_id: "$ev",
			sender: "@mallory:example.com",
			body: "hello",
			edited: true,
			reply_to: "$parent",
		});
	});

	it("records bundled attachment paths and failed exports", () => {
		const out = jsonOf([
			row(
				{ mediaFullUrl: "https://hs/x", mediaFilename: "a.png" },
				{ attachmentPath: "media/1_a.png" },
			),
			row(
				{ mediaFullUrl: "https://hs/y", mediaFilename: "b.png" },
				{ attachmentFailed: true },
			),
		]);
		expect(out.messages[0].media.path).toBe("media/1_a.png");
		expect(out.messages[1].media.url).toBe("https://hs/y");
		expect(out.messages[1].media.export_failed).toBe(true);
	});

	it("never emits a ciphertext URL for an unbundled encrypted attachment", () => {
		const out = jsonOf([
			row({
				mediaFullUrl: "https://hs/ciphertext",
				mediaFilename: "secret.png",
				mediaIsEncrypted: true,
			}),
		]);
		expect(out.messages[0].media.url).toBeUndefined();
		expect(out.messages[0].media.exported).toBe(false);
		expect(JSON.stringify(out)).not.toContain("ciphertext");
	});

	it("exports poll questions and answers without fabricated vote counts", () => {
		// The export's poll snapshots are provisional (tallies unfetched) -
		// confidently printing zeros would misrepresent every poll.
		const out = jsonOf([
			row({
				body: "",
				poll: {
					pollId: "$p",
					question: "Lunch?",
					kind: "disclosed",
					maxSelections: 1,
					answers: [
						{ id: "a", text: "Pizza" },
						{ id: "b", text: "Sushi" },
					],
					counts: { a: 0, b: 0 },
					totalVotes: 0,
					voters: { a: [], b: [] },
					isEnded: false,
				} as never,
			}),
		]);
		expect(out.messages[0].poll).toEqual({
			question: "Lunch?",
			answers: ["Pizza", "Sushi"],
		});
	});

	it("marks undecryptable events instead of recording the SDK placeholder", () => {
		const out = jsonOf([
			row(
				{ body: "** Unable to decrypt: [key not found] **" },
				{ undecryptable: true, bodyText: "" },
			),
		]);
		expect(out.messages[0].undecryptable).toBe(true);
		expect(out.messages[0].body).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain("key not found");
	});
});

describe("text export", () => {
	it("renders messages with sender, timestamp, and reactions", () => {
		const text = textOf([
			row({
				body: "hello\nworld",
				reactions: {
					"👍": { count: 2, senders: [] },
				},
			}),
		]);
		expect(text).toContain("Mallory: hello\n    world");
		expect(text).toContain("reactions: 👍 x2");
	});

	it("uses the stripped body, not the raw reply fallback", () => {
		const text = textOf([
			row(
				{ body: "> <@alice:hs> quoted\n\nactual reply" },
				{ bodyText: "actual reply" },
			),
		]);
		expect(text).toContain("Mallory: actual reply");
		expect(text).not.toContain("quoted");
	});

	it("renders a placeholder for undecryptable events", () => {
		const text = textOf([
			row({ body: "** Unable to decrypt: x **" }, { undecryptable: true }),
		]);
		expect(text).toContain("[Unable to decrypt this message]");
		expect(text).not.toContain("** Unable to decrypt: x **");
	});

	it("refuses to link an unbundled encrypted attachment", () => {
		const text = textOf([
			row({
				body: "",
				mediaFullUrl: "https://hs/ciphertext",
				mediaFilename: "secret.png",
				mediaIsEncrypted: true,
			}),
		]);
		expect(text).toContain("not exported (encrypted)");
		expect(text).not.toContain("ciphertext");
	});

	it("carries the E2EE plaintext warning for encrypted rooms", () => {
		expect(textOf([], true)).toContain("end-to-end encrypted");
	});
});

describe("HTML export", () => {
	it("escapes plain-text bodies", () => {
		const html = htmlOf([row({ body: '<script>alert("x")</script>' })]);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("sanitizes formatted bodies through the shared allowlist", () => {
		const html = htmlOf([
			row({
				format: "org.matrix.custom.html",
				formattedBody:
					'<b>bold</b><img src="https://evil.example/pixel.png"><script>alert(1)</script>',
			}),
		]);
		expect(html).toContain("<b>bold</b>");
		expect(html).not.toContain("evil.example");
		expect(html).not.toContain("<script>");
	});

	it("converts spoilers to native details elements", () => {
		const html = htmlOf([
			row({
				format: "org.matrix.custom.html",
				formattedBody: 'before <span data-mx-spoiler="why">secret</span> after',
			}),
		]);
		expect(html).toContain("<details>");
		expect(html).toContain("Spoiler: why");
		expect(html).toContain("secret");
	});

	it("inlines bundled images and links other attachments", () => {
		const html = htmlOf([
			row(
				{
					mediaFullUrl: "https://hs/img",
					mediaFilename: "photo.png",
					mediaMimetype: "image/png",
				},
				{ attachmentPath: "media/1_photo.png" },
			),
			row(
				{
					mediaFullUrl: "https://hs/doc",
					mediaFilename: "notes.pdf",
					mediaMimetype: "application/pdf",
				},
				{ attachmentPath: "media/2_notes.pdf" },
			),
		]);
		expect(html).toContain('src="media/1_photo.png"');
		expect(html).toContain('href="media/2_notes.pdf"');
	});

	it("notes an unbundled encrypted attachment without linking ciphertext", () => {
		const html = htmlOf([
			row({
				mediaFullUrl: "https://hs/ciphertext",
				mediaFilename: "secret.png",
				mediaIsEncrypted: true,
			}),
		]);
		expect(html).toContain("not exported");
		expect(html).not.toContain("ciphertext");
	});

	it("renders undecryptable events as a placeholder", () => {
		const html = htmlOf([
			row({ body: "** Unable to decrypt: y **" }, { undecryptable: true }),
		]);
		expect(html).toContain("[Unable to decrypt this message]");
		expect(html).not.toContain("** Unable to decrypt: y **");
	});

	it("marks the export of an encrypted room", () => {
		expect(htmlOf([], true)).toContain("end-to-end encrypted");
	});
});
