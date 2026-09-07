import type { Session } from "./session";

// Tab-scoped, including the OAuth round trip. Contains hashes, never tokens.
const KEY = "crust:logout-residue";
const remembered = new Set<string>();

function read(): Set<string> {
	try {
		const values: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
		if (Array.isArray(values)) {
			for (const value of values) {
				if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
					remembered.add(value);
			}
		}
	} catch {
		// A failed storage write during logout is precisely the recovery case.
	}
	return remembered;
}

async function fingerprint(session: Session): Promise<string> {
	const data = JSON.stringify([
		session.userId,
		session.deviceId,
		session.homeserverUrl,
		session.accessToken,
		session.refreshToken ?? null,
		session.oidc?.issuer ?? null,
		session.oidc?.clientId ?? null,
	]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(data),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Only the logout tail may authorize replacing its own exact credential. */
export async function rememberLogoutSession(session: Session): Promise<void> {
	const hash = await fingerprint(session);
	const values = read();
	values.add(hash);
	try {
		sessionStorage.setItem(KEY, JSON.stringify([...values]));
	} catch {
		// The same document can still recover even when sessionStorage is denied.
	}
}

/** Silence from another tab is never evidence that its account is disposable. */
export async function logoutResidue(sessions: Session[]): Promise<Session[]> {
	const hashes = read();
	if (hashes.size === 0) return [];
	const matches = await Promise.all(
		sessions.map(async (session) =>
			hashes.has(await fingerprint(session)) ? session : null,
		),
	);
	return matches.filter((session): session is Session => session !== null);
}

export function clearLogoutResidue(): void {
	remembered.clear();
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		// Any surviving hash still only matches the old, logged-out credential.
	}
}
