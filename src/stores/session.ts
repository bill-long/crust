import { loadPersisted, safeLocalStorage } from "../lib/persistedSignal";
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "../lib/storageKeys";

const SESSION_KEY = STORAGE_KEYS.session;
const LEGACY_SESSION_KEY = LEGACY_STORAGE_KEYS.session;

export interface Session {
	accessToken: string;
	userId: string;
	deviceId: string;
	homeserverUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isValidUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isSession(value: unknown): value is Session {
	if (!isRecord(value)) return false;
	return (
		typeof value.accessToken === "string" &&
		value.accessToken.length > 0 &&
		typeof value.userId === "string" &&
		value.userId.length > 0 &&
		typeof value.deviceId === "string" &&
		value.deviceId.length > 0 &&
		typeof value.homeserverUrl === "string" &&
		isValidUrl(value.homeserverUrl)
	);
}

export function loadSession(): Session | null {
	const validate = (raw: unknown): Session | null =>
		isSession(raw) ? raw : null;
	// Prefer the new key, migrating a legacy `crust_session` value under it on
	// first load (state-loss-safe: a failed migration write keeps the legacy key).
	const session = loadPersisted<Session | null>(SESSION_KEY, validate, null, {
		legacyKey: LEGACY_SESSION_KEY,
	});
	if (session !== null) {
		// A valid session was loaded. If it now lives under the new key, drop any
		// coexisting legacy token so a still-valid credential isn't left readable
		// in storage. Guard on the new key actually holding it: a failed migration
		// write leaves `crust:session` absent, and we must not delete the legacy
		// value we just loaded from and are still relying on.
		if (safeLocalStorage.get(SESSION_KEY) !== null) {
			safeLocalStorage.remove(LEGACY_SESSION_KEY);
		}
		return session;
	}
	// The new key was absent or unusable (corrupt / failed validation). Fall back
	// to a still-valid legacy value rather than stranding the user logged out.
	const legacySession = loadPersisted<Session | null>(
		LEGACY_SESSION_KEY,
		validate,
		null,
	);
	if (legacySession !== null) {
		// Heal the split state: promote the recovered value to the new key
		// (overwriting a corrupt one) and drop the legacy token once the write
		// lands - same state-loss-safe rule as the migration, so a failed write
		// just keeps the legacy value for the next load.
		if (safeLocalStorage.set(SESSION_KEY, JSON.stringify(legacySession))) {
			safeLocalStorage.remove(LEGACY_SESSION_KEY);
		}
	}
	return legacySession;
}

export function saveSession(session: Session): void {
	if (!isSession(session)) {
		throw new Error("Refusing to persist invalid session data");
	}
	// Keep the raw write (not the best-effort helper): a failed session persist
	// must surface at login rather than silently logging the user out on reload.
	localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
	safeLocalStorage.remove(SESSION_KEY);
	// Also drop any un-migrated legacy value so logout leaves no stale token
	// behind (e.g. if migration never ran or its write failed).
	safeLocalStorage.remove(LEGACY_SESSION_KEY);
}
