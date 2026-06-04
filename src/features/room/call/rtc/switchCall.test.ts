import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetActiveCallForTests,
	activeCallRoomId,
	setActiveCallRoomId,
} from "../../../../stores/activeCall";
import {
	_resetCallSessionForTests,
	type CallSessionApi,
	publishCallSession,
} from "./callSessionStore";
import { _resetSwitchCallEpochForTests, switchCall } from "./switchCall";

function makeFakeSession(
	roomId: string,
	requestLeave: () => Promise<void>,
): CallSessionApi {
	return {
		instanceId: 1,
		roomId,
		roomName: () => roomId,
		// biome-ignore lint/suspicious/noExplicitAny: stub for switchCall tests
		rtc: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: stub for switchCall tests
		livekit: {} as any,
		bridgeInitializing: () => false,
		bridgeInitError: () => null,
		leaving: () => false,
		requestJoin: async () => {},
		requestClose: () => {},
		requestLeave,
	};
}

describe("switchCall", () => {
	afterEach(() => {
		_resetActiveCallForTests();
		_resetCallSessionForTests();
		_resetSwitchCallEpochForTests();
		vi.restoreAllMocks();
	});

	it("sets activeCallRoomId directly when no session is active", async () => {
		const result = await switchCall("!new:example.com");
		expect(result).toEqual({ ok: true });
		expect(activeCallRoomId()).toBe("!new:example.com");
	});

	it("returns ok without action when target equals current session room", async () => {
		setActiveCallRoomId("!a:example.com");
		const leave = vi.fn(async () => {});
		publishCallSession(makeFakeSession("!a:example.com", leave));
		const result = await switchCall("!a:example.com");
		expect(result).toEqual({ ok: true });
		expect(leave).not.toHaveBeenCalled();
		expect(activeCallRoomId()).toBe("!a:example.com");
	});

	it("awaits the previous session's requestLeave then sets target", async () => {
		setActiveCallRoomId("!a:example.com");
		let resolveLeave: (() => void) | undefined;
		const leave = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolveLeave = r;
				}),
		);
		publishCallSession(makeFakeSession("!a:example.com", leave));

		const promise = switchCall("!b:example.com");
		// Microtask flush — requestLeave is in flight, target not yet set.
		await Promise.resolve();
		expect(activeCallRoomId()).toBe("!a:example.com");

		resolveLeave?.();
		const result = await promise;
		expect(result).toEqual({ ok: true });
		expect(leave).toHaveBeenCalledTimes(1);
		expect(activeCallRoomId()).toBe("!b:example.com");
	});

	it("returns leaveFailed and preserves the original room when requestLeave throws", async () => {
		setActiveCallRoomId("!a:example.com");
		const err = new Error("server rejected leave");
		const leave = vi.fn(async () => {
			throw err;
		});
		publishCallSession(makeFakeSession("!a:example.com", leave));

		const result = await switchCall("!b:example.com");
		expect(result.ok).toBe(false);
		expect(result.leaveFailed).toBe(true);
		expect(result.error).toBe(err);
		expect(activeCallRoomId()).toBe("!a:example.com");
	});

	it("wraps a non-Error thrown value into an Error", async () => {
		setActiveCallRoomId("!a:example.com");
		const leave = vi.fn(async () => {
			throw "string failure";
		});
		publishCallSession(makeFakeSession("!a:example.com", leave));

		const result = await switchCall("!b:example.com");
		expect(result.leaveFailed).toBe(true);
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error?.message).toBe("string failure");
	});

	it("supersedes an earlier invocation when a later switchCall starts during leave", async () => {
		setActiveCallRoomId("!a:example.com");
		let resolveLeave: (() => void) | undefined;
		// Single shared leave promise: both switchCall invocations await
		// the same in-flight controller leave (mirrors the controller's
		// awaitable single-flight `requestLeave`).
		const leavePromise = new Promise<void>((r) => {
			resolveLeave = r;
		});
		const leave = vi.fn(() => leavePromise);
		publishCallSession(makeFakeSession("!a:example.com", leave));

		const first = switchCall("!b:example.com");
		await Promise.resolve();
		const second = switchCall("!c:example.com");

		resolveLeave?.();
		const [r1, r2] = await Promise.all([first, second]);

		// Later invocation wins.
		expect(r2).toEqual({ ok: true });
		expect(r1).toEqual({ ok: false, superseded: true });
		expect(activeCallRoomId()).toBe("!c:example.com");
		// Both invocations called requestLeave; the controller's own
		// awaitable single-flight collapses them into one real teardown,
		// but switchCall itself does invoke requestLeave twice.
		expect(leave).toHaveBeenCalledTimes(2);
	});
});
