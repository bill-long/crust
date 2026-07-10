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
} as const;

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
