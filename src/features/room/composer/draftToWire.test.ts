import { describe, expect, it } from "vitest";
import { draftToWire } from "./draftToWire";

describe("draftToWire", () => {
	it("runs plain text through markdown unchanged", () => {
		const wire = draftToWire("**bold**", [], []);
		expect(wire.msgtype).toBe("m.text");
		expect(wire.body).toBe("**bold**");
		expect(wire.formatted_body).toBe("<strong>bold</strong>");
	});

	it("/me becomes an emote", () => {
		const wire = draftToWire("/me waves", [], []);
		expect(wire.msgtype).toBe("m.emote");
		expect(wire.body).toBe("waves");
	});

	it("/plain skips markdown", () => {
		const wire = draftToWire("/plain **not bold**", [], []);
		expect(wire.body).toBe("**not bold**");
		expect(wire.formatted_body).toBeNull();
	});

	it("/spoiler hides the plain-text fallback behind a placeholder", () => {
		const wire = draftToWire("/spoiler the killer is Bob", [], []);
		expect(wire.body).toBe("[Spoiler]");
		expect(wire.formatted_body).toBe(
			"<span data-mx-spoiler>the killer is Bob</span>",
		);
	});

	it("/spoiler preserves markdown and newlines inside the span", () => {
		const wire = draftToWire("/spoiler **big**\ntwist", [], []);
		expect(wire.body).toBe("[Spoiler]");
		expect(wire.formatted_body).toBe(
			"<span data-mx-spoiler><strong>big</strong><br>twist</span>",
		);
	});
});
