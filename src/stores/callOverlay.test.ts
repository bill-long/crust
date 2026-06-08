import { afterEach, describe, expect, it } from "vitest";
import {
	_resetCallOverlayForTests,
	clearOverlayWindow,
	closeOverlay,
	DEFAULT_OVERLAY_SIZE,
	loadOverlaySize,
	overlayOpen,
	overlayWindow,
	requestOpenOverlay,
	saveOverlaySize,
	setOverlayHandlers,
	setOverlayWindow,
} from "./callOverlay";

const SIZE_KEY = "crust:call-overlay-size";

afterEach(() => {
	_resetCallOverlayForTests();
	localStorage.removeItem(SIZE_KEY);
});

describe("callOverlay store", () => {
	it("starts closed with no window", () => {
		expect(overlayOpen()).toBe(false);
		expect(overlayWindow()).toBeNull();
	});

	it("setOverlayWindow flips open and stores the handle", () => {
		const fake = {} as Window;
		setOverlayWindow(fake);
		expect(overlayOpen()).toBe(true);
		expect(overlayWindow()).toBe(fake);
	});

	it("clearOverlayWindow flips closed and drops the handle (idempotent)", () => {
		setOverlayWindow({} as Window);
		clearOverlayWindow();
		expect(overlayOpen()).toBe(false);
		expect(overlayWindow()).toBeNull();
		// second clear is a no-op, not an error
		clearOverlayWindow();
		expect(overlayOpen()).toBe(false);
	});

	it("requestOpenOverlay/closeOverlay delegate to registered handlers", () => {
		let opened = 0;
		let closed = 0;
		setOverlayHandlers(
			() => opened++,
			() => closed++,
		);
		requestOpenOverlay();
		closeOverlay();
		expect(opened).toBe(1);
		expect(closed).toBe(1);
	});

	it("request/close are no-ops when no handlers are registered", () => {
		expect(() => requestOpenOverlay()).not.toThrow();
		expect(() => closeOverlay()).not.toThrow();
	});

	describe("size persistence", () => {
		it("returns the default when nothing is stored", () => {
			expect(loadOverlaySize()).toEqual(DEFAULT_OVERLAY_SIZE);
		});

		it("round-trips a valid size", () => {
			saveOverlaySize({ width: 320, height: 480 });
			expect(loadOverlaySize()).toEqual({ width: 320, height: 480 });
		});

		it("ignores and does not persist out-of-range dimensions", () => {
			saveOverlaySize({ width: 5, height: 999999 });
			expect(localStorage.getItem(SIZE_KEY)).toBeNull();
			expect(loadOverlaySize()).toEqual(DEFAULT_OVERLAY_SIZE);
		});

		it("falls back to default on malformed JSON", () => {
			localStorage.setItem(SIZE_KEY, "{not json");
			expect(loadOverlaySize()).toEqual(DEFAULT_OVERLAY_SIZE);
		});

		it("falls back to default when a stored dimension is invalid", () => {
			localStorage.setItem(
				SIZE_KEY,
				JSON.stringify({ width: 300, height: "tall" }),
			);
			expect(loadOverlaySize()).toEqual(DEFAULT_OVERLAY_SIZE);
		});
	});
});
