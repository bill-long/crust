import {
	ClientEvent,
	createClient,
	HttpApiEvent,
	type MatrixClient,
	SyncState,
} from "matrix-js-sdk";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";
import {
	createContext,
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
import { attachUrlPreviewAccountDataSync } from "../features/room/urlPreviews/accountDataSync";
import type { Session } from "../stores/session";
import {
	CRYPTO_INIT_TIMEOUT_MS,
	clearRecoveryStage,
	persistRecoveryStage,
	readRecoveryStage,
	recoveryIdentity,
	runCryptoInit,
} from "./cryptoRecovery";
import {
	createSummariesStore,
	type OptimisticJoinInfo,
	type SummariesStore,
} from "./summaries";

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
	requestRecoveryKey: () => Promise<Uint8Array<ArrayBuffer> | null>;
	setRecoveryKeyResolver: (
		resolver: (() => Promise<Uint8Array<ArrayBuffer> | null>) | null,
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

	// Pluggable resolver for when the user needs to enter their recovery key
	let recoveryKeyResolver:
		| (() => Promise<Uint8Array<ArrayBuffer> | null>)
		| null = null;

	const setRecoveryKeyResolver = (
		resolver: (() => Promise<Uint8Array<ArrayBuffer> | null>) | null,
	): void => {
		recoveryKeyResolver = resolver;
	};

	const requestRecoveryKey =
		async (): Promise<Uint8Array<ArrayBuffer> | null> => {
			if (recoveryKeyResolver) {
				return recoveryKeyResolver();
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
				// Return cached key for rapid successive calls
				if (
					cachedSecretStorageKeyId &&
					cachedSecretStorageKey &&
					cachedSecretStorageKeyId in opts.keys
				) {
					return [cachedSecretStorageKeyId, cachedSecretStorageKey];
				}

				// Prompt user for recovery key
				const key = await requestRecoveryKey();
				if (!key) return null;

				// Prefer the account's default key ID; fall back to first available
				const availableKeys = Object.keys(opts.keys);
				if (availableKeys.length === 0) return null;

				const defaultKeyId = await matrixClient.secretStorage.getDefaultKeyId();
				const keyId =
					defaultKeyId && defaultKeyId in opts.keys
						? defaultKeyId
						: availableKeys[0];

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
	let hasPrepared = false;
	let disposed = false;
	let detachUrlPreviewSync: (() => void) | null = null;

	const {
		summaries,
		init: initSummaries,
		cleanup: cleanupSummaries,
		optimisticallyMarkJoined,
		optimisticallyMarkLeft,
	} = createSummariesStore(matrixClient);

	const onSync = (state: SyncState): void => {
		// "logged-out" is terminal — don't let later sync events overwrite it
		if (syncState() === "logged-out") return;

		switch (state) {
			case SyncState.Prepared:
				hasPrepared = true;
				initSummaries();
				if (!detachUrlPreviewSync && !disposed) {
					detachUrlPreviewSync = attachUrlPreviewAccountDataSync(matrixClient);
				}
				setSyncState("live");
				break;
			case SyncState.Syncing:
				if (hasPrepared) {
					setSyncState("live");
				}
				break;
			case SyncState.Catchup:
			case SyncState.Reconnecting:
				if (hasPrepared) {
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
			clearStores: () => matrixClient.clearStores(),
			initCrypto: () => matrixClient.initRustCrypto({ useIndexedDB: true }),
			isAborted: () => disposed || syncState() === "logged-out",
			reload: () => window.location.reload(),
			timeoutMs: CRYPTO_INIT_TIMEOUT_MS,
		});
		if (result === "reloading" || result === "aborted") return;
		setCryptoState(result === "ready" ? "ready" : "error");
		if (disposed || syncState() === "logged-out") return;
		matrixClient.startClient({ initialSyncLimit: 20 });
	});

	const cryptoStatus = useCryptoStatus(
		matrixClient,
		() => syncState() === "live",
	);

	onCleanup(() => {
		disposed = true;
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
