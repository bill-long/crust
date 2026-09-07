import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { updateSetting, userSettings } from "../../stores/settings";
import { HotkeyCaptureButton } from "./HotkeyCaptureButton";

const pressCode = (code: string): void => {
	// F13/media/numpad codes are not consistently emitted by headless host
	// keyboards. Deliver the browser KeyboardEvent the native webview receives.
	window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	updateSetting("micHotkey", null);
});

it("rejects an unsupported native key and preserves the previous binding", async () => {
	vi.stubGlobal("isTauri", true);
	vi.stubGlobal("__TAURI_INTERNALS__", {
		invoke: vi.fn(
			async (_command: string, args: { hotkey: { code: string } }) =>
				args.hotkey.code !== "F13",
		),
	});
	updateSetting("micHotkey", {
		ctrl: false,
		alt: false,
		shift: false,
		meta: false,
		code: "KeyM",
	});
	render(() => <HotkeyCaptureButton />);
	await userEvent.click(screen.getByRole("button", { name: /Mic hotkey:/ }));
	pressCode("F13");
	await vi.waitFor(() =>
		expect(screen.getByRole("alert")).toHaveTextContent(/not supported/),
	);
	expect(userSettings().micHotkey?.code).toBe("KeyM");
	await userEvent.click(screen.getByRole("button", { name: /Mic hotkey:/ }));
	pressCode("KeyK");
	await vi.waitFor(() => expect(userSettings().micHotkey?.code).toBe("KeyK"));
});

it("does not resurrect a binding cleared while native validation is pending", async () => {
	let resolve!: (supported: boolean) => void;
	vi.stubGlobal("isTauri", true);
	vi.stubGlobal("__TAURI_INTERNALS__", {
		invoke: () =>
			new Promise<boolean>((done) => {
				resolve = done;
			}),
	});
	updateSetting("micHotkey", {
		ctrl: false,
		alt: false,
		shift: false,
		meta: false,
		code: "KeyM",
	});
	render(() => <HotkeyCaptureButton />);
	await userEvent.click(screen.getByRole("button", { name: /Mic hotkey:/ }));
	pressCode("KeyK");
	await userEvent.click(
		screen.getByRole("button", { name: "Clear mic hotkey binding" }),
	);
	resolve(true);
	await new Promise((done) => setTimeout(done, 0));
	expect(userSettings().micHotkey).toBeNull();
});

it("keeps browser-only codes available outside the native shell", async () => {
	vi.stubGlobal("isTauri", false);
	const invoke = vi.fn();
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
	render(() => <HotkeyCaptureButton />);
	await userEvent.click(screen.getByRole("button", { name: /Mic hotkey:/ }));
	pressCode("F13");
	expect(userSettings().micHotkey?.code).toBe("F13");
	expect(invoke).not.toHaveBeenCalled();
});
