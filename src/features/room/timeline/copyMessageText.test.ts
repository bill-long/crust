import { describe, expect, it } from "vitest";
import { copyableText } from "./copyMessageText";
import type { TimelineEvent } from "./timelineTypes";

function makeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
	return {
		msgtype: "m.text",
		body: "",
		mediaCaption: null,
		isDecryptionFailure: false,
		...overrides,
	} as TimelineEvent;
}

describe("copyableText", () => {
	it("returns the body for the text-like msgtypes", () => {
		expect(copyableText(makeEvent({ msgtype: "m.text", body: "hi" }))).toBe(
			"hi",
		);
		expect(copyableText(makeEvent({ msgtype: "m.notice", body: "hi" }))).toBe(
			"hi",
		);
		expect(copyableText(makeEvent({ msgtype: "m.emote", body: "waves" }))).toBe(
			"waves",
		);
	});

	it("strips the reply fallback and trims, matching forward-as-text", () => {
		expect(
			copyableText(
				makeEvent({ body: "> <@alice:hs> quoted\n\nactual reply\n\n" }),
			),
		).toBe("actual reply");
	});

	it("returns null for an empty or whitespace-only body", () => {
		expect(copyableText(makeEvent({ body: "" }))).toBeNull();
		expect(copyableText(makeEvent({ body: "  \n " }))).toBeNull();
	});

	it("returns the caption for captioned media", () => {
		expect(
			copyableText(
				makeEvent({
					msgtype: "m.image",
					body: "cat.png",
					mediaCaption: "look at this cat",
				}),
			),
		).toBe("look at this cat");
	});

	it("strips a legacy reply fallback from a caption (mirrors forward-media)", () => {
		expect(
			copyableText(
				makeEvent({
					msgtype: "m.image",
					body: "cat.png",
					mediaCaption: "> <@alice:hs> quoted\n\nactual caption",
				}),
			),
		).toBe("actual caption");
	});

	it("returns null for uncaptioned media (the body is a filename)", () => {
		expect(
			copyableText(
				makeEvent({ msgtype: "m.file", body: "doc.pdf", mediaCaption: null }),
			),
		).toBeNull();
	});

	it("returns null for decryption failures", () => {
		expect(
			copyableText(
				makeEvent({ body: "placeholder", isDecryptionFailure: true }),
			),
		).toBeNull();
	});
});
