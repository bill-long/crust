/**
 * Self-healing recovery for Rust crypto initialization.
 *
 * `initRustCrypto` can fail in two ways that the user cannot recover from on
 * their own:
 *   1. It rejects (e.g. a corrupt or partially-written IndexedDB crypto store
 *      left behind by an earlier failed init).
 *   2. It hangs forever (a half-initialized store can leave the open call
 *      pending with no resolution), leaving the app stuck on
 *      "Initializing encryption…".
 *
 * We cannot clear the store in-process while a hung init still holds an
 * IndexedDB connection — `indexedDB.deleteDatabase` would block on the open
 * connection. A full page reload tears down the hung call and its connection,
 * so recovery is staged across reloads and tracked in `sessionStorage`:
 *
 *   null    → first attempt. On failure: reload once (handles transient hangs
 *             without destroying keys).
 *   reload  → second attempt after a plain reload. On failure: the store is
 *             likely corrupt, so escalate to "clear" and reload again.
 *   clear   → next load wipes the Matrix SDK + Rust crypto stores before
 *             re-initializing (safe: no init is in flight on a fresh load).
 *             On failure: give up and surface the error banner.
 *
 * Staging is bounded (null → reload → clear → error), so it can never loop.
 *
 * Tradeoff: the "clear" stage is reached after any two consecutive init
 * failures, including repeated timeouts — we deliberately do NOT gate it on a
 * specific corruption error, because the original failure mode is a hang that
 * never rejects with a recognizable message. The wipe is destructive (it
 * resets this device's crypto identity and drops room keys that are not in key
 * backup), but it is the only way to heal a corrupt or hung store, and it only
 * fires after a plain reload has already failed to recover. Users with key
 * backup configured have their room keys restored automatically afterward; the
 * actionable encryption banner routes everyone else to set up secure messaging.
 *
 * The persisted stage is scoped to the logged-in identity so that a stale
 * stage left by a previous account can never trigger a destructive store wipe
 * for a different account logged in later in the same tab.
 */

export type CryptoRecoveryStage = "reload" | "clear" | null;

export const CRYPTO_RECOVERY_KEY = "crust:crypto-init-recovery";

/**
 * Maximum time to wait for `initRustCrypto` (or the recovery `clearStores`)
 * before treating it as hung. Both are local IndexedDB + WASM operations that
 * complete in well under this even for large stores, so the timeout only trips
 * on a real hang (e.g. a `deleteDatabase` blocked by another open connection).
 */
export const CRYPTO_INIT_TIMEOUT_MS = 30_000;

interface PersistedRecovery {
	stage: "reload" | "clear";
	id: string;
}

/**
 * A stable key for the logged-in identity. The recovery stage is only honored
 * when it matches the current identity, preventing a stale stage from one
 * account from wiping another account's store.
 */
export function recoveryIdentity(session: {
	homeserverUrl: string;
	userId: string;
	deviceId: string;
}): string {
	return `${session.homeserverUrl}|${session.userId}|${session.deviceId}`;
}

/** Decide the next recovery stage after a failed crypto init attempt. */
export function nextCryptoRecoveryStage(
	current: CryptoRecoveryStage,
): "reload" | "clear" | "give-up" {
	if (current === null) return "reload";
	if (current === "reload") return "clear";
	return "give-up";
}

/** Whether the crypto store should be wiped before initializing on this load. */
export function shouldClearStoreBeforeInit(
	current: CryptoRecoveryStage,
): boolean {
	return current === "clear";
}

/**
 * Read the persisted recovery stage for `identity`, tolerating unavailable or
 * malformed storage. A stage persisted for a different identity is ignored.
 */
export function readRecoveryStage(identity: string): CryptoRecoveryStage {
	try {
		const raw = sessionStorage.getItem(CRYPTO_RECOVERY_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PersistedRecovery>;
		if (parsed.id !== identity) return null;
		return parsed.stage === "reload" || parsed.stage === "clear"
			? parsed.stage
			: null;
	} catch {
		return null;
	}
}

/**
 * Persist the next recovery stage for `identity`. Returns false if storage is
 * unavailable (e.g. private mode) — the caller must then avoid reloading, since
 * an untracked stage would loop.
 */
export function persistRecoveryStage(
	stage: "reload" | "clear",
	identity: string,
): boolean {
	try {
		const value: PersistedRecovery = { stage, id: identity };
		sessionStorage.setItem(CRYPTO_RECOVERY_KEY, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

/** Clear the persisted recovery stage (called once crypto init settles). */
export function clearRecoveryStage(): void {
	try {
		sessionStorage.removeItem(CRYPTO_RECOVERY_KEY);
	} catch {
		// Storage unavailable — nothing to clear.
	}
}

/**
 * Reject if `promise` does not settle within `ms`. Handlers are attached to
 * the original promise so a late rejection never surfaces as unhandled.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export type CryptoInitResult = "ready" | "error" | "reloading" | "aborted";

export interface CryptoInitDeps {
	/** Stable identity key for the logged-in session (see recoveryIdentity). */
	identity: string;
	/** Read the persisted recovery stage for the identity. */
	readStage: (identity: string) => CryptoRecoveryStage;
	/** Persist the next recovery stage; returns false if storage is unavailable. */
	persistStage: (stage: "reload" | "clear", identity: string) => boolean;
	/** Remove the persisted recovery stage. */
	clearStage: () => void;
	/** Wipe the Matrix SDK + Rust crypto stores (used on the "clear" stage). */
	clearStores: () => Promise<void>;
	/** Initialize Rust crypto. */
	initCrypto: () => Promise<void>;
	/** True once the provider was disposed or the session logged out. */
	isAborted: () => boolean;
	/** Trigger a full page reload. */
	reload: () => void;
	/** Timeout for both clearStores and initCrypto. */
	timeoutMs: number;
	logger?: Pick<Console, "warn" | "error">;
}

/**
 * Run the staged, self-healing crypto initialization. Returns:
 *   - "ready":     crypto initialized successfully.
 *   - "error":     initialization failed and recovery is exhausted.
 *   - "reloading": a recovery reload was triggered; the caller must stop.
 *   - "aborted":   the provider was disposed / logged out mid-flight.
 *
 * The persisted recovery stage is preserved ONLY when reloading (so it
 * survives the reload). On every other outcome — success, exhausted error,
 * or abort — the stage is cleared, so a disposal mid-await can never leave a
 * stale stage that biases the next same-identity login toward a premature
 * store wipe.
 */
export async function runCryptoInit(
	deps: CryptoInitDeps,
): Promise<CryptoInitResult> {
	const logger = deps.logger ?? console;
	const stage = deps.readStage(deps.identity);
	let reloading = false;
	try {
		if (shouldClearStoreBeforeInit(stage)) {
			// Two prior attempts failed; the persisted store is likely corrupt.
			// Wipe the Matrix SDK + Rust crypto stores before re-initializing.
			// Safe here: no init is in flight on a fresh page load, so there is
			// no open IndexedDB connection to block deleteDatabase. The timeout
			// guards against a deleteDatabase blocked by another tab; on timeout
			// the catch gives up (stage is already "clear") rather than hanging.
			logger.warn(
				"Clearing Matrix SDK + Rust crypto stores before re-initializing",
			);
			await withTimeout(
				deps.clearStores(),
				deps.timeoutMs,
				"Crypto store clear",
			);
			if (deps.isAborted()) return "aborted";
		}
		await withTimeout(
			deps.initCrypto(),
			deps.timeoutMs,
			"Rust crypto initialization",
		);
		if (deps.isAborted()) return "aborted";
		return "ready";
	} catch (e) {
		if (deps.isAborted()) return "aborted";
		// Stage the next recovery step. A plain reload first (handles transient
		// hangs without destroying keys), then a store wipe.
		const next = nextCryptoRecoveryStage(stage);
		if (next !== "give-up" && deps.persistStage(next, deps.identity)) {
			reloading = true;
			logger.warn(
				`Crypto init failed; reloading to recover (stage: ${next})`,
				e,
			);
			deps.reload();
			return "reloading";
		}
		logger.error("Crypto init failed; encryption unavailable.", e);
		return "error";
	} finally {
		if (!reloading) deps.clearStage();
	}
}
