import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyMessageText, isCopyableText } from "./copyMessageText";

const pushNotice = vi.hoisted(() => vi.fn());
vi.mock("../../../stores/notices", () => ({ pushNotice }));

describe("isCopyableText", () => {
	it("accepts the text-like msgtypes with a body", () => {
		expect(isCopyableText("m.text", "hello")).toBe(true);
		expect(isCopyableText("m.notice", "hello")).toBe(true);
		expect(isCopyableText("m.emote", "waves")).toBe(true);
	});

	it("rejects media msgtypes and empty bodies", () => {
		expect(isCopyableText("m.image", "cat.png")).toBe(false);
		expect(isCopyableText("m.file", "doc.pdf")).toBe(false);
		expect(isCopyableText("m.text", "")).toBe(false);
	});
});

describe("copyMessageText", () => {
	const writeText = vi.fn<(text: string) => Promise<void>>();
	let consoleError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		writeText.mockReset().mockResolvedValue(undefined);
		pushNotice.mockReset();
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		consoleError.mockRestore();
	});

	it("writes the body to the clipboard", async () => {
		await copyMessageText("hello world");
		expect(writeText).toHaveBeenCalledWith("hello world");
		expect(pushNotice).not.toHaveBeenCalled();
	});

	it("strips the reply fallback before copying", async () => {
		await copyMessageText("> <@alice:hs> quoted\n\nactual reply");
		expect(writeText).toHaveBeenCalledWith("actual reply");
	});

	it("toasts when the clipboard write rejects", async () => {
		writeText.mockRejectedValue(new Error("denied"));
		await copyMessageText("hello");
		expect(pushNotice).toHaveBeenCalledWith(
			"Couldn't copy the message text.",
			"error",
		);
	});

	it("toasts when the Clipboard API is unavailable", async () => {
		vi.stubGlobal("navigator", {});
		await copyMessageText("hello");
		expect(pushNotice).toHaveBeenCalledWith(
			"Couldn't copy the message text.",
			"error",
		);
	});
});
