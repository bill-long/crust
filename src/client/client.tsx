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
	type ParentComponent,
	useContext,
} from "solid-js";
import type { Session } from "../stores/session";

export type AppSyncState =
	| "initial"
	| "catching-up"
	| "live"
	| "error"
	| "stopped";

interface ClientContextValue {
	client: MatrixClient;
	syncState: () => AppSyncState;
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
	let hasPrepared = false;

	const onSync = (state: SyncState): void => {
		switch (state) {
			case SyncState.Prepared:
				hasPrepared = true;
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
	matrixClient.startClient({ initialSyncLimit: 20 });

	onCleanup(() => {
		matrixClient.removeListener(ClientEvent.Sync, onSync);
		matrixClient.stopClient();
	});

	return (
		<ClientContext.Provider value={{ client: matrixClient, syncState }}>
			{props.children}
		</ClientContext.Provider>
	);
};

export function useClient(): ClientContextValue {
	const ctx = useContext(ClientContext);
	if (!ctx) throw new Error("useClient must be used within ClientProvider");
	return ctx;
}
