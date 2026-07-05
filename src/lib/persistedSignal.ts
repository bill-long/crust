import { type Accessor, createSignal, untrack } from "solid-js";

/**
 * localStorage access that never throws. Reads/writes can fail (disabled
 * storage, quota exceeded, private mode), and persistence is always
 * best-effort - a failed write must not break the app.
 */
export const safeLocalStorage = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string): void {
		try {
			localStorage.setItem(key, value);
		} catch {
			// best-effort
		}
	},
	remove(key: string): void {
		try {
			localStorage.removeItem(key);
		} catch {
			// best-effort
		}
	},
};

/**
 * Read a JSON value from a `crust:` storage key, returning `initial` when the
 * key is absent, the contents aren't valid JSON, or `parse` throws. Structural
 * validation is `parse`'s job: it receives the parsed value and returns its own
 * fallback (often `initial`) for parseable-but-invalid input. The non-reactive
 * counterpart to `createPersistedSignal` for load-on-demand stores.
 */
export function loadPersisted<T>(
	key: string,
	parse: (raw: unknown) => T,
	initial: T,
): T {
	const raw = safeLocalStorage.get(key);
	if (raw === null) return initial;
	try {
		return parse(JSON.parse(raw));
	} catch {
		return initial;
	}
}

/**
 * Best-effort JSON persist to a `crust:` storage key. Never throws: an
 * unserializable value (cyclic reference, BigInt, ...) is dropped rather than
 * propagating out of `JSON.stringify`.
 */
export function savePersisted(key: string, value: unknown): void {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		return;
	}
	// JSON.stringify returns undefined (not a throw) for undefined / functions /
	// symbols; writing that would store the literal string "undefined", which
	// then fails to re-parse on load. Drop it.
	if (json === undefined) return;
	safeLocalStorage.set(key, json);
}

export interface PersistedSignal<T> {
	/** Reactive accessor for the current value. */
	get: Accessor<T>;
	/**
	 * Set a new value (or apply a functional updater) and persist it. A set that
	 * yields a value referentially equal to the current one - via an updater
	 * returning prev, or a direct same-reference value - is a full no-op: no
	 * subscriber notification and no storage write.
	 */
	set: (next: T | ((prev: T) => T)) => void;
	/** Reset to the initial value and clear persistence (logout / test helper). */
	reset: () => void;
}

/**
 * A module-level signal backed by localStorage under a single `crust:` key.
 *
 * Centralizes the `try { getItem; JSON.parse; validate } catch { default }` +
 * best-effort save pattern that was copy-pasted across the stores (#313).
 *
 * @param key     The `crust:`-namespaced storage key.
 * @param parse   Validates/coerces the JSON-parsed value into `T`. Return the
 *                fallback (e.g. the initial value) for structurally invalid
 *                input rather than throwing; a JSON *syntax* error is caught
 *                here and also yields `initial`.
 * @param initial The value used when nothing valid is stored.
 * @param options.legacyKey  A previous key to migrate from: if `key` is absent
 *                but `legacyKey` is present, its raw value is copied to `key`
 *                and the legacy key removed, on first load.
 */
export function createPersistedSignal<T>(
	key: string,
	parse: (raw: unknown) => T,
	initial: T,
	options?: { legacyKey?: string },
): PersistedSignal<T> {
	const legacyKey = options?.legacyKey;

	const load = (): T => {
		if (legacyKey && safeLocalStorage.get(key) === null) {
			// One-time migration: adopt the legacy value under the new key.
			const legacy = safeLocalStorage.get(legacyKey);
			if (legacy !== null) {
				safeLocalStorage.set(key, legacy);
				safeLocalStorage.remove(legacyKey);
			}
		}
		return loadPersisted(key, parse, initial);
	};

	const [get, setSignal] = createSignal<T>(load());

	const set = (next: T | ((prev: T) => T)): void => {
		// untrack the read: callers set from inside tracked scopes (e.g. the
		// lastRoom/lastChannel recording effects in Layout), and reading get()
		// tracked would subscribe those write-only effects to the store they
		// write - an extra run per update and broken isolation. The functional
		// updater sees the current value without creating a dependency.
		const current = untrack(get);
		const value =
			typeof next === "function" ? (next as (prev: T) => T)(current) : next;
		// No-op when an updater returns the previous value (referential): skip
		// the redundant notify and storage write.
		if (value === current) return;
		setSignal(() => value);
		savePersisted(key, value);
	};

	const reset = (): void => {
		setSignal(() => initial);
		safeLocalStorage.remove(key);
		if (legacyKey) safeLocalStorage.remove(legacyKey);
	};

	return { get, set, reset };
}
