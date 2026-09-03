import type { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { buildReplySnippet } from "./timelineHelpers";

// Code points, never literal characters - an unterminated one would reorder
// the source line it sits on.
const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0x00);

function fileEvent(content: Record<string, unknown>): MatrixEvent {
	return {
		getContent: () => ({ msgtype: "m.file", ...content }),
		getType: () => "m.room.message",
	} as unknown as MatrixEvent;
}

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
