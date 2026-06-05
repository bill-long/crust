import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopyLink } from "./useCopyLink";

function setClipboard(
	writeText: ((text: string) => Promise<void>) | undefined,
): void {
	Object.defineProperty(navigator, "clipboard", {
		value: writeText ? { writeText } : undefined,
		configurable: true,
		writable: true,
	});
}

function flushMicrotasks(): Promise<void> {
	return Promise.resolve();
}

function flushMacrotask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	setClipboard(undefined);
	vi.useRealTimers();
});

describe("createCopyLink", () => {
	it("sets copied on a successful clipboard write", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard(writeText);
		await createRoot(async (dispose) => {
			const link = createCopyLink();
			expect(link.copyState()).toBe("idle");
			await link.copy("https://matrix.to/#/!r:server");
			expect(writeText).toHaveBeenCalledWith("https://matrix.to/#/!r:server");
			expect(link.copyState()).toBe("copied");
			expect(link.fallbackLink()).toBeNull();
			dispose();
		});
	});

	it("auto-resets to idle after 2s", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		setClipboard(writeText);
		await createRoot(async (dispose) => {
			const link = createCopyLink();
			await link.copy("u");
			expect(link.copyState()).toBe("copied");
			await vi.advanceTimersByTimeAsync(2000);
			expect(link.copyState()).toBe("idle");
			dispose();
		});
	});

	it("opens the manual-copy fallback when the clipboard API is unavailable", async () => {
		setClipboard(undefined);
		await createRoot(async (dispose) => {
			const link = createCopyLink();
			await link.copy("https://matrix.to/#/!r:server");
			expect(link.fallbackLink()).toBe("https://matrix.to/#/!r:server");
			// The error state is announced on a macrotask to force an
			// aria-live re-announcement.
			await flushMacrotask();
			expect(link.copyState()).toBe("error");
			dispose();
		});
	});

	it("surfaces an error and the fallback when the write rejects", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		setClipboard(writeText);
		await createRoot(async (dispose) => {
			const link = createCopyLink();
			await link.copy("u");
			expect(link.copyState()).toBe("error");
			expect(link.fallbackLink()).toBe("u");
			dispose();
		});
	});

	it("clearFallback closes the fallback and returns to idle", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("denied"));
		setClipboard(writeText);
		await createRoot(async (dispose) => {
			const link = createCopyLink();
			await link.copy("u");
			expect(link.fallbackLink()).toBe("u");
			link.clearFallback();
			expect(link.fallbackLink()).toBeNull();
			expect(link.copyState()).toBe("idle");
			dispose();
		});
	});

	it("reset cancels a stale in-flight write so it cannot overwrite state", async () => {
		let resolveWrite: (() => void) | undefined;
		const writeText = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveWrite = resolve;
				}),
		);
		setClipboard(writeText);
		await createRoot(async (dispose) => {
			const link = createCopyLink();
			const pending = link.copy("u");
			// Context changes (e.g. active room switch) before the write lands.
			link.reset();
			expect(link.copyState()).toBe("idle");
			resolveWrite?.();
			await pending;
			await flushMicrotasks();
			// The stale resolution must not flip the state to "copied".
			expect(link.copyState()).toBe("idle");
			dispose();
		});
	});
});
