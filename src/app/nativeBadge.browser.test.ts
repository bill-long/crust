import { afterEach, expect, it, vi } from "vitest";
import "../styles/global.css";
import { releaseAppBadge, updateAppBadge } from "../client/appBadge";

afterEach(() => vi.unstubAllGlobals());

it("renders readable badge pixels and sends count changes and removal to the shell", async () => {
	const invoke = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("isTauri", true);
	vi.stubGlobal("__TAURI_INTERNALS__", { invoke });

	for (const count of [1, 42, 100]) {
		updateAppBadge(count);
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenLastCalledWith("set_app_badge", {
				count,
				rgba: expect.any(Array),
			}),
		);
		const pixels = invoke.mock.lastCall?.[1].rgba as number[];
		expect(pixels).toHaveLength(32 * 32 * 4);
		// Transparent corners, opaque badge, and white text inside it.
		expect(pixels[3]).toBe(0);
		expect(pixels[(4 * 32 + 16) * 4 + 3]).toBe(255);
		expect(
			pixels.some(
				(_, i) =>
					i % 4 === 0 &&
					pixels[i] === 255 &&
					pixels[i + 1] === 255 &&
					pixels[i + 2] === 255 &&
					pixels[i + 3] === 255,
			),
		).toBe(true);
	}
	updateAppBadge(0);
	expect(invoke).toHaveBeenLastCalledWith("set_app_badge", {
		count: 0,
		rgba: null,
	});
	releaseAppBadge();
	expect(invoke).toHaveBeenLastCalledWith("set_app_badge", {
		count: 0,
		rgba: null,
	});
});
