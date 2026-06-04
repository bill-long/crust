import { describe, expect, it } from "vitest";
import { formatReactors } from "./reactionFormatting";

describe("formatReactors", () => {
	const s = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			userId: `@u${i}:test`,
			name:
				["Alice", "Bob", "Carol", "Dan", "Eve", "Frank", "Grace"][i] ?? `U${i}`,
		}));

	it("returns empty string for no senders", () => {
		expect(formatReactors([], "🎉")).toBe("");
	});

	it("formats one sender", () => {
		expect(formatReactors(s(1), "🎉")).toBe("Alice reacted with 🎉");
	});

	it("formats two senders with 'and'", () => {
		expect(formatReactors(s(2), "🎉")).toBe("Alice and Bob reacted with 🎉");
	});

	it("formats three senders with Oxford comma", () => {
		expect(formatReactors(s(3), "🎉")).toBe(
			"Alice, Bob, and Carol reacted with 🎉",
		);
	});

	it("formats five senders with Oxford comma", () => {
		expect(formatReactors(s(5), "🎉")).toBe(
			"Alice, Bob, Carol, Dan, and Eve reacted with 🎉",
		);
	});

	it("collapses six senders into 'and N others'", () => {
		expect(formatReactors(s(6), "🎉")).toBe(
			"Alice, Bob, and 4 others reacted with 🎉",
		);
	});

	it("collapses many senders into 'and N others'", () => {
		expect(formatReactors(s(7), ":heart:")).toBe(
			"Alice, Bob, and 5 others reacted with :heart:",
		);
	});
});
