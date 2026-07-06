import { afterEach, describe, expect, it } from "vitest";
import { clearNotices, dismissNotice, notices, pushNotice } from "./notices";

afterEach(() => clearNotices());

describe("notices store", () => {
	it("starts empty", () => {
		expect(notices()).toEqual([]);
	});

	it("appends a pushed notice with the given message and tone", () => {
		pushNotice("hello", "error");
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toMatchObject({ message: "hello", tone: "error" });
	});

	it("defaults the tone to info", () => {
		pushNotice("plain");
		expect(notices()[0].tone).toBe("info");
	});

	it("returns a unique id per notice and preserves order", () => {
		const a = pushNotice("a");
		const b = pushNotice("b");
		expect(a).not.toBe(b);
		expect(notices().map((n) => n.message)).toEqual(["a", "b"]);
	});

	it("dismisses only the notice with the matching id", () => {
		const a = pushNotice("a");
		pushNotice("b");
		dismissNotice(a);
		expect(notices().map((n) => n.message)).toEqual(["b"]);
	});

	it("is a no-op when dismissing an unknown id", () => {
		pushNotice("a");
		dismissNotice(9999);
		expect(notices()).toHaveLength(1);
	});

	it("clears all notices", () => {
		pushNotice("a");
		pushNotice("b");
		clearNotices();
		expect(notices()).toEqual([]);
	});
});
