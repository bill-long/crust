import type { AuthDict, MatrixClient } from "matrix-js-sdk";
import type { UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth";

/**
 * Signing other sessions out (#556). Distinct from `accountLogout.ts`,
 * which only ever revokes a session this browser holds credentials for -
 * these calls reach a device by id, so a session orphaned on another
 * machine is finally reachable.
 *
 * `DELETE /devices/{deviceId}` is UIA-gated but destroys nothing before
 * the auth dict lands: the unauthenticated attempt IS the challenge
 * discovery. That is why the flow driving it uses `uiaFlow`'s callback
 * half alone and never its preflight, which exists for the opposite case
 * (`resetEncryption` tears down backups before its UIA fires).
 *
 * Continuwuity wire contract, verified 2026-08-29: a password session
 * gets `401 {flows:[["m.login.password"]], params:null}` - issued even for
 * a device id that does not exist, so the challenge leaks nothing - and a
 * wrong password is refused with a ROTATED session plus
 * `errcode M_FORBIDDEN`, which the callback's re-prompt loop follows.
 */
export async function signOutDevice(
	client: MatrixClient,
	deviceId: string,
	uiaCallback: UIAuthCallback<void>,
): Promise<void> {
	// The callback hands `null` for the discovery attempt; deleteDevice takes
	// `AuthDict | undefined` and omits a falsy one from the body either way
	// (verified in the SDK source), so this is a type conversion, not a
	// behavioural one.
	await uiaCallback(async (auth: AuthDict | null) => {
		await client.deleteDevice(deviceId, auth ?? undefined);
	});
}
