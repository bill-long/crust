import { afterEach, describe, expect, it, vi } from "vitest";
import { watchNativeShutdown } from "./nativeShutdown";

const mocks = vi.hoisted(() => ({
	native: true,
	overlay: false,
	end: vi.fn(),
	invoke: vi.fn(),
	listen: vi.fn(),
	report: vi.fn(),
}));
vi.mock("./nativeShell", () => ({
	isNativeShell: () => mocks.native,
	isOverlayWindow: () => mocks.overlay,
}));
vi.mock("./tauri", () => ({
	invokeTauri: mocks.invoke,
	listenTauri: mocks.listen,
}));
vi.mock("../features/room/call/rtc/endCall", () => ({
	endActiveCall: mocks.end,
}));
vi.mock("../lib/reportError", () => ({ reportError: mocks.report }));

afterEach(() => {
	vi.resetAllMocks();
	mocks.native = true;
	mocks.overlay = false;
});

describe("native shutdown", () => {
	it("awaits one call withdrawal before acknowledging repeated close requests", async () => {
		let finish!: () => void;
		mocks.end.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		const stop = vi.fn();
		mocks.listen.mockResolvedValue(stop);
		expect(await watchNativeShutdown()).toBe(stop);
		const callback = mocks.listen.mock.calls[0]?.[1];
		callback();
		callback();
		expect(mocks.end).toHaveBeenCalledTimes(1);
		expect(mocks.invoke).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(() =>
			expect(mocks.invoke).toHaveBeenCalledWith("complete_shutdown"),
		);
	});

	it("still acknowledges when a call-store subscriber throws", async () => {
		mocks.end.mockRejectedValue(new Error("subscriber failed"));
		await watchNativeShutdown();
		mocks.listen.mock.calls[0]?.[1]();
		await vi.waitFor(() =>
			expect(mocks.invoke).toHaveBeenCalledWith("complete_shutdown"),
		);
		expect(mocks.report).toHaveBeenCalledOnce();
	});

	it.each([
		[false, false],
		[true, true],
	])(
		"does not subscribe outside the main native window (%s, %s)",
		async (native, overlay) => {
			mocks.native = native;
			mocks.overlay = overlay;
			(await watchNativeShutdown())();
			expect(mocks.listen).not.toHaveBeenCalled();
		},
	);
});
