import type { AuthDict, MatrixClient } from "matrix-js-sdk";
import type { UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth";

/**
 * Signing other sessions out, one at a time (#556) or all at once
 * (#557). Distinct from `accountLogout.ts`, which only ever revokes a
 * session this browser holds credentials for - these calls reach a device
 * by id, so a session orphaned on another machine is finally reachable.
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
 * wrong password is refused with `errcode M_FORBIDDEN` on the same UIA
 * session, which the callback's re-prompt loop retries against (it takes
 * whatever session the refusal names, so a server that DOES rotate is
 * handled by the same code).
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

/**
 * Sign out several sessions at once (#557) - `POST /delete_devices`, one
 * request for the whole set rather than one per device, so the user
 * confirms their identity once.
 *
 * The current device is removed from `deviceIds` here rather than only
 * being withheld by the caller: revoking the session this browser is
 * running in is logging out, which has its own flow (token disposal,
 * crypto teardown, per-account push release), and reaching it through
 * this call would leave the app holding a dead token with none of that
 * done. The UI hides the control for the current row too - this is the
 * mirror of that guard at the layer that sends the request.
 *
 * An empty set (after that filter) sends nothing: there is no device to
 * revoke, so the operation has already succeeded, and an empty
 * `POST /delete_devices` would still make the user answer a UIA challenge
 * to accomplish nothing.
 *
 * Wire-verified against Continuwuity separately rather than assumed from
 * the single-device route (2026-08-29), and it came back identical in
 * every respect that matters: the same 401 challenge, issued even for an
 * empty list or a device id that does not exist; the same completion on
 * the password auth dict; the same non-rotating refusal. That is why both
 * use `uiaFlow`'s callback half and neither uses its preflight.
 */
export async function signOutOtherDevices(
	client: MatrixClient,
	deviceIds: string[],
	uiaCallback: UIAuthCallback<void>,
): Promise<void> {
	const currentDeviceId = client.getDeviceId();
	const devices = deviceIds.filter((id) => id && id !== currentDeviceId);
	if (devices.length === 0) return;

	// As in signOutDevice: the callback hands `null` for the discovery
	// attempt, and deleteMultipleDevices omits a falsy auth from the body.
	await uiaCallback(async (auth: AuthDict | null) => {
		await client.deleteMultipleDevices(devices, auth ?? undefined);
	});
}
