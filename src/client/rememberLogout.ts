import type { MatrixClient } from "matrix-js-sdk";
import { reportError } from "../lib/reportError";
import { rememberLogoutSession } from "../stores/logoutResidue";
import { loadSessions, type Session } from "../stores/session";

/** Preserve recovery evidence before a logout's best-effort storage removal. */
export async function rememberClientLogout(
	client: MatrixClient,
	session: Session,
): Promise<void> {
	try {
		const stored = loadSessions().find(
			(candidate) =>
				candidate.userId === session.userId &&
				candidate.deviceId === session.deviceId &&
				candidate.homeserverUrl === session.homeserverUrl &&
				candidate.accessToken === client.getAccessToken(),
		);
		if (stored) await rememberLogoutSession(stored);
	} catch (error) {
		// Recording recovery evidence must never prevent the logout itself.
		reportError(error, {
			logLabel: "Could not remember the departing session",
		});
	}
}
