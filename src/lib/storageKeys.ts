/**
 * Canonical registry of every `localStorage` key the app persists under, plus
 * the legacy keys it still migrates from (#313).
 *
 * Centralizing the strings here keeps the `crust:` namespace collision-free and
 * makes the full persistence surface auditable in one place. All current keys
 * use the `crust:` delimiter; a handful of older stores shipped under `crust_*`
 * and their values migrate to the `crust:` equivalent on first load - see
 * {@link LEGACY_STORAGE_KEYS} and the `legacyKey` option of
 * `createPersistedSignal` / `loadPersisted`.
 *
 * Keys fall into two classes (#532):
 *   - **Install-global** - one value for the browser profile, shared by every
 *     account: pane widths, layout, call-overlay size, the OIDC client
 *     registrations (which are per *install* per issuer, not per account),
 *     and the desktop shell's last live operator config (which is read before
 *     any account is, and carries the operator's keys, not a user's). They
 *     keep the bare key below.
 *   - **Per-account** - the values in {@link ACCOUNT_SCOPED_KEYS}, which belong
 *     to one Matrix user. Their real key is the bare key suffixed with the
 *     owning user ID (see {@link accountScopedKey}); the bare key exists only
 *     as the pre-multi-account value that the first account adopts on upgrade.
 *
 * Scope is `localStorage` only. `sessionStorage` keys (e.g. the crypto-recovery
 * marker in `client/cryptoRecovery.ts`) live with their owning module.
 */
export const STORAGE_KEYS = {
	session: "crust:session",
	lastRoom: "crust:last-room",
	lastChannel: "crust:last-channel",
	layout: "crust:layout",
	settings: "crust:settings",
	callOverlaySize: "crust:call-overlay-size",
	recentEmoji: "crust:recent-emoji",
	paneWidths: "crust:pane-widths",
	membersWidth: "crust:members-width",
	threadWidth: "crust:thread-width",
	oidcClientRegistrations: "crust:oidc-client-registrations",
	/** The desktop shell's last successfully read live config (#581). */
	remoteConfig: "crust:remote-config",
} as const;

/**
 * The {@link STORAGE_KEYS} entries whose values belong to a single account
 * rather than to the install. Each is persisted under
 * {@link accountScopedKey}`(base, userId)`; the bare key holds only the
 * pre-multi-account value, which the first account on the install adopts once
 * (see `adoptUnscopedAccountKeys` in `stores/session.ts`).
 *
 * `session` is deliberately absent: it is the store that *holds* every
 * account, so it is neither install-global nor scoped to one account.
 */
export const ACCOUNT_SCOPED_KEYS = [
	STORAGE_KEYS.lastRoom,
	STORAGE_KEYS.lastChannel,
	STORAGE_KEYS.settings,
	STORAGE_KEYS.recentEmoji,
] as const;

/**
 * The storage key holding `base`'s value for one account. Matrix user IDs are
 * globally unique (`@local:server`), so the suffix alone separates accounts,
 * including accounts on different homeservers.
 */
export function accountScopedKey(base: string, userId: string): string {
	return `${base}:${userId}`;
}

/**
 * Previous `crust_*` key names, retained only so their persisted values migrate
 * to the matching {@link STORAGE_KEYS} entry once, on first load. Do not write
 * to these; new writes always go to the `crust:` key.
 */
export const LEGACY_STORAGE_KEYS = {
	session: "crust_session",
	paneWidths: "crust_pane_widths",
	membersWidth: "crust_members_width",
	threadWidth: "crust_thread_width",
} as const;
