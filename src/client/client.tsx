import {
	ClientEvent,
	createClient,
	type MatrixClient,
	SyncState,
} from "matrix-js-sdk";
import {
	createContext,
	createSignal,
	onCleanup,
	onMount,
	type ParentComponent,
	useContext,
} from "solid-js";
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
}

const ClientContext = createContext<ClientContextValue>();

export const ClientProvider: ParentComponent<{ session: Session }> = (
	props,
) => {
	const matrixClient = createClient({
		baseUrl: props.session.homeserverUrl,
		accessToken: props.session.accessToken,
		userId: props.session.userId,
		deviceId: props.session.deviceId,
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

	onCleanup(() => {
		disposed = true;
		cleanupSummaries();
		matrixClient.removeListener(ClientEvent.Sync, onSync);
		matrixClient.stopClient();
	});

	return (
		<ClientContext.Provider
			value={{ client: matrixClient, syncState, cryptoState, summaries }}
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
