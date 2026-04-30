const SESSION_KEY = "crust_session";

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
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!isSession(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function saveSession(session: Session): void {
	if (!isSession(session)) {
		throw new Error("Refusing to persist invalid session data");
	}
	localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
	localStorage.removeItem(SESSION_KEY);
}
