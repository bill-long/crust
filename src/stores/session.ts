/**
 * The accounts logged in on this install, and which one is active (#532).
 *
 * Crust holds several accounts but runs exactly ONE at a time (Discord's
 * account-switcher shape, #531): a switch tears the client down and rebuilds it
 * against the newly active account, so there is never a second syncing client
 * or a second crypto store open. Everything downstream - `App.tsx`'s auth
 * guard, `ClientProvider`, the account-scoped stores - therefore keeps talking
 * about "the session", which is {@link loadSession}: the active account.
 *
 * Persistence lives under one key ({@link STORAGE_KEYS.session}) holding a
 * {@link SessionStore}. Two older shapes are migrated on load: a bare `Session`
 * under that key (pre-multi-account) and a bare `Session` under `crust_session`
 * (pre-#313). Both migrations are state-loss-safe - the old value is only
 * dropped once the new write has landed.
 */

import { createSignal } from "solid-js";
import {
	accountCryptoDbPrefix,
	CRYPTO_DB_PREFIX,
} from "../client/cryptoRecovery";
import { pushMediaAuthToSw } from "../lib/authedMedia";
import { safeLocalStorage } from "../lib/persistedSignal";
import {
	ACCOUNT_SCOPED_KEYS,
	accountScopedKey,
	LEGACY_STORAGE_KEYS,
	STORAGE_KEYS,
} from "../lib/storageKeys";

const SESSION_KEY = STORAGE_KEYS.session;
const LEGACY_SESSION_KEY = LEGACY_STORAGE_KEYS.session;

export interface Session {
	accessToken: string;
	/** OAuth 2.0 refresh token. Present only on OAuth2 (MSC3861) sessions. */
	refreshToken?: string;
	userId: string;
	deviceId: string;
	homeserverUrl: string;
	/**
	 * OAuth2 session metadata needed to refresh tokens across a reload:
	 * the OP issuer and this install's dynamically registered client_id.
	 * Absent on password sessions.
	 */
	oidc?: SessionOidc;
	/**
	 * IndexedDB database-name prefix for this account's Rust crypto store, fixed
	 * when the account is added and never changed afterwards - an existing store
	 * cannot be renamed, so rewriting this would silently orphan the account's
	 * keys and force re-verification. Assigned by {@link saveSession}; see
	 * `client/cryptoRecovery.ts` for how it isolates accounts from each other
	 * (and Crust from a co-hosted matrix-js-sdk app, #202).
	 */
	cryptoPrefix?: string;
	/**
	 * The account's display name as of the last time it was active, kept only so
	 * the switcher can label an account whose client is not running. Refreshed by
	 * the shell while the account IS active; absent until then, and the switcher
	 * falls back to the user ID. Never authoritative - the profile on the
	 * homeserver is.
	 */
	displayName?: string;
}

export interface SessionOidc {
	issuer: string;
	clientId: string;
}

/** Every account logged in on this install, plus the active one. */
interface SessionStore {
	/**
	 * The `userId` of the active account, or null when no account is logged in.
	 * Always the id of one of `sessions` when that array is non-empty.
	 */
	activeUserId: string | null;
	/** Accounts, deduplicated by `userId`. Order is add order. */
	sessions: Session[];
}

/**
 * A fresh logged-out store. A function, not a shared constant: `loadSessions()`
 * hands its `sessions` array to callers, and a module-level one would be the
 * same array every time - a caller that mutated it would corrupt every later
 * logged-out read.
 */
function emptyStore(): SessionStore {
	return { activeUserId: null, sessions: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isValidUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isSessionOidc(value: unknown): value is SessionOidc {
	if (!isRecord(value)) return false;
	return (
		typeof value.issuer === "string" &&
		value.issuer.length > 0 &&
		typeof value.clientId === "string" &&
		value.clientId.length > 0
	);
}

function isSession(value: unknown): value is Session {
	if (!isRecord(value)) return false;
	return (
		typeof value.accessToken === "string" &&
		value.accessToken.length > 0 &&
		(value.refreshToken === undefined ||
			(typeof value.refreshToken === "string" &&
				value.refreshToken.length > 0)) &&
		typeof value.userId === "string" &&
		value.userId.length > 0 &&
		typeof value.deviceId === "string" &&
		value.deviceId.length > 0 &&
		typeof value.homeserverUrl === "string" &&
		isValidUrl(value.homeserverUrl) &&
		(value.oidc === undefined || isSessionOidc(value.oidc)) &&
		(value.cryptoPrefix === undefined ||
			(typeof value.cryptoPrefix === "string" &&
				value.cryptoPrefix.length > 0)) &&
		(value.displayName === undefined || typeof value.displayName === "string")
	);
}

/**
 * Validate a stored {@link SessionStore}, dropping entries that fail validation
 * (one corrupt account must never log every account out) and duplicate user IDs
 * (first wins). An `activeUserId` that names no surviving account heals to the
 * first one rather than stranding the user on a logged-out app with accounts in
 * storage. Returns null when the value is not a session store at all.
 */
function parseStore(raw: unknown): SessionStore | null {
	if (!isRecord(raw) || !Array.isArray(raw.sessions)) return null;
	const sessions: Session[] = [];
	for (const entry of raw.sessions) {
		if (!isSession(entry)) continue;
		if (sessions.some((s) => s.userId === entry.userId)) continue;
		sessions.push(entry);
	}
	const first = sessions[0];
	if (first === undefined) return emptyStore();
	const claimed = raw.activeUserId;
	const activeUserId =
		typeof claimed === "string" && sessions.some((s) => s.userId === claimed)
			? claimed
			: first.userId;
	return { activeUserId, sessions };
}

/**
 * Promote a pre-multi-account bare `Session` to the store shape. The account
 * keeps the original global crypto prefix: its IndexedDB store already exists
 * under that name, and any other prefix would orphan it and force the user to
 * re-verify. Every account added after this one gets its own prefix.
 */
function storeFromLegacySession(session: Session): SessionStore {
	return {
		activeUserId: session.userId,
		sessions: [
			{ ...session, cryptoPrefix: session.cryptoPrefix ?? CRYPTO_DB_PREFIX },
		],
	};
}

/** Best-effort persist of the whole store. Returns true if the write landed. */
function writeStore(store: SessionStore): boolean {
	if (store.sessions.length === 0) {
		// Leave no empty husk behind: a logged-out install has no session key,
		// exactly as before multi-account.
		safeLocalStorage.remove(SESSION_KEY);
		return true;
	}
	return safeLocalStorage.set(SESSION_KEY, JSON.stringify(store));
}

/**
 * Move the pre-multi-account values of the per-account storage keys onto
 * `userId`, the first account this install ever files values under. Before
 * #532 these keys were install-global, so their values are whatever the last
 * user of this browser profile left behind - adopting them keeps `lastRoom`,
 * settings and recent emoji exactly where they were across the upgrade.
 *
 * Runs once: each unscoped value is removed as it is adopted, so the second
 * account added never sees them. A value that already exists under the scoped
 * key wins (the account's own value is never overwritten by the global one).
 */
function adoptUnscopedAccountKeys(userId: string): void {
	for (const base of ACCOUNT_SCOPED_KEYS) {
		const raw = safeLocalStorage.get(base);
		if (raw === null) continue;
		const scoped = accountScopedKey(base, userId);
		if (safeLocalStorage.get(scoped) === null) {
			// Keep the unscoped value for the next attempt if the write is
			// rejected (quota / disabled storage) rather than dropping it.
			if (!safeLocalStorage.set(scoped, raw)) continue;
		}
		safeLocalStorage.remove(base);
	}
}

/** JSON.parse that never throws; undefined for a malformed value. */
function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/** Read one storage key as a session store, tolerating both older shapes. */
function readKey(key: string): { store: SessionStore; legacy: boolean } | null {
	const raw = safeLocalStorage.get(key);
	const parsed = raw === null ? undefined : tryParseJson(raw);
	const store = parseStore(parsed);
	if (store !== null) return { store, legacy: false };
	if (isSession(parsed)) {
		return { store: storeFromLegacySession(parsed), legacy: true };
	}
	return null;
}

/**
 * The accounts on this install, migrating the older persisted shapes on first
 * load. Never throws: unusable storage reads as "no accounts".
 */
function readStore(): SessionStore {
	const current = readKey(SESSION_KEY);
	// An empty result counts as "nothing usable here", not as a logged-out
	// answer: the key may hold an empty husk or a store whose every entry failed
	// validation, and a still-valid legacy token must win over both rather than
	// being deleted as stale below.
	if (current !== null && current.store.sessions.length > 0) {
		if (current.legacy) {
			// A pre-multi-account bare Session: rewrite it in the store shape and
			// hand it the install-global per-account values. Best-effort - a failed
			// write just repeats the migration on the next load.
			migrateInto(current.store);
		}
		if (safeLocalStorage.get(SESSION_KEY) !== null) {
			// A usable value lives under the new key, so a coexisting legacy token is
			// stale: drop it rather than leave a valid credential readable. Guarded on
			// the new key actually holding it - a failed migration write leaves it
			// absent, and the legacy value is then still load bearing.
			safeLocalStorage.remove(LEGACY_SESSION_KEY);
		}
		return current.store;
	}
	// The new key was absent or unusable (corrupt / failed validation). Fall back
	// to a still-valid legacy `crust_session` value rather than stranding the user
	// logged out, and heal the split state by promoting it.
	const legacy = readKey(LEGACY_SESSION_KEY);
	if (legacy === null) return emptyStore();
	if (migrateInto(legacy.store)) safeLocalStorage.remove(LEGACY_SESSION_KEY);
	return legacy.store;
}

/**
 * Persist a migrated store and give its account the install-global per-account
 * values. Returns whether the write landed - the caller must keep the old value
 * when it did not, so nothing is lost to a rejected write.
 */
function migrateInto(store: SessionStore): boolean {
	if (!writeStore(store)) return false;
	if (store.activeUserId !== null) adoptUnscopedAccountKeys(store.activeUserId);
	return true;
}

/**
 * How many accounts may be logged in at once, matching Discord's switcher.
 * The limit is a product decision, not a technical one: each account costs a
 * persisted token and a crypto store on disk, and a list this size stays
 * scannable in one glance.
 */
export const MAX_ACCOUNTS = 5;

/**
 * Reactive mirrors of the persisted store, for UI that has to re-render when
 * accounts are added, removed or switched. The persisted value stays the source
 * of truth - these are published on every write below, and seeded here so the
 * migration in `readStore` runs before any account-scoped store reads its key.
 */
const initialStore = readStore();
const [accountsSignal, setAccountsSignal] = createSignal<Session[]>(
	initialStore.sessions,
);
const [activeAccountSignal, setActiveAccountSignal] = createSignal<
	string | null
>(initialStore.activeUserId);

/** Every account logged in on this install (reactive), in add order. */
export function accounts(): Session[] {
	return accountsSignal();
}

/** The active account's user ID (reactive), or null when logged out. */
export function activeAccount(): string | null {
	return activeAccountSignal();
}

/** Publish a written store to the reactive mirrors and the service worker. */
function publish(next: SessionStore): void {
	setAccountsSignal(next.sessions);
	setActiveAccountSignal(next.activeUserId);
	pushActiveMediaAuth(next);
}

/** The active account, or null when no account is logged in. */
export function loadSession(): Session | null {
	const store = readStore();
	return store.sessions.find((s) => s.userId === store.activeUserId) ?? null;
}

/** Every account logged in on this install, in add order. */
export function loadSessions(): Session[] {
	return readStore().sessions;
}

/**
 * The `userId` the per-account stores are currently filed under, or null when
 * no account is active. See `stores/accountScoped.ts`.
 */
export function activeAccountId(): string | null {
	return readStore().activeUserId;
}

type AccountScopeListener = (userId: string | null) => void;

const scopeListeners = new Set<AccountScopeListener>();

/**
 * Observe changes to the active account, so account-scoped stores can rebind to
 * the new account's storage keys. Fires only when the active account actually
 * changes (login, logout, switch), not on a token refresh for the same account.
 *
 * Cross-tab changes do not fire: like `loadSession`, this store reads through to
 * `localStorage` per call and does not watch `storage` events.
 */
export function subscribeAccountScope(
	listener: AccountScopeListener,
): () => void {
	scopeListeners.add(listener);
	return () => scopeListeners.delete(listener);
}

/**
 * True once a switch has committed but the replacement document has not loaded
 * yet. `window.location.assign` only STARTS a navigation - this document keeps
 * running, and its account-scoped stores must not follow the pointer in the
 * meantime, or the outgoing UI visibly re-zooms to the incoming account's
 * settings and any write in that window (a setting, the last room, a recent
 * emoji) is filed under the wrong account.
 */
let scopeFrozen = false;

/** Stop account-scoped state following the pointer; see {@link scopeFrozen}. */
export function freezeAccountScope(): void {
	scopeFrozen = true;
}

/** Undo {@link freezeAccountScope} when the switch it was armed for fell through. */
export function unfreezeAccountScope(): void {
	scopeFrozen = false;
}

/** Whether account-scoped storage is frozen for an in-flight switch. */
export function isAccountScopeFrozen(): boolean {
	return scopeFrozen;
}

function notifyScopeChange(previous: string | null, next: string | null): void {
	if (previous === next || scopeFrozen) return;
	for (const listener of scopeListeners) listener(next);
}

/**
 * Push the active account's credentials to the service worker so it can attach
 * them to authenticated-media requests (MSC3916, see lib/authedMedia.ts). Login
 * and OIDC token rotation both land here, so the worker always has the freshest
 * access token for the account actually on screen - and only for that one.
 */
function pushActiveMediaAuth(store: SessionStore): void {
	const active = store.sessions.find((s) => s.userId === store.activeUserId);
	pushMediaAuthToSw(
		active
			? {
					accessToken: active.accessToken,
					homeserverUrl: active.homeserverUrl,
				}
			: null,
	);
}

/**
 * Add (or replace) an account and make it the active one - the login path.
 * Re-logging in as an existing account keeps that account's crypto prefix: its
 * store is still on disk, so a new prefix would orphan it.
 */
export function saveSession(session: Session): void {
	if (!isSession(session)) {
		throw new Error("Refusing to persist invalid session data");
	}
	const store = readStore();
	const previousActive = store.activeUserId;
	const existing = store.sessions.find((s) => s.userId === session.userId);
	const entry: Session = {
		...session,
		// Derived, never taken from the caller: a `Session` built by spreading
		// another account's (`{ ...alice, userId: bob }`) would otherwise point Bob
		// at Alice's crypto store, and logging either out would wipe the other's
		// keys. Only an existing entry for this same account can supply a prefix,
		// because its database already exists under that name.
		cryptoPrefix:
			existing?.cryptoPrefix ?? accountCryptoDbPrefix(session.userId),
	};
	// A plain login REPLACES rather than appends. `/login` renders outside the
	// auth guard, so it is reachable while an account is already logged in;
	// appending there would silently keep the previous account's live access
	// token in storage with no UI to see or revoke it, and logging out of the new
	// account would drop the user back into the old one without re-authenticating.
	// Adding an account is a deliberate act with its own entry point:
	// {@link addSession}, reached only from the switcher's "Add account".
	const next: SessionStore = { activeUserId: entry.userId, sessions: [entry] };
	// Keep the raw write (not the best-effort helper): a failed session persist
	// must surface at login rather than silently logging the user out on reload.
	localStorage.setItem(SESSION_KEY, JSON.stringify(next));
	if (store.sessions.length === 0) {
		// First account on the install: it inherits the values the per-account
		// keys held while they were install-global.
		adoptUnscopedAccountKeys(entry.userId);
	}
	publish(next);
	notifyScopeChange(previousActive, entry.userId);
}

/**
 * Update an account already in the store, leaving the active account alone -
 * the token-refresh path. No-op (returns false) when the account is not
 * present, so a refresh that lands after its account was removed can never
 * resurrect it.
 */
export function updateSession(session: Session): boolean {
	if (!isSession(session)) {
		throw new Error("Refusing to persist invalid session data");
	}
	const store = readStore();
	const existing = store.sessions.find((s) => s.userId === session.userId);
	if (!existing) return false;
	// The crypto prefix is fixed when the account is added; a caller round-
	// tripping a session must not be able to move the account's crypto store.
	const entry: Session = { ...session, cryptoPrefix: existing.cryptoPrefix };
	const next: SessionStore = {
		activeUserId: store.activeUserId,
		sessions: store.sessions.map((s) =>
			s.userId === entry.userId ? entry : s,
		),
	};
	localStorage.setItem(SESSION_KEY, JSON.stringify(next));
	publish(next);
	return true;
}

/**
 * Log `userId` out of this install: the logout path, and exactly the same thing
 * the switcher does to a background account - so it goes through
 * {@link removeAccount} rather than growing a second, subtly different removal.
 * "Log out" means the same thing wherever it is invoked from, including that
 * the account's own per-account data leaves the device with it.
 *
 * The account is NAMED rather than taken to be "whoever storage calls active":
 * another tab may have switched since this document booted, and logging out
 * would then sign out an account the user never touched - without revoking its
 * token, since the caller revokes the one it is actually running.
 *
 * The account's crypto store is NOT wiped here; that is the caller's job and
 * only ever for the account being removed (see `clearCryptoStores`).
 *
 * Returns whether the account is gone from storage; see {@link removeAccount}
 * for why a caller has to care.
 */
export function clearSession(userId: string): boolean {
	const removed = removeAccount(userId);
	// Also drop any un-migrated legacy value so logout leaves no stale token
	// behind (e.g. if migration never ran or its write failed), even when there
	// was no account under the new key to remove.
	safeLocalStorage.remove(LEGACY_SESSION_KEY);
	pushActiveMediaAuth(readStore());
	return removed;
}

/**
 * Add an account alongside the ones already logged in and make it active - the
 * switcher's add-account path, and the ONLY way a second account comes into
 * being (a plain login replaces; see {@link saveSession}).
 *
 * Returns false when the install is already at {@link MAX_ACCOUNTS} and the
 * account is not one of them, so the caller can say so rather than silently
 * dropping the credential it just obtained. Re-adding an account that is
 * already stored replaces its entry and activates it, exactly like logging back
 * into it.
 */
export function addSession(session: Session): boolean {
	if (!isSession(session)) {
		throw new Error("Refusing to persist invalid session data");
	}
	const store = readStore();
	const previousActive = store.activeUserId;
	const existing = store.sessions.find((s) => s.userId === session.userId);
	if (!existing && store.sessions.length >= MAX_ACCOUNTS) return false;
	const entry: Session = {
		...session,
		// Same rule as saveSession: derived, never caller-supplied, so a new
		// account can never be pointed at another account's crypto store.
		cryptoPrefix:
			existing?.cryptoPrefix ?? accountCryptoDbPrefix(session.userId),
	};
	const next: SessionStore = {
		activeUserId: entry.userId,
		sessions: existing
			? store.sessions.map((s) => (s.userId === entry.userId ? entry : s))
			: [...store.sessions, entry],
	};
	// Raw write, like saveSession: a failed persist has to surface at login
	// rather than losing the account on the next reload.
	localStorage.setItem(SESSION_KEY, JSON.stringify(next));
	if (store.sessions.length === 0) adoptUnscopedAccountKeys(entry.userId);
	publish(next);
	notifyScopeChange(previousActive, entry.userId);
	return true;
}

/**
 * Make an already-stored account the active one. Returns false for an unknown
 * account (a stale switcher row, or a menu left open while the account was
 * removed in another tab) rather than leaving the store pointing at nothing.
 *
 * This ONLY flips the pointer. Tearing the outgoing client down and rebuilding
 * against the new account is the shell's job - see `app/accountSwitch.ts`.
 */
export function setActiveAccount(userId: string): boolean {
	const store = readStore();
	if (!store.sessions.some((s) => s.userId === userId)) return false;
	if (store.activeUserId === userId) return true;
	const next: SessionStore = { activeUserId: userId, sessions: store.sessions };
	if (!writeStore(next)) return false;
	publish(next);
	notifyScopeChange(store.activeUserId, userId);
	return true;
}

/**
 * Forget an account: drop its entry and every per-account value filed under it.
 * The next account in the list becomes active if the removed one was.
 *
 * Storage only. Revoking the token and wiping that account's crypto store are
 * the caller's job and must happen FIRST, while the credentials to do it are
 * still here (see `client/accountLogout.ts`).
 *
 * Returns whether the account is gone from storage afterwards - true also for
 * an account that was not there to begin with. FALSE means storage rejected the
 * write and the account is still listed, which matters to callers that have
 * already revoked its token: routing back into it would loop.
 */
export function removeAccount(userId: string): boolean {
	const store = readStore();
	const previousActive = store.activeUserId;
	const sessions = store.sessions.filter((s) => s.userId !== userId);
	if (sessions.length === store.sessions.length) return true;
	const next: SessionStore = {
		activeUserId:
			previousActive === userId
				? (sessions[0]?.userId ?? null)
				: previousActive,
		sessions,
	};
	// Everything below is destructive and unrecoverable, so it only happens once
	// the account is actually gone from storage. A rejected write (quota,
	// disabled storage) would otherwise delete the account's data while a
	// reload brings the account itself back - emptied.
	if (!writeStore(next)) return false;
	for (const base of ACCOUNT_SCOPED_KEYS) {
		safeLocalStorage.remove(accountScopedKey(base, userId));
	}
	publish(next);
	notifyScopeChange(previousActive, next.activeUserId);
	return true;
}

/**
 * Record the display name an account is currently known by, so the switcher can
 * label it while its client is not running. A no-op when the account is gone or
 * the name is unchanged, so the shell can call it from a profile effect without
 * writing storage on every sync.
 *
 * Three-state on purpose. `undefined` means "not known yet" - the profile has
 * not loaded - and leaves whatever is remembered alone; a caller wired to a
 * profile signal runs first with exactly that, and treating it as "no name"
 * would erase the label for an account switched away from before its first
 * sync, which is the case the field exists for. An empty string is the account
 * genuinely having no display name, and forgets the remembered one.
 */
export function rememberAccountDisplayName(
	userId: string,
	displayName: string | undefined,
): void {
	if (displayName === undefined) return;
	const name = displayName.trim() || undefined;
	const store = readStore();
	const existing = store.sessions.find((s) => s.userId === userId);
	if (!existing || existing.displayName === name) return;
	const entry: Session = { ...existing };
	if (name === undefined) delete entry.displayName;
	else entry.displayName = name;
	const next: SessionStore = {
		activeUserId: store.activeUserId,
		sessions: store.sessions.map((s) => (s.userId === userId ? entry : s)),
	};
	if (!writeStore(next)) return;
	publish(next);
}
