import { describe, expect, it } from "vitest";
import { roomTopicText } from "./roomTopic";

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
