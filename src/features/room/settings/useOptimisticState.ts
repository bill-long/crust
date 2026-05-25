import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
} from "solid-js";

/**
 * Overlay + in-flight reconciliation for room-state writes.
 *
 * State events have no SDK local-echo. `client.sendStateEvent` does
 * not push a pending event onto `Room.timeline` and does not fire
 * `LocalEchoUpdated`; the only signal a write succeeded is the
 * eventual `RoomStateEvent.Events` echo. So callers that want
 * optimistic UI for a state edit must own the reconciliation.
 *
 * This hook factors the pattern proven by `usePinnedEvents`:
 *
 *   - `apply(next, runWrite)` records `next` in an overlay (the value
 *     readers should display) and starts the write. Each apply call
 *     gets a fresh `opGen` and increments `inFlightWrites`.
 *   - Writes are queued through a serialized chain so successive
 *     toggles land in the server in order.
 *   - `onServerEcho(serverValue)` must be called by the caller from
 *     whatever subscription it owns (typically a
 *     `RoomStateEvent.Events` listener filtered to the right
 *     room+type). The hook then:
 *       * clears the overlay if `equals(serverValue, overlay)` — our
 *         write was confirmed.
 *       * clears the overlay if no writes are pending
 *         (`inFlightWrites === 0`) — the server is authoritative for
 *         a concurrent edit.
 *       * keeps the overlay otherwise — a newer in-flight write of
 *         ours is about to supersede this echo.
 *   - On write failure: the overlay is dropped **only if** this op
 *     is still the latest (`opGen === gen`). A later write has
 *     superseded us; its overlay reflects current intent.
 *   - On room change (consumers pass `roomId` to `reset`), the
 *     overlay + error + pending state are cleared and `opGen` is
 *     bumped so any in-flight late failure cannot scribble across
 *     the new room.
 *
 * `value()` returns the overlay if present, otherwise the
 * caller-supplied `serverValue()`. `pending()` reports whether *any*
 * write is currently in flight. `lastError()` exposes the most recent
 * failure message (cleared on the next successful `apply`).
 */
export interface UseOptimisticState<T> {
	value: Accessor<T>;
	pending: Accessor<boolean>;
	lastError: Accessor<string | null>;
	apply: (next: T, runWrite: () => Promise<void>) => Promise<void>;
	onServerEcho: (serverValue: T) => void;
	reset: () => void;
	clearError: () => void;
}

export interface UseOptimisticStateOptions<T> {
	/** Required: how to read the current server-side value reactively. */
	serverValue: Accessor<T>;
	/** Equality used to detect matching echoes. Defaults to `Object.is`. */
	equals?: (a: T, b: T) => boolean;
	/** Default error message when the thrown value is not an Error. */
	fallbackError?: string;
}

interface OverlayState<T> {
	value: T;
	gen: number;
}

export function useOptimisticState<T>(
	options: UseOptimisticStateOptions<T>,
): UseOptimisticState<T> {
	const equals = options.equals ?? Object.is;
	const [overlay, setOverlay] = createSignal<OverlayState<T> | null>(null);
	const [pending, setPending] = createSignal(false);
	const [lastError, setLastError] = createSignal<string | null>(null);

	let opGen = 0;
	let inFlightWrites = 0;
	let writeChain: Promise<void> = Promise.resolve();
	let disposed = false;

	onCleanup(() => {
		disposed = true;
		opGen++;
	});

	const value = createMemo<T>(() => {
		const ov = overlay();
		if (ov) return ov.value;
		return options.serverValue();
	});

	const apply = async (
		next: T,
		runWrite: () => Promise<void>,
	): Promise<void> => {
		const gen = ++opGen;
		setOverlay({ value: next, gen });
		setPending(true);
		setLastError(null);
		inFlightWrites++;
		const myWrite = writeChain.then(async () => {
			try {
				await runWrite();
				// On success do nothing: the overlay is cleared by the
				// caller's onServerEcho when the matching state event
				// arrives. Until then the overlay keeps the UI consistent
				// with what the user just chose.
			} catch (err) {
				if (!disposed && opGen === gen) {
					setOverlay(null);
					const msg =
						err instanceof Error
							? err.message
							: (options.fallbackError ?? "Save failed");
					setLastError(msg);
				}
			} finally {
				inFlightWrites--;
				if (!disposed && opGen === gen) setPending(false);
			}
		});
		writeChain = myWrite.catch(() => undefined);
		return myWrite;
	};

	const onServerEcho = (serverValue: T): void => {
		const ov = overlay();
		if (!ov) return;
		if (equals(serverValue, ov.value) || inFlightWrites === 0) {
			setOverlay(null);
		}
	};

	// Auto-reconcile when the caller-provided serverValue accessor changes
	// (e.g. a RoomStateEvent.Events echo updates the underlying state via
	// useRoomStateContent). `defer: true` skips the initial value so we
	// don't clear an overlay that was set synchronously inside `apply`.
	createEffect(
		on(
			() => options.serverValue(),
			(next) => onServerEcho(next),
			{ defer: true },
		),
	);

	const reset = (): void => {
		opGen++;
		setOverlay(null);
		setLastError(null);
		setPending(false);
	};

	return {
		value,
		pending,
		lastError,
		apply,
		onServerEcho,
		reset,
		clearError: () => setLastError(null),
	};
}
