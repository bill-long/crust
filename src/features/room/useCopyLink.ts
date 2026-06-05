import { createSignal, onCleanup } from "solid-js";

export type CopyState = "idle" | "copied" | "error";

export interface CopyLink {
	copyState: () => CopyState;
	fallbackLink: () => string | null;
	/**
	 * Copy `url` to the clipboard, driving `copyState` through
	 * idle -> copied/error with a 2s auto-reset. When the clipboard API
	 * is unavailable, opens the manual-copy fallback by setting
	 * `fallbackLink(url)`.
	 */
	copy: (url: string) => Promise<void>;
	/**
	 * Close the manual-copy fallback dialog and return the button to its
	 * neutral state. Does NOT cancel an in-flight copy's generation — use
	 * `reset()` for full cancellation on unmount/context-change.
	 */
	clearFallback: () => void;
	/**
	 * Fully cancel any in-flight copy and clear all visible feedback.
	 * Bumps the generation counter so a pending clipboard resolution (and
	 * its scheduled auto-reset) becomes a no-op. Use when the surrounding
	 * context changes (e.g. the active room switches) so stale feedback
	 * doesn't leak.
	 */
	reset: () => void;
}

/**
 * Clipboard copy state machine for shareable links.
 *
 * Extracted from the original inline implementation in `Layout.tsx` so the
 * "Copy room link" header button and the InviteDialog "Copy invite link"
 * affordance share one battle-tested path (generation guard against stale
 * resolutions, the two-tick aria-live re-announce on the clipboard-
 * unavailable path, and a manual-copy fallback).
 *
 * Must be called during component setup — it registers an `onCleanup`.
 */
export function createCopyLink(): CopyLink {
	const [copyState, setCopyState] = createSignal<CopyState>("idle");
	const [fallbackLink, setFallbackLink] = createSignal<string | null>(null);
	let resetTimer: ReturnType<typeof setTimeout> | undefined;
	// Monotonic generation counter. Each copy() bumps it; awaited results
	// (and the auto-reset timer they schedule) must verify they are still the
	// current generation before mutating state. Without this guard a slow
	// first request could overwrite the result of a faster second request, or
	// an unmount could leave the success continuation scheduling a timer that
	// outlives the component.
	let gen = 0;
	let disposed = false;

	const clearResetTimer = (): void => {
		if (resetTimer !== undefined) {
			clearTimeout(resetTimer);
			resetTimer = undefined;
		}
	};

	onCleanup(() => {
		disposed = true;
		gen++;
		clearResetTimer();
	});

	const copy = async (url: string): Promise<void> => {
		const myGen = ++gen;
		clearResetTimer();

		// Schedule the 2s auto-reset that returns the button label back to the
		// neutral state. Used by both the success and the error paths so the
		// visible status doesn't strand indefinitely.
		const scheduleReset = (): void => {
			resetTimer = setTimeout(() => {
				resetTimer = undefined;
				if (disposed || myGen !== gen) return;
				setCopyState("idle");
			}, 2000);
		};

		const clipboard =
			typeof navigator !== "undefined" ? navigator.clipboard : undefined;
		if (!clipboard?.writeText) {
			// Force an aria-live re-announcement when the prior state was
			// already "error": two synchronous setCopyState calls in the same
			// event handler batch collapse to a single render, leaving the
			// polite region silent. setTimeout(..., 0) lets the browser commit
			// the "idle" render before the "error" render lands.
			setCopyState("idle");
			setTimeout(() => {
				if (disposed || myGen !== gen) return;
				setCopyState("error");
				scheduleReset();
			}, 0);
			setFallbackLink(url);
			return;
		}
		// Reset to idle synchronously so any prior "Copied!"/"Copy failed"
		// label and aria-live announcement clear before the async clipboard
		// result lands.
		setCopyState("idle");
		try {
			await clipboard.writeText(url);
			if (disposed || myGen !== gen) return;
			setCopyState("copied");
			// If a prior failed attempt left the fallback dialog open and the
			// retry succeeded, close it so the user isn't asked to copy by hand.
			setFallbackLink(null);
			scheduleReset();
		} catch {
			if (disposed || myGen !== gen) return;
			setCopyState("error");
			setFallbackLink(url);
			scheduleReset();
		}
	};

	const clearFallback = (): void => {
		setFallbackLink(null);
		setCopyState("idle");
	};

	const reset = (): void => {
		gen++;
		clearResetTimer();
		setCopyState("idle");
		setFallbackLink(null);
	};

	return { copyState, fallbackLink, copy, clearFallback, reset };
}
