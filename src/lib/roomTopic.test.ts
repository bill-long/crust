import { describe, expect, it } from "vitest";
import { roomTopicLine, roomTopicText } from "./roomTopic";

describe("roomTopicText", () => {
	it("returns a string topic verbatim", () => {
		expect(roomTopicText({ topic: "hello\nworld" })).toBe("hello\nworld");
	});

	it("returns empty for absent content or topic", () => {
		expect(roomTopicText(null)).toBe("");
		expect(roomTopicText(undefined)).toBe("");
		expect(roomTopicText({})).toBe("");
	});

	it("rejects a malformed non-string topic", () => {
		expect(roomTopicText({ topic: { nested: "object" } })).toBe("");
		expect(roomTopicText({ topic: 42 })).toBe("");
		expect(roomTopicText({ topic: null })).toBe("");
	});
});

describe("roomTopicLine", () => {
	it("collapses whitespace runs and newlines to single spaces", () => {
		expect(roomTopicLine({ topic: " a\nb   c\t\nd " })).toBe("a b c d");
	});

	it("returns empty for absent or malformed topics", () => {
		expect(roomTopicLine(null)).toBe("");
		expect(roomTopicLine({ topic: 42 })).toBe("");
	});
});
