/**
 * Test harness for browser-mode TimelineView tests.
 *
 * Provides:
 *  - `makeTimelineHarnessRef()` — control surface tests use to drive the
 *    mocked `useTimeline` (per-room state, append/prepend, loading flags,
 *    `loadOlderMessages` call counter).
 *  - `installTimelineHarness(harness)` — returns a function with the
 *    `useTimeline` signature, suitable for `vi.mock(...)` factories.
 *  - `TestClientProvider` — supplies the real `ClientContext` with a
 *    `createMockClient()` stub so `TimelineView` renders without
 *    starting a real matrix-js-sdk client.
 */

import type { MatrixClient } from "matrix-js-sdk";
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	type ParentComponent,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AppSyncState, CryptoState } from "../client/client";
import { ClientContext } from "../client/client";
import { createSummariesStore } from "../client/summaries";
import type {
	useTimeline as RealUseTimeline,
	TimelineEvent,
} from "../features/room/timeline/useTimeline";
import { createMockClient } from "./mockClient";

interface RoomSnapshot {
	events: TimelineEvent[];
	loading: boolean;
	loadingOlder: boolean;
	loadingNewer: boolean;
	canLoadOlder: boolean;
	canLoadNewer: boolean;
}

function defaultSnapshot(): RoomSnapshot {
	return {
		events: [],
		loading: false,
		loadingOlder: false,
		loadingNewer: false,
		canLoadOlder: false,
		canLoadNewer: false,
	};
}

export interface TimelineHarness {
	setRoomState: (roomId: string, partial: Partial<RoomSnapshot>) => void;
	appendEvents: (roomId: string, events: TimelineEvent[]) => void;
	prependEvents: (roomId: string, events: TimelineEvent[]) => void;
	loadOlderCallCount: (roomId: string) => number;
	setLoadOlderHandler: (roomId: string, handler: () => Promise<void>) => void;
	reset: () => void;
	__build: () => typeof RealUseTimeline;
}

export function makeTimelineHarnessRef(): TimelineHarness {
	const snapshots = new Map<string, RoomSnapshot>();
	const loadOlderHandlers = new Map<string, () => Promise<void>>();
	const loadOlderCounts = new Map<string, number>();
	type Listener = (roomId: string) => void;
	const listeners = new Set<Listener>();

	const getOrCreate = (roomId: string): RoomSnapshot => {
		let snap = snapshots.get(roomId);
		if (!snap) {
			snap = defaultSnapshot();
			snapshots.set(roomId, snap);
		}
		return snap;
	};

	const notify = (roomId: string): void => {
		for (const l of listeners) l(roomId);
	};

	const harness: TimelineHarness = {
		setRoomState(roomId, partial) {
			const snap = getOrCreate(roomId);
			Object.assign(snap, partial);
			notify(roomId);
		},
		appendEvents(roomId, events) {
			const snap = getOrCreate(roomId);
			snap.events = [...snap.events, ...events];
			notify(roomId);
		},
		prependEvents(roomId, events) {
			const snap = getOrCreate(roomId);
			snap.events = [...events, ...snap.events];
			notify(roomId);
		},
		loadOlderCallCount(roomId) {
			return loadOlderCounts.get(roomId) ?? 0;
		},
		setLoadOlderHandler(roomId, handler) {
			loadOlderHandlers.set(roomId, handler);
		},
		reset() {
			snapshots.clear();
			loadOlderHandlers.clear();
			loadOlderCounts.clear();
			// Clear listeners too — if a previous test threw before Solid's
			// onCleanup ran, its listener would otherwise leak into later
			// tests and fire sync() on a disposed reactive owner.
			listeners.clear();
		},
		__build() {
			const useTimelineMock = ((
				_client: MatrixClient,
				roomIdAcc: () => string,
			) => {
				const [events, setEvents] = createStore<TimelineEvent[]>([]);
				const [loading, setLoading] = createSignal(false);
				const [loadingOlder, setLoadingOlder] = createSignal(false);
				const [loadingNewer, setLoadingNewer] = createSignal(false);
				const [canLoadOlder, setCanLoadOlder] = createSignal(false);
				const [canLoadNewer, setCanLoadNewer] = createSignal(false);

				const sync = (rid: string): void => {
					const snap = getOrCreate(rid);
					setEvents(reconcile(snap.events, { key: "eventId", merge: false }));
					setLoading(snap.loading);
					setLoadingOlder(snap.loadingOlder);
					setLoadingNewer(snap.loadingNewer);
					setCanLoadOlder(snap.canLoadOlder);
					setCanLoadNewer(snap.canLoadNewer);
				};

				const currentRoom = createMemo(() => roomIdAcc());
				// Use createEffect (not createMemo) so sync runs eagerly on
				// every roomId change without needing a consumer to read it.
				createEffect(
					on(currentRoom, (rid) => {
						sync(rid);
					}),
				);

				const listener: Listener = (rid) => {
					if (rid === currentRoom()) sync(rid);
				};
				listeners.add(listener);
				onCleanup(() => {
					listeners.delete(listener);
				});

				return {
					events,
					loading,
					loadingOlder,
					loadingNewer,
					canLoadOlder,
					canLoadNewer,
					loadOlderMessages: () => {
						const rid = currentRoom();
						loadOlderCounts.set(rid, (loadOlderCounts.get(rid) ?? 0) + 1);
						const handler = loadOlderHandlers.get(rid);
						return handler ? handler() : Promise.resolve();
					},
					loadNewerMessages: () => Promise.resolve(),
					jumpToLive: () => {},
					jumpToEvent: () => Promise.resolve(),
					pendingScrollToId: () => null,
					consumePendingScrollToId: () => {},
					setFollowingLive: () => {},
					typingUsers: () => [] as { userId: string; displayName: string }[],
					getSourceEvent: () => null,
					getWindowEvents: () => [],
					pendingRedactions: {} as Record<string, never>,
					pendingReactions: {} as Record<string, never>,
					pendingEdits: {} as Record<string, never>,
				};
				// biome-ignore lint/suspicious/noExplicitAny: shape-matched to the real useTimeline return type
			}) as any as typeof RealUseTimeline;
			return useTimelineMock;
		},
	};
	return harness;
}

export function installTimelineHarness(
	harness: TimelineHarness,
): typeof RealUseTimeline {
	return harness.__build();
}

export const TestClientProvider: ParentComponent<{
	client?: ReturnType<typeof createMockClient>;
}> = (props) => {
	const client = props.client ?? createMockClient();
	const [syncState] = createSignal<AppSyncState>("live");
	const [cryptoState] = createSignal<CryptoState>("ready");
	const { summaries } = createSummariesStore(client as unknown as MatrixClient);
	return (
		<ClientContext.Provider
			value={{
				client: client as unknown as MatrixClient,
				syncState,
				cryptoState,
				summaries,
				cryptoStatus: {
					crossSigningReady: () => true,
					thisDeviceVerified: () => true,
					backupVersion: () => null,
					backupTrusted: () => true,
					secretStorageReady: () => true,
					refresh: async () => {},
				},
				requestRecoveryKey: async () => null,
				setRecoveryKeyResolver: () => {},
				clearSecretStorageCache: () => {},
			}}
		>
			{props.children}
		</ClientContext.Provider>
	);
};
