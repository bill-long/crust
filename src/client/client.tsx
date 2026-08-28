import { initAsync as loadCryptoModule } from "@matrix-org/matrix-sdk-crypto-wasm";
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
import { VerificationMethod } from "matrix-js-sdk/lib/types";
import {
	createContext,
	createEffect,
	createSignal,
	onCleanup,
	onMount,
	type ParentComponent,
	useContext,
} from "solid-js";
import { createOidcTokenRefreshFn } from "../features/auth/oidcRefresh";
import {
	type CryptoStatus,
	useCryptoStatus,
} from "../features/crypto/useCryptoStatus";
import { loadSession, type Session } from "../stores/session";
import { userSettings } from "../stores/settings";
import { updateAppBadge } from "./appBadge";
import {
	CRYPTO_INIT_TIMEOUT_MS,
	CRYPTO_MODULE_LOAD_TIMEOUT_MS,
	clearCryptoStores,
	clearRecoveryStage,
	initCryptoStore,
	persistRecoveryStage,
	readRecoveryStage,
	recoveryIdentity,
	runCryptoInit,
} from "./cryptoRecovery";
import { attachPresence, recordSelfPresence } from "./presence";
import {
	applySyncPresence,
	attachPresencePublisher,
	setPresenceSharing,
} from "./presencePublish";
import { RecoveryKeyCancelledError } from "./recoveryKeyCancelled";
import type { SidebarRoomTag } from "./roomTags";
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
	/**
	 * The account this provider was built for. Consumers that touch account-owned
	 * storage (crypto stores) must pass THIS rather than re-reading the active
	 * session, so a wipe can only ever hit the account on screen (#532).
	 */
	session: Session;
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
	 * Optimistically populate (or flip) a summary entry to `membership:
	 * "knock"` after `client.knockRoom` resolves, so the room shows in the
	 * sidebar's Requests section before /sync confirms. The eventual
	 * authoritative update overwrites the stub. Idempotent.
	 */
	optimisticallyMarkKnocked: (roomId: string, info: OptimisticJoinInfo) => void;
	/**
	 * Optimistically flip `roomId`'s summary entry to "leave" so it disappears
	 * from all join-filtered lists (channels, spaces sidebar) immediately when
	 * the user leaves, without waiting for the leave-membership /sync event.
	 * Call after `client.leave()` resolves. Idempotent; the eventual sync
	 * confirms the same "leave" state.
	 */
	optimisticallyMarkLeft: (roomId: string) => void;
	/**
	 * Optimistically flip `roomId`'s marked-unread flag (MSC2867) so the
	 * sidebar indicator reacts instantly when the user marks or opens a
	 * room, without waiting for the `m.marked_unread` account-data
	 * round-trip. The authoritative account-data sync confirms or corrects
	 * it. Callers normally go through `markRoomUnread` /
	 * `clearRoomMarkedUnread` (see `client/markedUnread.ts`) rather than
	 * calling this directly.
	 */
	optimisticallySetMarkedUnread: (roomId: string, value: boolean) => void;
	/**
	 * Optimistically flip a sidebar tag flag (m.favourite / m.lowpriority)
	 * so the row moves section instantly when the user toggles it. The
	 * authoritative RoomEvent.Tags update confirms or corrects it. Callers
	 * normally go through `toggleRoomTag` (see `client/roomTags.ts`).
	 */
	optimisticallySetRoomTag: (
		roomId: string,
		tag: SidebarRoomTag,
		value: boolean,
	) => void;
	/**
	 * Optimistically set a space's `im.vector.web.space_order` string so
	 * the rail re-sorts instantly on a manual move. The authoritative
	 * account-data sync confirms or corrects it. Callers normally go
	 * through `moveRootSpace` (see `client/spaceOrder.ts`).
	 */
	optimisticallySetSpaceOrder: (roomId: string, order: string | null) => void;
	/**
	 * Drop a forgotten room from the SDK store and the summary store.
	 * Call only after `client.forget(roomId, false)` succeeded AND the
	 * router has left the room, so a routed view never renders a
	 * just-deleted room.
	 */
	forgetRoomLocally: (roomId: string) => void;
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

/**
 * Verification methods advertised to the other party (#452).
 *
 * Deliberately narrower than the SDK's default, which also includes
 * `m.qr_code.scan.v1`: Crust has no camera capture path, so advertising scan
 * support would invite the other device to display a QR code we can never
 * read, stranding the flow. What we do support is showing a code for the
 * other device to scan, confirming its scan (`m.reciprocate.v1`), and emoji
 * comparison as the universal fallback.
 */
const SUPPORTED_VERIFICATION_METHODS = [
	VerificationMethod.Sas,
	VerificationMethod.ShowQrCode,
	VerificationMethod.Reciprocate,
];

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
		// OAuth2 (MSC3861) sessions only: rotate access tokens at the OP instead
		// of dying at expiry. Undefined for password sessions (no refresh
		// token), leaving their behavior unchanged (#460).
		refreshToken: props.session.refreshToken,
		tokenRefreshFunction: createOidcTokenRefreshFn(props.session),
		// Required for MatrixClient.getEventTimeline and
		// TimelineWindow.load(eventId) - both throw synchronously without it.
		// Off-cache pinned messages (#485) and jump-to-event for messages
		// outside the loaded window depend on those /context fetches; the SDK
		// disables them by default only because old clients relied on
		// timeline-set identity assumptions Crust does not make.
		timelineSupport: true,
		verificationMethods: SUPPORTED_VERIFICATION_METHODS,
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
					} catch (e) {
						// 404 means the key genuinely isn't in account data — fall
						// back to the offered set. Anything else (network, 5xx) is
						// infrastructure: propagate so the prompt can blame the
						// connection instead of the user's key.
						if ((e as { httpStatus?: number }).httpStatus === 404) {
							return null;
						}
						throw e;
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
					// No try/catch around checkKey: a throw here is infrastructure
					// failure (crypto store, SDK state), not a key mismatch — let it
					// propagate so RecoveryKeyInput can report a connection problem
					// instead of "Incorrect recovery key".
					const ok = await matrixClient.secretStorage.checkKey(
						candidate,
						choice.keyInfo,
					);
					if (ok) validatedChoice = choice;
					return ok;
				});
				// Typed so the operation's dialog can tell a dismissed prompt from
				// a real failure (the SDK would otherwise report a null here as
				// "callback returned falsey").
				if (!key) throw new RecoveryKeyCancelledError();

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
		optimisticallyMarkKnocked,
		optimisticallyMarkLeft,
		optimisticallySetMarkedUnread,
		optimisticallySetRoomTag,
		optimisticallySetSpaceOrder,
		forgetRoomLocally,
	} = createSummariesStore(matrixClient);

	// Presence lives in a module-level store rather than on this context, the
	// same way activeCall does: every consumer (member list, DM list, profile
	// card) wants it, and threading it through the context would widen a type
	// that nineteen test files construct by hand.
	attachPresence(matrixClient);
	attachPresencePublisher(matrixClient);
	// Publish on start and whenever the setting changes. An effect rather than
	// a one-shot so toggling it mid-session takes effect immediately, which is
	// the whole point of a privacy switch.
	createEffect(() => {
		const sharing = userSettings().sharePresence;
		setPresenceSharing(sharing);
		// Our own presence never arrives as an event (see recordSelfPresence),
		// so the store learns it from the same place the server does.
		const myUserId = matrixClient.getUserId();
		if (myUserId) recordSelfPresence(myUserId, sharing);
	});

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
			// No URL argument: the package's own default is the bundled wasm, the
			// same one the SDK's internal initAsync call resolves to.
			loadModule: () => loadCryptoModule(),
			clearStores: () => clearCryptoStores(matrixClient, props.session),
			initCrypto: () => initCryptoStore(matrixClient, props.session),
			isAborted: () => disposed || syncState() === "logged-out",
			reload: () => window.location.reload(),
			timeoutMs: CRYPTO_INIT_TIMEOUT_MS,
			moduleTimeoutMs: CRYPTO_MODULE_LOAD_TIMEOUT_MS,
		});
		if (result === "reloading" || result === "aborted") return;
		setCryptoState(result === "ready" ? "ready" : "error");
		if (disposed || syncState() === "logged-out") return;
		await matrixClient.startClient({
			initialSyncLimit: 20,
			// Partitions m.thread relations into per-thread timelines instead
			// of the room's timeline sets (Room.eventShouldLiveIn). The
			// timeline / preview / notification / search gates rely on this
			// and additionally skip thread replies by shape (lib/threadEvents).
			threadSupport: true,
		});
		// startClient is async and awaits /versions before it builds the sync
		// API, so the value published during provider setup - and anything
		// asserted synchronously here - reaches `syncApi?.` while it is still
		// undefined. Await it, then re-assert (#445).
		//
		// This does not save the very first /sync: startClient kicks that off
		// before it resolves, so one request can still carry the server's
		// default of `online`. The explicit setPresence PUT already told the
		// server the truth, and the next long poll carries the right
		// set_presence, so the window is one sync cycle rather than the whole
		// session. `disablePresence` would close it, but it wins over
		// setSyncPresence inside SyncApi - so starting with sharing off would
		// then make turning it back on mid-session silently do nothing, which
		// is a worse failure than a brief blip.
		applySyncPresence();
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
		// Clear the badge only when NO account is left, not on a plain reload or
		// window close. Every logout path (Layout.handleLogout,
		// App.handleForceLogout, and the expired-session effect) clears its
		// account before this unmount, so loadSession() is null then unless
		// another account was promoted; on a reload the session persists, so we
		// leave the badge for the next load / other open windows rather than
		// wiping a still-valid count. A switch or a logout is already handled
		// before this runs: the badge belongs to the active account, so the
		// transition itself clears it (`app/accountSwitch.ts`, #534) and the
		// incoming account's first sync sets the real count. The add-account
		// detour does reach this cleanup - it navigates to `/login` - and
		// deliberately clears nothing, here or there: that account is still
		// signed in and the count on the badge is still its own.
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
				session: props.session,
				syncState,
				cryptoState,
				summaries,
				cryptoStatus,
				optimisticallyMarkJoined,
				optimisticallyMarkKnocked,
				optimisticallyMarkLeft,
				optimisticallySetMarkedUnread,
				optimisticallySetRoomTag,
				optimisticallySetSpaceOrder,
				forgetRoomLocally,
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
