import { revokeAccountToken } from "../../client/accountLogout";
import { clearLogoutResidue, logoutResidue } from "../../stores/logoutResidue";
import {
	commitLoginSession,
	freezeAccountScope,
	loadSessions,
	type Session,
	unfreezeAccountScope,
} from "../../stores/session";
import { withSessionLock } from "../../stores/sessionLock";

/** Shared by password and OAuth login, including stale and add-account forms. */
export async function persistLogin(
	session: Session,
	adding: boolean,
): Promise<boolean> {
	let committed = false;
	try {
		// Serialize login read/modify/write across tabs, including two forms
		// completing together before either has mounted a ClientProvider.
		if (!navigator.locks)
			throw new Error(
				"This browser cannot safely save your login. Please use an updated browser.",
			);
		return await withSessionLock(async () => {
			const previous = loadSessions();
			const departed = await logoutResidue(previous);
			// A reload prevents module-level state from the previous account
			// surviving a login that was originally opened as a plain form.
			const reload = adding || previous.length > 0;
			if (reload) freezeAccountScope();
			try {
				commitLoginSession(session, departed);
				committed = true;
			} finally {
				if (reload && !committed) unfreezeAccountScope();
			}
			clearLogoutResidue();
			return reload;
		});
	} catch (error) {
		// A rejected persist already minted a device. Revoke only that new
		// credential; never touch a stored account to make room for it.
		if (
			!committed &&
			!loadSessions().some(
				(stored) =>
					stored.userId === session.userId &&
					stored.deviceId === session.deviceId &&
					stored.accessToken === session.accessToken,
			)
		)
			await revokeAccountToken(session);
		throw error;
	}
}
