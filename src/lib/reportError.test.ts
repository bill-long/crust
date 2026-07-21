import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNotices, notices } from "../stores/notices";
import { reportError } from "./reportError";

afterEach(() => {
	clearNotices();
	vi.restoreAllMocks();
});

describe("reportError", () => {
	it("logs to console.error with the default label", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const err = new Error("boom");
		reportError(err);
		expect(spy).toHaveBeenCalledWith("Unhandled error:", err);
	});

	it("uses the given logLabel for the console line", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const err = new Error("boom");
		reportError(err, { logLabel: "Reaction failed" });
		expect(spy).toHaveBeenCalledWith("Reaction failed:", err);
	});

	it("does not push a notice when userMessage is omitted", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		reportError(new Error("boom"), { logLabel: "background thing" });
		expect(notices()).toHaveLength(0);
	});

	it("pushes an error-tone notice when userMessage is set", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		reportError(new Error("boom"), { userMessage: "Couldn't do the thing." });
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toMatchObject({
			message: "Couldn't do the thing.",
			tone: "error",
		});
	});

	it("always logs even when a toast is shown", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		reportError(new Error("boom"), {
			userMessage: "Nope.",
			logLabel: "onReact",
		});
		expect(spy).toHaveBeenCalledWith("onReact:", expect.any(Error));
		expect(notices()).toHaveLength(1);
	});
});
