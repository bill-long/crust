import { vi } from "vitest";

/** Deterministic serialization for unit tests; browser tests use real Web Locks. */
export function mockLoginLocks(): void {
	let tail: Promise<unknown> = Promise.resolve();
	vi.stubGlobal("navigator", {
		locks: {
			request: (
				_name: string,
				_options: unknown,
				callback: () => Promise<unknown>,
			) => {
				const result = tail.then(callback);
				tail = result.catch(() => {});
				return result;
			},
		},
	});
}
