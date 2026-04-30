const SESSION_KEY = "crust_session";

export interface Session {
	accessToken: string;
	userId: string;
	deviceId: string;
	homeserverUrl: string;
}

export function loadSession(): Session | null {
	try {
		const raw = localStorage.getItem(SESSION_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (
			!parsed.accessToken ||
			!parsed.userId ||
			!parsed.deviceId ||
			!parsed.homeserverUrl
		) {
			return null;
		}
		return parsed as Session;
	} catch {
		return null;
	}
}

export function saveSession(session: Session): void {
	localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
	localStorage.removeItem(SESSION_KEY);
}
