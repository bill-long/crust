import type { MatrixClient } from "matrix-js-sdk";
import { webUrlOrNull } from "../lib/uia";

/**
 * MSC2965 account-management deeplink actions Crust knows how to build.
 * The server advertises which of these it supports in its auth metadata
 * (`account_management_actions_supported`).
 */
export const ACCOUNT_MANAGEMENT_ACTIONS = {
	crossSigningReset: "org.matrix.cross_signing_reset",
	accountDeactivate: "org.matrix.account_deactivate",
} as const;

export type AccountManagementAction =
	(typeof ACCOUNT_MANAGEMENT_ACTIONS)[keyof typeof ACCOUNT_MANAGEMENT_ACTIONS];

/**
 * The URL of the homeserver's account-management page, deeplinked to
 * `action` when one is given and the server advertises support for it
 * (MSC2965), otherwise the page's base URL (also the right target for
 * management tasks MSC2965 defines no action for, e.g. changing the
 * password). Null when the server has no OAuth auth metadata, no
 * `account_management_uri`, or a non-web one (the URL is opened in a new
 * tab, so anything but http(s) must not get through).
 *
 * Fetched at time of use rather than persisted at login so pre-existing
 * sessions work and a server that moves its account UI is never linked
 * stale.
 */
export async function fetchAccountManagementUrl(
	client: MatrixClient,
	action?: AccountManagementAction,
): Promise<string | null> {
	const mgmt = await fetchAccountManagement(client);
	return mgmt && accountManagementDeeplink(mgmt, action);
}

/** What the auth metadata says about the account-management page. */
export interface AccountManagement {
	/** Validated web URL of the page. */
	uri: string;
	actions: string[];
}

/**
 * The server's account-management page, or null when there is none (no
 * OAuth auth metadata, no `account_management_uri`, or a non-web one -
 * these URLs are opened in a new tab, so anything but http(s) must not
 * get through). One metadata round-trip; derive any number of deeplinks
 * from the result with {@link accountManagementDeeplink}.
 */
export async function fetchAccountManagement(
	client: MatrixClient,
): Promise<AccountManagement | null> {
	try {
		const metadata = await client.getAuthMetadata();
		const uri = webUrlOrNull(metadata.account_management_uri);
		if (!uri) return null;
		return {
			uri,
			actions: metadata.account_management_actions_supported ?? [],
		};
	} catch {
		// No delegated auth (or the metadata endpoint is unreachable) - there
		// is no account-management page to link to.
		return null;
	}
}

/**
 * Deeplink into the account-management page for `action` when the server
 * advertises it (MSC2965), else the page's base URL - also the right
 * target for tasks MSC2965 defines no action for (e.g. password changes).
 */
export function accountManagementDeeplink(
	mgmt: AccountManagement,
	action?: AccountManagementAction,
): string {
	const url = new URL(mgmt.uri);
	if (action && mgmt.actions.includes(action)) {
		url.searchParams.set("action", action);
	}
	return url.toString();
}
