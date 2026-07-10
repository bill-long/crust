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
	// Migrates a legacy `crust_session` value to `crust:session` on first load.
	const session = loadPersisted<Session | null>(
		SESSION_KEY,
		(raw) => (isSession(raw) ? raw : null),
		null,
		{ legacyKey: LEGACY_SESSION_KEY },
	);
	// The migration only removes the legacy key when it performed the copy; if
	// both keys already coexisted it leaves the legacy value untouched. For a
	// session that means a still-valid access token would linger under the old
	// name. Drop it - but only once the value is safely under the new key, so a
	// failed migration write (which left `crust:session` absent) never loses it.
	if (safeLocalStorage.get(SESSION_KEY) !== null) {
		safeLocalStorage.remove(LEGACY_SESSION_KEY);
	}
	return session;
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
