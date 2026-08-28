import type { MatrixClient } from "matrix-js-sdk";

/**
 * MSC2965 account-management deeplink actions Crust knows how to build.
 * The server advertises which of these it supports in its auth metadata
 * (`account_management_actions_supported`).
 */
export const ACCOUNT_MANAGEMENT_ACTIONS = {
	crossSigningReset: "org.matrix.cross_signing_reset",
} as const;

export type AccountManagementAction =
	(typeof ACCOUNT_MANAGEMENT_ACTIONS)[keyof typeof ACCOUNT_MANAGEMENT_ACTIONS];

/**
 * The URL of the homeserver's account-management page, deeplinked to
 * `action` when the server advertises support for it (MSC2965), otherwise
 * the page's base URL. Null when the server has no OAuth auth metadata, no
 * `account_management_uri`, or a non-web one (the URL is opened in a new
 * tab, so anything but http(s) must not get through).
 *
 * Fetched at time of use rather than persisted at login so pre-existing
 * sessions work and a server that moves its account UI is never linked
 * stale.
 */
export async function fetchAccountManagementUrl(
	client: MatrixClient,
	action: AccountManagementAction,
): Promise<string | null> {
	let uri: string | undefined;
	let actions: string[] | undefined;
	try {
		const metadata = await client.getAuthMetadata();
		uri = metadata.account_management_uri;
		actions = metadata.account_management_actions_supported;
	} catch {
		// No delegated auth (or the metadata endpoint is unreachable) - there
		// is no account-management page to link to.
		return null;
	}
	if (!uri) return null;
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (actions?.includes(action)) {
		url.searchParams.set("action", action);
	}
	return url.toString();
}
