import {
	ClientEvent,
	ClientPrefix,
	createClient,
	HttpApiEvent,
	type MatrixClient,
	Method,
	SyncState,
} from "matrix-js-sdk";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";
import {
	createContext,
	createEffect,
	createSignal,
	onCleanup,
	onMount,
	type ParentComponent,
	useContext,
} from "solid-js";
import {
	type CryptoStatus,
	useCryptoStatus,
} from "../features/crypto/useCryptoStatus";
import { loadSession, type Session } from "../stores/session";
import { updateAppBadge } from "./appBadge";
import {
	CRYPTO_INIT_TIMEOUT_MS,
	clearCryptoStores,
	clearRecoveryStage,
	initCryptoStore,
	persistRecoveryStage,
	readRecoveryStage,
	recoveryIdentity,
	runCryptoInit,
} from "./cryptoRecovery";
import {
	canReuseCachedSecretStorageKey,
	resolveSecretStorageKey,
} from "./secretStorageKey";
import {
	createSummariesStore,
	type OptimisticJoinInfo,
	type SummariesStore,
} from "./summaries";
import { getTotalUnread } from "./summaries-selectors";
import { attachUrlPreviewAccountDataSync } from "./urlPreviewSync";

export type AppSyncState =
	| "initial"
	| "catching-up"
	| "live"
	| "error"
	| "logged-out"
	| "stopped";

export type CryptoState = "loading" | "ready" | "error";

interface ClientContextValue {
	client: MatrixClient;
	syncState: () => AppSyncState;
	cryptoState: () => CryptoState;
	summaries: SummariesStore;
	cryptoStatus: CryptoStatus;
	/**
	 * Optimistically populate a "joined" summary entry for `roomId` so the
	 * room appears in the joined-channels list and is removed from any
	 * space-Discover list immediately on join, without waiting for /sync to
	 * deliver authoritative state (see #132). The eventual `ClientEvent.Room`
	 * handler will overwrite the stub with authoritative data.
	 */
	optimisticallyMarkJoined: (roomId: string, info: OptimisticJoinInfo) => void;
	/**
	 * Optimistically flip `roomId`'s summary entry to "leave" so it disappears
	 * from all join-filtered lists (channels, spaces sidebar) immediately when
	 * the user leaves, without waiting for the leave-membership /sync event.
	 * Call after `client.leave()` resolves. Idempotent; the eventual sync
	 * confirms the same "leave" state.
	 */
	optimisticallyMarkLeft: (roomId: string) => void;
	/**
	 * Request the recovery key from the user. Components that show a
	 * recovery key input dialog should call setRecoveryKeyResolver to
	 * register themselves.
	 */
	requestRecoveryKey: (
		validate?: (key: Uint8Array<ArrayBuffer>) => Promise<boolean>,
	) => Promise<Uint8Array<ArrayBuffer> | null>;
	setRecoveryKeyResolver: (
		resolver:
			| ((
					validate?: (key: Uint8Array<ArrayBuffer>) => Promise<boolean>,
			  ) => Promise<Uint8Array<ArrayBuffer> | null>)
			| null,
	) => void;
	/** Clear cached secret storage key so the next access re-prompts.
	 *  Call from error handlers when a secret-storage operation fails. */
	clearSecretStorageCache: () => void;
}

const ClientContext = createContext<ClientContextValue>();

/**
 * Exported for the browser-mode test harness in `src/test/`. Production
 * code must continue to use `<ClientProvider>` and `useClient()` —
 * importing the context directly bypasses the SDK / crypto lifecycle.
 */
export { ClientContext };

export const ClientProvider: ParentComponent<{ session: Session }> = (
	props,
) => {
	// In-memory cache for the secret storage key. Cached optimistically
	// after user entry so rapid successive SDK calls (e.g. 3x during
	// bootstrapCrossSigning) don't re-prompt. Top-level error handlers
	// call clearSecretStorageCache() on failure so retries re-prompt.
	let cachedSecretStorageKeyId: string | null = null;
	let cachedSecretStorageKey: Uint8Array<ArrayBuffer> | null = null;

	const clearSecretStorageCache = (): void => {
		cachedSecretStorageKeyId = null;
		cachedSecretStorageKey = null;
	};

	// Pluggable resolver for when the user needs to enter their recovery key.
	// The optional validate callback lets the dialog reject a well-formed but
	// incorrect key (and re-prompt) before it is used to encrypt secrets.
	let recoveryKeyResolver:
		| ((
				validate?: (key: Uint8Array<ArrayBuffer>) => Promise<boolean>,
		  ) => Promise<Uint8Array<ArrayBuffer> | null>)
		| null = null;

	const setRecoveryKeyResolver = (
		resolver:
			| ((
					validate?: (key: Uint8Array<ArrayBuffer>) => Promise<boolean>,
			  ) => Promise<Uint8Array<ArrayBuffer> | null>)
			| null,
	): void => {
		recoveryKeyResolver = resolver;
	};

	const requestRecoveryKey = async (
		validate?: (key: Uint8Array<ArrayBuffer>) => Promise<boolean>,
	): Promise<Uint8Array<ArrayBuffer> | null> => {
		if (recoveryKeyResolver) {
			return recoveryKeyResolver(validate);
		}
		return null;
	};

	const matrixClient = createClient({
		baseUrl: props.session.homeserverUrl,
		accessToken: props.session.accessToken,
		userId: props.session.userId,
		deviceId: props.session.deviceId,
		cryptoCallbacks: {
			getSecretStorageKey: async (
				opts: {
					keys: Record<string, SecretStorageKeyDescription>;
				},
				_name: string,
			): Promise<[string, Uint8Array<ArrayBuffer>] | null> => {
				// Return cached key for rapid successive calls. The cached id
				// may be absent from this call's (stale) offered set — reuse
				// is still sound while it remains the account's default key.
				if (
					cachedSecretStorageKeyId &&
					cachedSecretStorageKey &&
					canReuseCachedSecretStorageKey(
						cachedSecretStorageKeyId,
						opts.keys,
						await matrixClient.secretStorage.getDefaultKeyId(),
					)
				) {
					return [cachedSecretStorageKeyId, cachedSecretStorageKey];
				}

				if (Object.keys(opts.keys).length === 0) return null;

				// Resolve WHICH key to validate against at use time, not when the
				// prompt is created: the SDK's offered key set is a snapshot, and
				// account data can change while the recovery-key dialog is open
				// (e.g. another client re-keys 4S via "Change recovery key").
				// Validating against the stale snapshot rejects the genuine
				// current recovery key (issue #420), so prefer the default key's
				// description fetched fresh from the server.
				const fetchKeyInfo = async (
					keyId: string,
				): Promise<SecretStorageKeyDescription | null> => {
					const userId = matrixClient.getUserId();
					if (!userId) return null;
					try {
						return await matrixClient.http.authedRequest<SecretStorageKeyDescription>(
							Method.Get,
							`/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(`m.secret_storage.key.${keyId}`)}`,
							undefined,
							undefined,
							{ prefix: ClientPrefix.V3 },
						);
					} catch {
						// 404 (no such key) or any transient failure: treat as
						// unavailable so resolution falls back to the offered set.
						return null;
					}
				};

				const resolveChoice = () =>
					resolveSecretStorageKey({
						offeredKeys: opts.keys,
						getDefaultKeyId: () => matrixClient.secretStorage.getDefaultKeyId(),
						fetchKeyInfo,
					});

				// Prompt user for recovery key, validating it against the chosen
				// key's metadata before it is used to encrypt secrets. A
				// well-formed but incorrect key would otherwise corrupt existing
				// secret storage when used on a write path (see issue #205).
				// The choice the candidate validated against is captured and
				// reused below — resolving a second time could pick a
				// different key if 4S is re-keyed mid-prompt (issue #420).
				let validatedChoice:
					| Awaited<ReturnType<typeof resolveChoice>>
					| undefined;
				const key = await requestRecoveryKey(async (candidate) => {
					const choice = await resolveChoice();
					if (!choice) return false;
					try {
						const ok = await matrixClient.secretStorage.checkKey(
							candidate,
							choice.keyInfo,
						);
						if (ok) validatedChoice = choice;
						return ok;
					} catch {
						return false;
					}
				});
				if (!key) return null;

				const keyId = validatedChoice?.keyId ?? Object.keys(opts.keys)[0];

				// Cache for successive calls within the same operation
				cachedSecretStorageKeyId = keyId;
				cachedSecretStorageKey = key;
				return [keyId, key];
			},
			cacheSecretStorageKey: (
				keyId: string,
				_keyInfo: SecretStorageKeyDescription,
				key: Uint8Array<ArrayBuffer>,
			): void => {
				cachedSecretStorageKeyId = keyId;
				cachedSecretStorageKey = key;
			},
		},
	});

	const [syncState, setSyncState] = createSignal<AppSyncState>("initial");
	const [cryptoState, setCryptoState] = createSignal<CryptoState>("loading");
	// Reactive so the app-badge effect below can gate on it: until the first
	// /sync has prepared and populated `summaries`, the store is empty and the
	// badge must not be touched (see the effect comment).
	const [hasPrepared, setHasPrepared] = createSignal(false);
	let disposed = false;
	let detachUrlPreviewSync: (() => void) | null = null;

	const {
		summaries,
		init: initSummaries,
		cleanup: cleanupSummaries,
		optimisticallyMarkJoined,
		optimisticallyMarkLeft,
	} = createSummariesStore(matrixClient);

	// Keep the OS/taskbar app badge in sync with live unread state while this
	// window is open, so it clears the moment a message is read rather than
	// staying stale until the next push (see #269). The service worker handles
	// the closed-app case from push payloads (`src/sw.ts`).
	createEffect(() => {
		// Session ended: clear immediately rather than waiting for unmount.
		if (syncState() === "logged-out") {
			updateAppBadge(0);
			return;
		}
		// Until the first /sync has prepared, `summaries` is empty and
		// getTotalUnread would be 0 — writing that would wrongly clear a badge
		// the service worker set from a background push before we know the real
		// count. Leave the badge untouched until we have authoritative data.
		if (!hasPrepared()) return;
		updateAppBadge(getTotalUnread(summaries));
	});

	// The OS app badge is a single resource shared by every window/tab. Another
	// window clearing it on teardown — or the service worker writing a push
	// count — can leave this window's badge stale. Re-assert our authoritative
	// count whenever we become visible, so the window the user is actually
	// looking at always wins. No-op before the first sync (nothing authoritative
	// yet) and harmless if the Badging API is unavailable.
	const reassertBadgeOnVisible = (): void => {
		if (typeof document === "undefined") return;
		if (document.visibilityState !== "visible" || !hasPrepared()) return;
		// Mirror the effect: once the session has ended the badge stays cleared,
		// so a tab switch between logout and unmount can't flash the stale count.
		if (syncState() === "logged-out") return;
		updateAppBadge(getTotalUnread(summaries));
	};
	if (typeof document !== "undefined") {
		document.addEventListener("visibilitychange", reassertBadgeOnVisible);
	}

	const onSync = (state: SyncState): void => {
		// "logged-out" is terminal — don't let later sync events overwrite it
		if (syncState() === "logged-out") return;

		switch (state) {
			case SyncState.Prepared:
				// Populate `summaries` before flipping the prepared flag the badge
				// effect gates on, so the effect never observes hasPrepared=true with
				// an empty store (which would clear an SW-set badge). createEffect is
				// deferred so this is already safe today; the ordering makes the
				// "prepared implies summaries populated" invariant explicit and robust
				// if the effect ever becomes synchronous.
				initSummaries();
				setHasPrepared(true);
				if (!detachUrlPreviewSync && !disposed) {
					detachUrlPreviewSync = attachUrlPreviewAccountDataSync(matrixClient);
				}
				setSyncState("live");
				break;
			case SyncState.Syncing:
				if (hasPrepared()) {
					setSyncState("live");
				}
				break;
			case SyncState.Catchup:
			case SyncState.Reconnecting:
				if (hasPrepared()) {
					setSyncState("catching-up");
				}
				break;
			case SyncState.Error:
				setSyncState("error");
				break;
			case SyncState.Stopped:
				setSyncState("stopped");
				break;
		}
	};

	matrixClient.on(ClientEvent.Sync, onSync);

	const onSessionLoggedOut = (): void => {
		matrixClient.stopClient();
		setSyncState("logged-out");
	};
	matrixClient.on(HttpApiEvent.SessionLoggedOut, onSessionLoggedOut);

	onMount(async () => {
		const result = await runCryptoInit({
			identity: recoveryIdentity(props.session),
			readStage: readRecoveryStage,
			persistStage: persistRecoveryStage,
			clearStage: clearRecoveryStage,
			clearStores: () => clearCryptoStores(matrixClient),
			initCrypto: () => initCryptoStore(matrixClient),
			isAborted: () => disposed || syncState() === "logged-out",
			reload: () => window.location.reload(),
			timeoutMs: CRYPTO_INIT_TIMEOUT_MS,
		});
		if (result === "reloading" || result === "aborted") return;
		setCryptoState(result === "ready" ? "ready" : "error");
		if (disposed || syncState() === "logged-out") return;
		matrixClient.startClient({
			initialSyncLimit: 20,
			// Partitions m.thread relations into per-thread timelines instead
			// of the room's timeline sets (Room.eventShouldLiveIn). The
			// timeline / preview / notification / search gates rely on this
			// and additionally skip thread replies by shape (lib/threadEvents).
			threadSupport: true,
		});
	});

	const cryptoStatus = useCryptoStatus(
		matrixClient,
		() => syncState() === "live",
	);

	onCleanup(() => {
		disposed = true;
		if (typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", reassertBadgeOnVisible);
		}
		// Clear the badge only when the session has actually ended, not on a
		// plain reload or window close. Every logout path (Layout.handleLogout,
		// App.handleForceLogout, and the expired-session effect) calls
		// clearSession() before this unmount, so loadSession() is null then; on a
		// reload the session persists, so we leave the badge for the next load /
		// other open windows rather than wiping a still-valid count.
		if (loadSession() === null) {
			updateAppBadge(0);
		}
		detachUrlPreviewSync?.();
		detachUrlPreviewSync = null;
		cleanupSummaries();
		matrixClient.removeListener(ClientEvent.Sync, onSync);
		matrixClient.removeListener(
			HttpApiEvent.SessionLoggedOut,
			onSessionLoggedOut,
		);
		matrixClient.stopClient();
	});

	return (
		<ClientContext.Provider
			value={{
				client: matrixClient,
				syncState,
				cryptoState,
				summaries,
				cryptoStatus,
				optimisticallyMarkJoined,
				optimisticallyMarkLeft,
				requestRecoveryKey,
				setRecoveryKeyResolver,
				clearSecretStorageCache,
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};

export function useClient(): ClientContextValue {
	const ctx = useContext(ClientContext);
	if (!ctx) throw new Error("useClient must be used within ClientProvider");
	return ctx;
}
