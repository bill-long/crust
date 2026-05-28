import type { BaseKeyProvider } from "livekit-client";
import type { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";

/**
 * Phase 4 — single-file E2EE adapter between matrix-js-sdk's
 * `MatrixRTCSession` and livekit-client's E2EE manager (issue #122).
 *
 * This is the project's flagged crypto boundary. Keep all
 * `livekit-client` E2EE imports in this file and inside the existing
 * dynamic-import chain so the LiveKit chunk + the e2ee worker stay
 * deferred until the user clicks "Join". Do NOT add other crypto
 * changes here.
 *
 * ## Ordering invariants (issue body — "the whole game")
 *  1. `room.setE2EEEnabled(true)` MUST resolve before `room.connect()`
 *     and before any track publish (enforced by `useLivekitRoom`).
 *  2. `attach(session, isLive)` MUST be called before
 *     `session.joinRoomSession(...)` so we don't miss the initial
 *     `EncryptionKeyChanged` burst (enforced by `useRtcSession`).
 *  3. `reemit(session)` (a.k.a. `session.reemitEncryptionKeys()`) MUST
 *     be called AFTER `attach` so already-negotiated keys are pumped
 *     through the bridge once it's wired (enforced by `useRtcSession`).
 *
 * Missing any of these → dropped initial media frames on every join.
 *
 * ## Race discipline
 * Mirrors `useLivekitRoom.ts`'s pattern: every new `await` introduced
 * by the bridge (the `crypto.subtle.importKey` step in particular)
 * captures the current epoch BEFORE the await and bails on mismatch
 * AFTER. The epoch bumps on `dispose()` so a late-arriving key from a
 * torn-down session can never call into the disposed worker.
 *
 * Per-event ordering is preserved with a single-flight promise queue —
 * `importKey` is async and could otherwise let key index N+1 land
 * before key index N, leaving the wrong key as the latest manually-set
 * index.
 */

/**
 * Per-LiveKit-Room binding returned by `bindRoom()`. Owns one
 * `keyProvider` + `worker` pair tied to a single `lk.Room` instance.
 *
 * LiveKit's `E2EEManager.setupEventListeners` attaches listeners on the
 * keyProvider that aren't unbound on `room.disconnect()`. Reusing the
 * same keyProvider across multiple Room instances therefore leaks one
 * set of listeners per Room — including the worker `postMessage` path
 * that fires on every `setKey`. We avoid that by making each Room own
 * a fresh `{keyProvider, worker}` and releasing both on teardown.
 *
 * `release()` is idempotent. It detaches this binding from the
 * relay (so cached keys stop being pumped into its dying keyProvider)
 * and terminates the worker.
 */
export interface RtcE2EERoomBinding {
	readonly e2eeOptions: { keyProvider: BaseKeyProvider; worker: Worker };
	release(): void;
}

export interface RtcE2EEContext {
	/**
	 * Subscribe to `MatrixRTCSession.EncryptionKeyChanged` and cache each
	 * key for later replay into per-Room bindings. MUST be called before
	 * `session.joinRoomSession(...)`. Returns a detach fn that is safe
	 * to call multiple times.
	 *
	 * `isLive` lets the consumer abort key delivery when its own attempt
	 * has been superseded (Leave click, Re-Join, hook teardown). It is
	 * checked both before and after the `importKey` await.
	 */
	attach(session: MatrixRTCSession, isLive: () => boolean): () => void;
	/**
	 * Pump any keys negotiated before `attach` ran. MUST be called AFTER
	 * `attach` and AFTER `joinRoomSession(...)`. The matrix-js-sdk
	 * `RTCEncryptionManager` is spun up inside `joinRoomSession`, so
	 * reemitting any earlier should be a no-op.
	 */
	reemit(session: MatrixRTCSession): void;
	/**
	 * Create a fresh `{keyProvider, worker}` for a single LiveKit
	 * `Room` instance. Caller MUST call `release()` when the Room is
	 * torn down (focus-change reconnect, leave, dispose). Calling
	 * `bindRoom()` again before releasing the previous binding is
	 * allowed — the previous binding stays usable until released, but
	 * NEW cached keys are only pumped into the most recently acquired
	 * binding (mirrors the "one Room at a time" invariant of LiveKit's
	 * E2EE manager).
	 *
	 * All keys cached by `attach` (and any received later) are replayed
	 * synchronously-as-async into the new binding's keyProvider so a
	 * focus-change reconnect doesn't drop frames that the relay already
	 * has the key material for.
	 */
	bindRoom(): RtcE2EERoomBinding;
	/**
	 * Tear down the relay. Idempotent. Detaches any still-attached
	 * listener, bumps the epoch so any in-flight `importKey` from a
	 * queued key event bails before touching a (potentially released)
	 * keyProvider, and releases any still-acquired bindings as a safety
	 * net — but callers (useLivekitRoom) are expected to release their
	 * own bindings first so worker termination happens AFTER
	 * `room.disconnect()` resolves.
	 */
	dispose(): void;
}

export interface CreateRtcE2EEContextOptions {
	/**
	 * Loader for the livekit-client module. Defaults to a dynamic import
	 * so the LiveKit chunk is only fetched on Join. Tests inject a
	 * synchronous loader returning a mock module (mirrors the pattern in
	 * `useLivekitRoom.ts`).
	 */
	loadLivekit?: () => Promise<typeof import("livekit-client")>;
	/**
	 * Factory for the LiveKit E2EE worker. Production resolves via
	 * Vite's `?worker` import. Tests inject a fake (jsdom doesn't
	 * support module workers and we don't want to spin a real one).
	 */
	createWorker?: () => Worker;
}

const importMatrixKey = async (keyBytes: Uint8Array): Promise<CryptoKey> => {
	// MatrixRTC delivers raw key material; LiveKit's `onSetEncryptionKey`
	// expects a HKDF-typed CryptoKey (matches `ExternalE2EEKeyProvider`
	// when fed an ArrayBuffer). Element Call uses the same import shape
	// so crust ↔ Element Call interop works without further derivation.
	//
	// Callers in this file already hand us a freshly-allocated Uint8Array
	// (copied at event-capture time in `onKey`), and per ECMA-262
	// 23.2.5.1 / AllocateTypedArrayBuffer `new Uint8Array(n)` is
	// guaranteed to allocate a dedicated ArrayBuffer of exactly `n`
	// bytes — so passing `.buffer` through cannot leak adjacent memory.
	// The `as ArrayBuffer` cast narrows away the `SharedArrayBuffer`
	// alternative in `ArrayBufferLike` (the union widened in recent TS
	// lib versions); we never construct a shared buffer here.
	return crypto.subtle.importKey(
		"raw",
		keyBytes.buffer as ArrayBuffer,
		"HKDF",
		false,
		["deriveBits", "deriveKey"],
	);
};

export async function createRtcE2EEContext(
	options: CreateRtcE2EEContextOptions = {},
): Promise<RtcE2EEContext> {
	const lk = await (options.loadLivekit ?? (() => import("livekit-client")))();
	// Pre-resolve the worker factory so `bindRoom()` can stay
	// synchronous — useLivekitRoom calls it inside the reactive connect
	// path where adding another async hop would multiply the stale-guard
	// surface. Tests inject `createWorker` directly; production resolves
	// the `?worker` constructor via Vite's worker plugin.
	const createWorker: () => Worker =
		options.createWorker ?? (await loadDefaultWorkerFactory());

	class MatrixRtcKeyProvider extends lk.BaseKeyProvider {
		async setMatrixKey(
			participantIdentity: string,
			cryptoKey: CryptoKey,
			keyIndex: number,
		): Promise<void> {
			// `onSetEncryptionKey` is `protected` on BaseKeyProvider —
			// this subclass exists solely to surface it. It synchronously
			// stores the key and emits a `setKey` event that the LiveKit
			// E2EEManager forwards to the worker.
			this.onSetEncryptionKey(cryptoKey, participantIdentity, keyIndex);
		}
	}

	let disposed = false;
	// Bumped on `dispose()` AND on every `attach()` so a stale listener's
	// in-flight `importKey` from a previous attach bails before reaching
	// any keyProvider. Capture-before-await, re-check-after-await mirrors
	// `useLivekitRoom.ts`.
	let epoch = 0;
	let activeDetach: (() => void) | null = null;

	// Serialise key processing in event-arrival order so two
	// EncryptionKeyChanged events emitted back-to-back can't race their
	// `importKey` resolutions and leave the wrong key as the latest
	// manually-set index in the keyProvider.
	let keyQueue: Promise<void> = Promise.resolve();

	// Cache of all keys received since `attach()`, keyed by participant
	// identity then by `keyIndex`. Replayed into every new binding so
	// focus-change Room recreation doesn't drop frames whose keys the
	// relay has already imported. Bounded only by the call's
	// key-rotation budget (a few dozen participants × a few indices).
	// Using a nested Map (rather than a composite string key) keeps the
	// identity bytes opaque — a future identity format containing any
	// separator character can't desync the cache.
	const keyCache = new Map<string, Map<number, CryptoKey>>();
	const cacheSet = (id: string, idx: number, key: CryptoKey): void => {
		let inner = keyCache.get(id);
		if (!inner) {
			inner = new Map();
			keyCache.set(id, inner);
		}
		inner.set(idx, key);
	};

	// The most recently acquired binding. New cached keys are pumped
	// only into this provider so two simultaneously-live bindings can't
	// fight over the latest key (mirrors LiveKit's "one Room per
	// E2EEManager" model). Older still-acquired bindings keep the keys
	// they already received until their owner calls `release()`.
	let activeBinding: {
		keyProvider: MatrixRtcKeyProvider;
		release(): void;
	} | null = null;

	// Tracks EVERY currently-acquired binding so `dispose()` can release
	// any the consumer forgot. Without this, a binding that's still
	// acquired but no longer the `activeBinding` (e.g. the consumer
	// dropped its reference without calling release) would leak its
	// worker on dispose.
	const acquiredBindings = new Set<{
		keyProvider: MatrixRtcKeyProvider;
		release(): void;
	}>();

	const pumpKey = (id: string, idx: number, cryptoKey: CryptoKey): void => {
		if (!activeBinding) return;
		activeBinding.keyProvider.setMatrixKey(id, cryptoKey, idx).catch(() => {
			// onSetEncryptionKey is synchronous; the wrapper above only
			// returns a Promise for symmetry with the import path — it
			// shouldn't throw, but swallow if it does so one bad key
			// doesn't kill the queue.
		});
	};

	const attach = (
		session: MatrixRTCSession,
		isLive: () => boolean,
	): (() => void) => {
		if (disposed) {
			throw new Error("RtcE2EEContext: attach called after dispose");
		}
		// Detach any previously-attached listener — only one consumer at
		// a time. Bumping epoch invalidates the previous queue's in-flight
		// imports so a late delivery from the old session can't pump a
		// key meant for the old call into the new one.
		activeDetach?.();
		const myEpoch = ++epoch;

		const onKey = (
			key: Uint8Array,
			keyIndex: number,
			_membership: unknown,
			rtcBackendIdentity: string,
		): void => {
			// Copy bytes IMMEDIATELY at capture time, not inside the
			// queued task. If the matrix-js-sdk reuses the same backing
			// ArrayBuffer across consecutive `EncryptionKeyChanged`
			// emissions (it currently allocates per-event, but the
			// defense costs nothing and protects us from a future SDK
			// optimisation that swaps to a pooled buffer), the queued
			// task could otherwise import the bytes from a LATER event
			// and silently bind the wrong key to this index.
			const keyCopy = new Uint8Array(key.byteLength);
			keyCopy.set(key);
			// Enqueue ordered processing. Each task captures `myEpoch`
			// and bails if either the consumer says we're no longer
			// live, the bridge has been disposed, or this listener was
			// detached and re-attached (epoch advanced).
			keyQueue = keyQueue.then(async () => {
				if (disposed || epoch !== myEpoch || !isLive()) return;
				try {
					const cryptoKey = await importMatrixKey(keyCopy);
					if (disposed || epoch !== myEpoch || !isLive()) return;
					cacheSet(rtcBackendIdentity, keyIndex, cryptoKey);
					pumpKey(rtcBackendIdentity, keyIndex, cryptoKey);
				} catch {
					// Swallow per-event errors so one bad key doesn't poison
					// the queue for subsequent valid keys. The keyProvider
					// will simply not have this index; LiveKit's decoder
					// surfaces an error if a remote frame uses it.
				}
			});
		};

		session.on(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);

		const detach = (): void => {
			if (activeDetach !== detach) return;
			session.off(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
			activeDetach = null;
			// Bump epoch so the queued importKey tasks (if any) bail
			// before they touch any keyProvider — even if dispose hasn't
			// happened yet (e.g., consumer re-attaches with a new
			// session after Leave → Re-Join in the same call view).
			epoch++;
		};
		activeDetach = detach;
		return detach;
	};

	const reemit = (session: MatrixRTCSession): void => {
		if (disposed) return;
		session.reemitEncryptionKeys();
	};

	const bindRoom = (): RtcE2EERoomBinding => {
		if (disposed) {
			throw new Error("RtcE2EEContext: bindRoom called after dispose");
		}
		const keyProvider = new MatrixRtcKeyProvider();
		const worker = createWorker();
		// Replay every cached key into the fresh keyProvider before
		// returning so the consumer's `new lk.Room({e2ee})` + connect
		// path observes a keyProvider that already knows about every
		// participant's current key. Without this, focus-change
		// reconnects would silently start with no keys until the next
		// rotation.
		for (const [id, indices] of keyCache) {
			for (const [idx, cryptoKey] of indices) {
				void keyProvider.setMatrixKey(id, cryptoKey, idx);
			}
		}

		let released = false;
		const binding = {
			keyProvider,
			release(): void {
				if (released) return;
				released = true;
				acquiredBindings.delete(binding);
				if (activeBinding === binding) activeBinding = null;
				try {
					worker.terminate();
				} catch {
					// Swallow — terminate() can throw on browsers that already
					// reclaimed the worker (e.g., page unload).
				}
			},
		};
		// Mark this binding as the one new cached keys go to. Older
		// bindings (if any are still acquired during a focus-change
		// teardown overlap) keep what they already received.
		acquiredBindings.add(binding);
		activeBinding = binding;
		return {
			e2eeOptions: { keyProvider, worker },
			release: binding.release,
		};
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		epoch++;
		activeDetach?.();
		// Safety net: release EVERY still-acquired binding if the
		// consumer forgot. Consumers (useLivekitRoom) are expected to
		// release first so `room.disconnect()` resolves before
		// worker.terminate() lands. Snapshot first because release()
		// mutates the set.
		for (const b of [...acquiredBindings]) b.release();
		activeBinding = null;
		keyCache.clear();
	};

	return {
		attach,
		reemit,
		bindRoom,
		dispose,
	};
}

// Lazy-resolve the LiveKit E2EE worker constructor via Vite's
// `?worker` import. Returns a factory that produces a fresh Worker
// per call. Kept inside its own function so test environments that
// always pass `createWorker` never trigger the `?worker` resolution
// — vitest's jsdom path won't try to bundle a real Worker constructor.
async function loadDefaultWorkerFactory(): Promise<() => Worker> {
	const mod = (await import("livekit-client/e2ee-worker?worker")) as {
		default: new () => Worker;
	};
	return () => new mod.default();
}
