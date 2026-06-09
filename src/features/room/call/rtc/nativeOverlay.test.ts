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
	(window as { isTauri?: boolean }).isTauri = true;
	(window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
}

describe("nativeOverlay", () => {
	afterEach(() => {
		(window as { isTauri?: boolean }).isTauri = undefined;
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

	it("is a no-op outside the native shell", async () => {
		// No window.isTauri / __TAURI__ installed.
		await openNativeOverlay();
		// Outside the native shell the signal must NOT flip — nothing opened.
		expect(nativeOverlayOpen()).toBe(false);
		await syncNativeOverlayOpen();
		expect(nativeOverlayOpen()).toBe(false);
	});
});
