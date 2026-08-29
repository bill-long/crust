/**
 * Noticing that the boot has stopped making progress (#551).
 *
 * The app's boot has exactly one unbounded wait. Crypto initialization is
 * bounded on both branches - `CRYPTO_INIT_TIMEOUT_MS` for the store, a far
 * longer one for the WASM download - and a crypto failure is not fatal: it sets
 * `cryptoState` to "error" and the boot carries on. What follows has no bound at
 * all. `startClient` awaits `/versions` and then the first `/sync`, and a
 * homeserver that accepts the connection and never answers leaves both pending
 * forever, with `syncState` still "initial" and nothing on screen but a spinner.
 *
 * Before #549 the way out of that was to type `/login`, which worked by
 * REPLACING the stored account - orphaning its device and token on the server,
 * which is the harm #549 exists to prevent. So the escape had to be closed, and
 * this is how the app offers a real one instead: while the boot sits in the
 * phase that can hang, arm a timer, and when it fires let the screen show the
 * same way out the sync-error screen already offers.
 */

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

/**
 * How long the boot may sit in its unbounded phase before the escape appears.
 *
 * Generous on purpose: Crust uses `MemoryStore`, so every load is a full
 * initial sync (#324) rather than an incremental one, and the control this
 * gates logs the account out - showing it during a boot that was merely slow
 * invites a user to throw away a session that was about to arrive.
 *
 * It does not remove that risk, and no wall-clock number can: a full initial
 * sync for a large account on a slow link can outrun any threshold short enough
 * to be useful to someone genuinely stuck, and the boot offers no progress
 * signal to gate on instead - `syncState` goes from "initial" straight to
 * "live", with nothing in between to observe. So the delay buys the common case
 * and the copy carries the rest: it leads with waiting, and names what logging
 * out costs, because the control is a deliberate click and not an automatic
 * action.
 */
export const BOOT_STALL_MS = 30_000;

/**
 * True once the boot has been waiting for {@link BOOT_STALL_MS} without leaving
 * the phase `waiting` describes.
 *
 * `waiting` is the caller's "still in the phase that can hang", not merely "not
 * finished": the timer must NOT cover crypto initialization, which is bounded
 * already and can legitimately spend minutes downloading the WASM module on a
 * first visit. Arming it there would put the escape in front of a user whose
 * boot is healthy and simply slow.
 *
 * Leaving the phase disarms and RESETS: a boot that recovers takes its escape
 * hatch away with it, so a later stall gets a full delay of its own rather than
 * inheriting a flag from the first.
 */
export function createBootStall(waiting: () => boolean): () => boolean {
	const [stalled, setStalled] = createSignal(false);
	// Memoized, and that is what makes the effect below safe to write plainly.
	// `waiting` is a predicate over several signals (the caller's reads
	// `syncState` AND `cryptoState`), so used directly it would re-run the effect
	// on every change to any of them - including changes that leave the answer
	// true, which arms a SECOND timer over the first: one leaked timer per
	// change, each of them still holding a reference to this root. A memo
	// notifies on the VALUE changing, so every run below is a genuine entry into
	// or exit from the phase - and an entry can never find a timer already armed,
	// because the exit that preceded it cleared one.
	const inPhase = createMemo(waiting);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const disarm = (): void => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
	};

	createEffect(() => {
		if (!inPhase()) {
			disarm();
			setStalled(false);
			return;
		}
		timer = setTimeout(() => {
			timer = undefined;
			setStalled(true);
		}, BOOT_STALL_MS);
	});

	// The screen this arms is unmounted the moment the boot finishes, and a timer
	// left running past that would set a signal nothing reads - and, in tests,
	// outlive the root that owns it.
	onCleanup(disarm);

	return stalled;
}
