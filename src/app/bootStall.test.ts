import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_STALL_MS, createBootStall } from "./bootStall";

/** Let Solid's effect queue drain after a signal write. */
async function flush(): Promise<void> {
	await Promise.resolve();
}

let disposeRoot: (() => void) | undefined;

/**
 * Mount the primitive in a root of its own. Disposal is the test's to trigger
 * where it is the thing under test, and `afterEach`'s otherwise - a timer that
 * outlives its root would fire into a later test.
 */
function mountStall(waiting: () => boolean): () => boolean {
	let stalled!: () => boolean;
	createRoot((dispose) => {
		disposeRoot = dispose;
		stalled = createBootStall(waiting);
	});
	return () => stalled();
}

describe("createBootStall", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		disposeRoot?.();
		disposeRoot = undefined;
		vi.useRealTimers();
	});

	it("reports a stall only once the delay has elapsed in the waiting phase", async () => {
		const stalled = mountStall(() => true);
		await flush();
		expect(stalled()).toBe(false);

		vi.advanceTimersByTime(BOOT_STALL_MS - 1);
		await flush();
		expect(stalled()).toBe(false);

		vi.advanceTimersByTime(1);
		await flush();
		expect(stalled()).toBe(true);
	});

	it("never arms while the boot is outside the waiting phase", async () => {
		const stalled = mountStall(() => false);
		await flush();

		vi.advanceTimersByTime(BOOT_STALL_MS * 2);
		await flush();
		expect(stalled()).toBe(false);
	});

	it("disarms when the boot leaves the waiting phase before the delay", async () => {
		const [waiting, setWaiting] = createSignal(true);
		const stalled = mountStall(waiting);
		await flush();

		vi.advanceTimersByTime(BOOT_STALL_MS - 1);
		setWaiting(false);
		await flush();

		vi.advanceTimersByTime(BOOT_STALL_MS);
		await flush();
		expect(stalled()).toBe(false);
	});

	it("takes the stall back when the boot recovers, and gives a later stall a full delay", async () => {
		const [waiting, setWaiting] = createSignal(true);
		const stalled = mountStall(waiting);
		await flush();

		vi.advanceTimersByTime(BOOT_STALL_MS);
		await flush();
		expect(stalled()).toBe(true);

		setWaiting(false);
		await flush();
		expect(stalled()).toBe(false);

		// Back into the phase: the delay starts over rather than reporting a
		// stall the moment it is re-entered.
		setWaiting(true);
		await flush();
		expect(stalled()).toBe(false);

		vi.advanceTimersByTime(BOOT_STALL_MS - 1);
		await flush();
		expect(stalled()).toBe(false);

		vi.advanceTimersByTime(1);
		await flush();
		expect(stalled()).toBe(true);
	});

	it("arms one timer however often the phase is re-evaluated", async () => {
		// The real predicate is `syncState() === "initial" && cryptoState() !==
		// "loading"` - several signals behind one answer - so it is re-evaluated
		// while still answering true. Each re-evaluation must not leave another
		// timer behind holding this root alive.
		const [noise, setNoise] = createSignal(0);
		const stalled = mountStall(() => {
			noise();
			return true;
		});
		await flush();
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(BOOT_STALL_MS - 1);
		setNoise(1);
		setNoise(2);
		await flush();
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(1);
		await flush();
		expect(stalled()).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops the timer when its owner is disposed", async () => {
		const stalled = mountStall(() => true);
		await flush();

		disposeRoot?.();
		disposeRoot = undefined;
		vi.advanceTimersByTime(BOOT_STALL_MS * 2);
		await flush();
		expect(stalled()).toBe(false);
	});
});
