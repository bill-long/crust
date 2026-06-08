import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetNativeOverlayForTests,
	closeNativeOverlay,
	nativeOverlayOpen,
	openNativeOverlay,
	syncNativeOverlayOpen,
} from "./nativeOverlay";

type InvokeMock = ReturnType<typeof vi.fn>;

function installTauri(invoke: InvokeMock): void {
	(window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
}

describe("nativeOverlay", () => {
	afterEach(() => {
		(window as { __TAURI__?: unknown }).__TAURI__ = undefined;
		_resetNativeOverlayForTests();
		vi.restoreAllMocks();
	});

	it("invokes open_overlay and flips the signal open", async () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		installTauri(invoke);
		await openNativeOverlay();
		expect(invoke).toHaveBeenCalledWith("open_overlay", undefined);
		expect(nativeOverlayOpen()).toBe(true);
	});

	it("invokes close_overlay and flips the signal closed", async () => {
		const invoke = vi.fn().mockResolvedValue(undefined);
		installTauri(invoke);
		await openNativeOverlay();
		await closeNativeOverlay();
		expect(invoke).toHaveBeenCalledWith("close_overlay", undefined);
		expect(nativeOverlayOpen()).toBe(false);
	});

	it("reconciles the signal from overlay_is_open", async () => {
		const invoke = vi.fn().mockResolvedValue(true);
		installTauri(invoke);
		await syncNativeOverlayOpen();
		expect(invoke).toHaveBeenCalledWith("overlay_is_open", undefined);
		expect(nativeOverlayOpen()).toBe(true);
	});

	it("is a harmless no-op outside the native shell", async () => {
		// No window.__TAURI__ installed.
		await openNativeOverlay();
		// The optimistic signal still flips, but no invoke throws.
		expect(nativeOverlayOpen()).toBe(true);
		await syncNativeOverlayOpen();
		// overlay_is_open returns undefined -> treated as closed.
		expect(nativeOverlayOpen()).toBe(false);
	});
});
