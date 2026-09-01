import { describe, expect, it } from "vitest";
import { userColorClass, userColorIndex } from "./userColor";

describe("userColorIndex", () => {
	it("stays inside the six-bucket range for any input", () => {
		const ids = [
			"",
			"@a:b",
			"@amon:strange.pizza",
			"@mendous:matrix.org",
			"\u{1f600}\u{1f600}\u{1f600}",
			"@".concat("x".repeat(2000), ":example.com"),
		];
		for (const id of ids) {
			const i = userColorIndex(id);
			expect(Number.isInteger(i)).toBe(true);
			expect(i).toBeGreaterThanOrEqual(0);
			expect(i).toBeLessThan(6);
		}
	});

	it("is stable for the same ID", () => {
		expect(userColorIndex("@amon:strange.pizza")).toBe(
			userColorIndex("@amon:strange.pizza"),
		);
	});

	it("separates anagram IDs - the reason we don't use Element's char sum", () => {
		expect(userColorIndex("@ab:example.com")).not.toBe(
			userColorIndex("@ba:example.com"),
		);
	});

	it("distinguishes the same localpart on different servers", () => {
		expect(userColorIndex("@amon:example.com")).not.toBe(
			userColorIndex("@amon:example.org"),
		);
	});

	it("spreads a realistic room across every bucket", () => {
		const seen = new Set(
			Array.from({ length: 60 }, (_, n) =>
				userColorIndex(`@user${n}:example.com`),
			),
		);
		expect(seen.size).toBe(6);
	});
});

describe("userColorClass", () => {
	it("returns a defined token class for every bucket", () => {
		const classes = new Set(
			Array.from({ length: 60 }, (_, n) =>
				userColorClass(`@user${n}:example.com`),
			),
		);
		expect(classes.size).toBe(6);
		for (const c of classes) expect(c).toMatch(/^text-username-[1-6]$/);
	});

	it("maps the empty ID to a real class rather than undefined", () => {
		expect(userColorClass("")).toBe("text-username-1");
	});
});
