import { describe, expect, it } from "vitest";
import {
	isPollStartType,
	isRenderablePollContent,
	pollPreviewText,
	pollQuestionFromContent,
} from "./pollCopy";

describe("isPollStartType", () => {
	it("matches the unstable and stable poll-start types", () => {
		expect(isPollStartType("org.matrix.msc3381.poll.start")).toBe(true);
		expect(isPollStartType("m.poll.start")).toBe(true);
	});

	it("rejects other event types, including poll responses/ends", () => {
		expect(isPollStartType("m.room.message")).toBe(false);
		expect(isPollStartType("org.matrix.msc3381.poll.response")).toBe(false);
		expect(isPollStartType("org.matrix.msc3381.poll.end")).toBe(false);
	});
});

describe("pollQuestionFromContent", () => {
	it("reads the question from unstable content", () => {
		expect(
			pollQuestionFromContent({
				"org.matrix.msc3381.poll.start": {
					question: { "org.matrix.msc1767.text": "Lunch?" },
				},
			}),
		).toBe("Lunch?");
	});

	it("reads the question from stable content", () => {
		expect(
			pollQuestionFromContent({
				"m.poll.start": { question: { "m.text": "Lunch?" } },
			}),
		).toBe("Lunch?");
	});

	it("falls back to the question's legacy body", () => {
		expect(
			pollQuestionFromContent({
				"org.matrix.msc3381.poll.start": { question: { body: "Lunch?" } },
			}),
		).toBe("Lunch?");
	});

	it("returns the first non-empty line trimmed for one-line surfaces", () => {
		expect(
			pollQuestionFromContent({
				"org.matrix.msc3381.poll.start": {
					question: { "org.matrix.msc1767.text": "  \n  Lunch?  \nMore" },
				},
			}),
		).toBe("Lunch?");
	});

	it.each([
		["null content", null],
		["non-object content", "hi"],
		["no poll key", { body: "hi" }],
		["non-object start block", { "m.poll.start": 3 }],
		["missing question", { "m.poll.start": {} }],
		["non-string question text", { "m.poll.start": { question: { body: 3 } } }],
		[
			"whitespace-only question",
			{ "m.poll.start": { question: { body: "   " } } },
		],
	])("returns null for %s", (_label, content) => {
		expect(pollQuestionFromContent(content)).toBeNull();
	});
});

describe("isRenderablePollContent", () => {
	const answers = [
		{ id: "a", "org.matrix.msc1767.text": "A" },
		{ id: "b", "m.text": "B" },
	];

	it("accepts a poll with a readable question and well-formed answers", () => {
		expect(
			isRenderablePollContent({
				"org.matrix.msc3381.poll.start": {
					question: { "org.matrix.msc1767.text": "Q?" },
					answers,
				},
			}),
		).toBe(true);
	});

	it.each([
		["no question", { "m.poll.start": { answers } }],
		["no answers", { "m.poll.start": { question: { "m.text": "Q?" } } }],
		[
			"empty answers",
			{ "m.poll.start": { question: { "m.text": "Q?" }, answers: [] } },
		],
		[
			"answer without id",
			{
				"m.poll.start": {
					question: { "m.text": "Q?" },
					answers: [{ "m.text": "A" }],
				},
			},
		],
		[
			"answer without text",
			{
				"m.poll.start": {
					question: { "m.text": "Q?" },
					answers: [{ id: "a" }],
				},
			},
		],
	])("rejects a poll with %s", (_label, content) => {
		expect(isRenderablePollContent(content)).toBe(false);
	});
});

describe("pollPreviewText", () => {
	it("prefixes the question with Poll:", () => {
		expect(
			pollPreviewText({
				"org.matrix.msc3381.poll.start": {
					question: { "org.matrix.msc1767.text": "Best pizza?" },
				},
			}),
		).toBe("Poll: Best pizza?");
	});

	it("returns null for unreadable content", () => {
		expect(pollPreviewText({})).toBeNull();
	});
});
