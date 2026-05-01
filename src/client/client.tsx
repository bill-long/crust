import {
	ClientEvent,
	createClient,
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
import type { Session } from "../stores/session";
import { createSummariesStore, type SummariesStore } from "./summaries";

export type AppSyncState =
	| "initial"
	| "catching-up"
	| "live"
	| "error"
	| "stopped";

export type CryptoState = "loading" | "ready" | "error";

interface ClientContextValue {
	client: MatrixClient;
	syncState: () => AppSyncState;
	cryptoState: () => CryptoState;
	summaries: SummariesStore;
	cryptoStatus: CryptoStatus;
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

	const {
		summaries,
		init: initSummaries,
		cleanup: cleanupSummaries,
	} = createSummariesStore(matrixClient);

	const onSync = (state: SyncState): void => {
		switch (state) {
			case SyncState.Prepared:
				hasPrepared = true;
				initSummaries();
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

	onMount(async () => {
		try {
			await matrixClient.initRustCrypto({ useIndexedDB: true });
			if (disposed) return;
			setCryptoState("ready");
		} catch (e) {
			console.error("Crypto init failed:", e);
			if (disposed) return;
			setCryptoState("error");
		}
		if (disposed) return;
		matrixClient.startClient({ initialSyncLimit: 20 });
	});

	const cryptoStatus = useCryptoStatus(
		matrixClient,
		() => syncState() === "live",
	);

	onCleanup(() => {
		disposed = true;
		cleanupSummaries();
		matrixClient.removeListener(ClientEvent.Sync, onSync);
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
