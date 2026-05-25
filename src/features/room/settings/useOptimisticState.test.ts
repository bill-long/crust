import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { useOptimisticState } from "./useOptimisticState";

function withRoot(fn: (dispose: () => void) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			let disposed = false;
			const safeDispose = (): void => {
				if (!disposed) {
					disposed = true;
					dispose();
				}
			};
			try {
				await fn(safeDispose);
				safeDispose();
				resolve();
			} catch (e) {
				safeDispose();
				reject(e);
			}
		});
	});
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useOptimisticState", () => {
	it("returns the server value when no write is pending", async () => {
		await withRoot(async () => {
			const [server] = createSignal("hello");
			const opt = useOptimisticState<string>({ serverValue: server });
			expect(opt.value()).toBe("hello");
			expect(opt.pending()).toBe(false);
		});
	});

	it("shows the overlay value while a write is in flight", async () => {
		await withRoot(async () => {
			const [server] = createSignal("a");
			const opt = useOptimisticState<string>({ serverValue: server });
			let resolveWrite: () => void = () => {};
			const writePromise = new Promise<void>((r) => {
				resolveWrite = r;
			});
			const inFlight = opt.apply("b", () => writePromise);
			expect(opt.value()).toBe("b");
			expect(opt.pending()).toBe(true);
			resolveWrite();
			await inFlight;
		});
	});

	it("clears overlay on matching server echo", async () => {
		await withRoot(async () => {
			const [server, setServer] = createSignal("a");
			const opt = useOptimisticState<string>({ serverValue: server });
			await opt.apply("b", async () => undefined);
			expect(opt.value()).toBe("b"); // overlay still in place
			setServer("b");
			opt.onServerEcho("b");
			expect(opt.value()).toBe("b");
			// overlay cleared → reading from server signal now
			setServer("c");
			expect(opt.value()).toBe("c");
		});
	});

	it("clears overlay on divergent echo when no writes are pending", async () => {
		await withRoot(async () => {
			const [server, setServer] = createSignal("a");
			const opt = useOptimisticState<string>({ serverValue: server });
			await opt.apply("b", async () => undefined);
			expect(opt.value()).toBe("b");
			// Concurrent edit from another client lands on the server.
			setServer("z");
			opt.onServerEcho("z");
			expect(opt.value()).toBe("z");
		});
	});

	it("preserves overlay when divergent echo arrives mid-write", async () => {
		await withRoot(async () => {
			const [server, setServer] = createSignal("a");
			const opt = useOptimisticState<string>({ serverValue: server });
			let resolveWrite: () => void = () => {};
			const inFlight = opt.apply(
				"b",
				() => new Promise<void>((r) => (resolveWrite = r)),
			);
			await flush();
			expect(opt.value()).toBe("b");
			// Stale echo for someone else's older write — must NOT clear
			// our overlay while we still have a write pending.
			setServer("stale");
			opt.onServerEcho("stale");
			// Drive the server to a new distinct value: if overlay was
			// (incorrectly) cleared, value() would now reflect it.
			setServer("stale2");
			expect(opt.value()).toBe("b");
			// Our matching echo finally arrives.
			setServer("b");
			opt.onServerEcho("b");
			expect(opt.value()).toBe("b");
			resolveWrite();
			await inFlight;
			// After completion, overlay was cleared so server is authoritative.
			setServer("c");
			expect(opt.value()).toBe("c");
		});
	});

	it("rolls back to server and exposes the error on write failure", async () => {
		await withRoot(async () => {
			const [server] = createSignal("a");
			const opt = useOptimisticState<string>({ serverValue: server });
			await opt.apply("b", async () => {
				throw new Error("boom");
			});
			expect(opt.value()).toBe("a");
			expect(opt.lastError()).toBe("boom");
			expect(opt.pending()).toBe(false);
		});
	});

	it("does not roll back over a newer write when an older one fails late", async () => {
		await withRoot(async () => {
			const [server] = createSignal("a");
			const opt = useOptimisticState<string>({ serverValue: server });

			let rejectOld: (err: Error) => void = () => {};
			const oldWrite = opt.apply(
				"old",
				() => new Promise<void>((_, reject) => (rejectOld = reject)),
			);
			await flush();
			// Older write is pending; start a newer one.
			const newerWrite = opt.apply("new", async () => undefined);
			await flush();
			// Now fail the older — opGen is already past it.
			rejectOld(new Error("late fail"));
			await Promise.allSettled([oldWrite, newerWrite]);
			// Overlay must still reflect the newer write, not roll back to server.
			expect(opt.value()).toBe("new");
			expect(opt.lastError()).toBeNull();
		});
	});

	it("uses fallbackError when the thrown value is not an Error", async () => {
		await withRoot(async () => {
			const [server] = createSignal("a");
			const opt = useOptimisticState<string>({
				serverValue: server,
				fallbackError: "could not save",
			});
			await opt.apply("b", async () => {
				throw "weird"; // eslint-disable-line @typescript-eslint/no-throw-literal
			});
			expect(opt.lastError()).toBe("could not save");
		});
	});

	it("reset() clears overlay/pending/error and ignores in-flight late completions", async () => {
		await withRoot(async () => {
			const [server] = createSignal("a");
			const opt = useOptimisticState<string>({ serverValue: server });
			let rejectWrite: (err: Error) => void = () => {};
			const inFlight = opt.apply(
				"b",
				() => new Promise<void>((_, reject) => (rejectWrite = reject)),
			);
			await flush();
			opt.reset();
			expect(opt.value()).toBe("a");
			expect(opt.pending()).toBe(false);
			rejectWrite(new Error("late"));
			await Promise.allSettled([inFlight]);
			await flush();
			expect(opt.lastError()).toBeNull();
		});
	});
});
