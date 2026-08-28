/**
 * Persistence that belongs to one account rather than to the install (#532).
 *
 * `lastRoom`, `lastChannel`, `settings` and `recentEmoji` describe a Matrix
 * user, not a browser profile: with more than one account logged in, a single
 * install-global value would show account B the room A was last reading and
 * hand B the notification preferences A chose. Each of these is filed under
 * {@link accountScopedKey}`(base, activeUserId)` instead.
 *
 * Stores built here are module-level singletons that outlive any one account,
 * so they rebind when the active account changes (login, logout, and Phase 2's
 * switch): {@link subscribeAccountScope} fires and the signal re-reads from the
 * new account's key. With no active account there is nowhere to file the value,
 * so reads fall back to the initial value and writes stay in memory.
 */
import {
	createPersistedSignalFor,
	type PersistedSignal,
} from "../lib/persistedSignal";
import { accountScopedKey } from "../lib/storageKeys";
import { activeAccountId, subscribeAccountScope } from "./session";

/** The storage key `base`'s value lives under right now, or null if logged out. */
export function currentAccountKey(base: string): string | null {
	const userId = activeAccountId();
	return userId === null ? null : accountScopedKey(base, userId);
}

/**
 * A {@link createPersistedSignal} whose value belongs to the active account.
 * Identical in use; it just follows the account.
 */
export function createAccountScopedSignal<T>(
	base: string,
	parse: (raw: unknown) => T,
	initial: T,
): PersistedSignal<T> {
	const signal = createPersistedSignalFor(
		() => currentAccountKey(base),
		parse,
		initial,
	);
	subscribeAccountScope(() => signal.reload());
	return signal;
}
