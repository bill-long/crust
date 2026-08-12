import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { ClientEvent } from "matrix-js-sdk";
import { createSignal } from "solid-js";

/**
 * Session-wide reactive view of the account's `m.ignored_user_list`.
 * Written by `initIgnoredUsers` (Layout, once per session), refreshed by
 * the SDK's AccountData events (so blocks made in Settings or by another
 * client land without a reload), and updated optimistically by
 * {@link setUserIgnored} after a successful write. Consumed by the member
 * list (Block/Unblock row action) and the timeline (sender collapsing).
 *
 * Scope decision (#304): ignored senders are collapsed in the timeline but
 * NOT filtered out of notifications. Element hides ignored senders' events
 * from both; we keep notifications because a collapse keeps the messages
 * one click away while a notification filter would silently drop mentions
 * with no in-app record. Revisit if hiding proves insufficient.
 */

/** The account-data event type carrying the ignore list. Not in the SDK's
    EventType enum. */
const IGNORED_USER_LIST_TYPE = "m.ignored_user_list";

const [ignoredUsers, setIgnoredUsers] = createSignal<string[]>([]);

export { ignoredUsers };

export function isUserIgnored(userId: string): boolean {
	return ignoredUsers().includes(userId);
}

let listeningClient: MatrixClient | null = null;

function refreshFromClient(): void {
	if (!listeningClient) return;
	setIgnoredUsers(listeningClient.getIgnoredUsers() ?? []);
}

const onAccountData = (event: MatrixEvent): void => {
	if (event.getType() !== IGNORED_USER_LIST_TYPE) return;
	refreshFromClient();
};

/**
 * Bind the store to the session's client. Idempotent for the same client;
 * re-binds (dropping the old listener) when the client changes.
 */
export function initIgnoredUsers(client: MatrixClient): void {
	if (listeningClient === client) return;
	cleanupIgnoredUsers();
	listeningClient = client;
	refreshFromClient();
	client.on(ClientEvent.AccountData, onAccountData);
}

export function cleanupIgnoredUsers(): void {
	if (listeningClient) {
		listeningClient.off(ClientEvent.AccountData, onAccountData);
		listeningClient = null;
	}
	setIgnoredUsers([]);
}

/**
 * Add or remove `userId` from the ignore list, persisting via
 * `client.setIgnoredUsers`. The signal only updates after the write
 * succeeds, so a failed PUT can't paint the UI into a blocked state the
 * server never recorded. Re-reads the current list from the client (not
 * the signal) so a concurrent change from another surface can't be
 * clobbered by a stale copy. Throws on failure; the caller owns the error
 * surface.
 */
export async function setUserIgnored(
	client: MatrixClient,
	userId: string,
	ignored: boolean,
): Promise<void> {
	const current = client.getIgnoredUsers() ?? [];
	const next = ignored
		? current.includes(userId)
			? current
			: [...current, userId]
		: current.filter((id) => id !== userId);
	if (next.length === current.length && ignored === current.includes(userId))
		return;
	await client.setIgnoredUsers(next);
	setIgnoredUsers(next);
}

/** Test-only: reset the store and drop any listener between tests. */
export function _resetIgnoredUsersForTests(): void {
	cleanupIgnoredUsers();
}
