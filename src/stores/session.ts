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
			(typeof value.cryptoPrefix === "string" && value.cryptoPrefix.length > 0))
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

function notifyScopeChange(previous: string | null, next: string | null): void {
	if (previous === next) return;
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
	// Phase 1 REPLACES rather than appends. `/login` renders outside the auth
	// guard, so it is reachable while an account is already logged in; appending
	// there would silently keep the previous account's live access token in
	// storage with no UI to see or revoke it, and logging out of the new account
	// would drop the user back into the old one without re-authenticating. There
	// is no add-account entry point until the switcher ships (#533), which adds
	// one deliberately - and the crypto-store isolation this phase lands is
	// exactly what makes that safe to do.
	const next: SessionStore = { activeUserId: entry.userId, sessions: [entry] };
	// Keep the raw write (not the best-effort helper): a failed session persist
	// must surface at login rather than silently logging the user out on reload.
	localStorage.setItem(SESSION_KEY, JSON.stringify(next));
	if (store.sessions.length === 0) {
		// First account on the install: it inherits the values the per-account
		// keys held while they were install-global.
		adoptUnscopedAccountKeys(entry.userId);
	}
	pushActiveMediaAuth(next);
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
	pushActiveMediaAuth(next);
	return true;
}

/**
 * Remove the active account and activate the next remaining one (none, on a
 * single-account install - the logout path). The removed account's own stores
 * are NOT touched here; wiping them is the caller's job, and only ever for the
 * account being removed (see `clearCryptoStores`).
 */
export function clearSession(): void {
	const store = readStore();
	const previousActive = store.activeUserId;
	const sessions = store.sessions.filter((s) => s.userId !== previousActive);
	const next: SessionStore = {
		activeUserId: sessions[0]?.userId ?? null,
		sessions,
	};
	writeStore(next);
	// Also drop any un-migrated legacy value so logout leaves no stale token
	// behind (e.g. if migration never ran or its write failed).
	safeLocalStorage.remove(LEGACY_SESSION_KEY);
	pushActiveMediaAuth(next);
	notifyScopeChange(previousActive, next.activeUserId);
}
