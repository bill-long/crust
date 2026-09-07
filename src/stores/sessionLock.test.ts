import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isSessionLockHeld, withSessionLock } from "./sessionLock";

const request = vi.fn();
beforeEach(() => {
	vi.useFakeTimers();
	request.mockReset();
	request.mockImplementation(
		(_name: string, _options: unknown, operation: () => Promise<unknown>) =>
			operation(),
	);
	vi.stubGlobal("navigator", { locks: { request } });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("clears the acquisition deadline immediately when the lock is granted", async () => {
	let finish!: () => void;
	const pending = withSessionLock(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	expect(isSessionLockHeld()).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
	await vi.advanceTimersByTimeAsync(6_000);
	expect(request.mock.calls[0]?.[1].signal.aborted).toBe(false);
	finish();
	await pending;
	expect(isSessionLockHeld()).toBe(false);
});

it("clears the deadline and releases ownership after a failed operation", async () => {
	await expect(
		withSessionLock(() => {
			throw new Error("write failed");
		}),
	).rejects.toThrow("write failed");
	expect(vi.getTimerCount()).toBe(0);
	expect(isSessionLockHeld()).toBe(false);
});

it("bounds a queued request without running its operation", async () => {
	request.mockImplementation(
		(_name: string, options: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener(
					"abort",
					() => reject(options.signal.reason),
					{ once: true },
				);
			}),
	);
	const operation = vi.fn();
	const pending = expect(withSessionLock(operation)).rejects.toThrow(
		"Another tab is busy",
	);
	await vi.advanceTimersByTimeAsync(5_000);
	await pending;
	expect(operation).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	expect(isSessionLockHeld()).toBe(false);
});

it("clears the deadline if request throws before it returns a promise", async () => {
	request.mockImplementation(() => {
		throw new Error("lock unavailable");
	});
	await expect(withSessionLock(() => {})).rejects.toThrow("lock unavailable");
	expect(vi.getTimerCount()).toBe(0);
});
