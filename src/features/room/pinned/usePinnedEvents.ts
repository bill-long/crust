import {
	ClientEvent,
	EventType,
	type MatrixClient,
	type MatrixEvent,
	type Room,
	RoomStateEvent,
} from "matrix-js-sdk";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
} from "solid-js";

/**
 * Reactive view of `m.room.pinned_events` for one room with a local
 * optimistic overlay.
 *
 * Why an overlay (vs. relying on the SDK's pending-event echo):
 *   - `client.sendStateEvent` does not push a pending event onto
 *     `Room.timeline` and does not fire `LocalEchoUpdated`. State events
 *     come back through `RoomStateEvent.Events` once the server confirms
 *     them. So callers who want optimistic UI for a state edit must own
 *     it.
 *
 * Overlay reconciliation:
 *   - Any subsequent `RoomStateEvent.Events` for this type/room arriving
 *     *after* an optimistic op starts clears the overlay — the server
 *     copy is now authoritative regardless of whether its content
 *     equals our optimistic guess. Content-equality clearing would
 *     leave the overlay masking authoritative state indefinitely if a
 *     concurrent client made a different change mid-flight.
 *   - An op-generation counter guards against a late failure rolling
 *     back over a newer server state event.
 */
export interface UsePinnedEvents {
	/** Pinned event IDs in the order stored on the state event
	 *  (oldest-pinned first per spec convention). */
	pinnedIds: Accessor<string[]>;
	/** Newest-pinned first — for UI ordering in the panel. */
	displayOrder: Accessor<string[]>;
	isPinned: (eventId: string) => boolean;
	canPin: Accessor<boolean>;
	/** Reactive accessor for the SDK Room object. Tracks the same
	 *  roomAvailable tick the hook uses internally, so consumers
	 *  (e.g. the panel) re-render once the deep-linked Room appears
	 *  after /sync. */
	room: Accessor<Room | null>;
	pin: (eventId: string) => Promise<void>;
	unpin: (eventId: string) => Promise<void>;
	/** Currently pending optimistic write (if any). Useful for tests / UI
	 *  hints; the panel doesn't need it to render. */
	pending: Accessor<boolean>;
	lastError: Accessor<string | null>;
	clearError: () => void;
}

const PINNED_TYPE = EventType.RoomPinnedEvents;

interface OverlayState {
	pinned: string[];
	gen: number;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function usePinnedEvents(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
): UsePinnedEvents {
	// Tick to re-derive the server view when the SDK emits the pinned
	// state event for this room.
	const [serverTick, setServerTick] = createSignal(0);
	// Tick to re-derive canPin when room state changes (power levels).
	const [stateTick, setStateTick] = createSignal(0);
	// Tick bumped when the Room object for our roomId first becomes
	// available on the client. Handles deep-link mount where the hook
	// runs before /sync has produced the Room — without this, canPin
	// stays stuck at false until a manual room change/remount.
	const [roomAvailableTick, setRoomAvailableTick] = createSignal(0);
	const [overlay, setOverlay] = createSignal<OverlayState | null>(null);
	const [pending, setPending] = createSignal(false);
	const [lastError, setLastError] = createSignal<string | null>(null);

	let opGen = 0;
	// Promise chain that serializes sendStateEvent calls. Each write
	// waits for the previous to settle so concurrent toggles never land
	// in the server out of order. The overlay still updates immediately
	// for snappy UI; only the network round-trips queue.
	let writeChain: Promise<void> = Promise.resolve();
	// Number of optimistic writes whose sendStateEvent hasn't resolved
	// yet. Used by onRoomState to distinguish "a newer write of mine is
	// pending — keep overlay" from "no pending writes — server state is
	// authoritative even if it doesn't match my overlay".
	let inFlightWrites = 0;

	const readServerPinned = (): string[] => {
		const rid = roomId();
		if (!rid) return [];
		const room = client.getRoom(rid);
		if (!room) return [];
		const ev = room.currentState.getStateEvents(PINNED_TYPE, "");
		if (!ev) return [];
		// getStateEvents(type, stateKey) returns a single MatrixEvent
		// (not an array) when stateKey is provided.
		const single = ev as unknown as MatrixEvent;
		const content = single.getContent?.() as { pinned?: unknown } | undefined;
		const pinned = content?.pinned;
		if (!Array.isArray(pinned)) return [];
		return pinned.filter((id): id is string => typeof id === "string");
	};

	const serverPinned = createMemo<string[]>(() => {
		serverTick();
		roomAvailableTick();
		return readServerPinned();
	});

	const pinnedIds = createMemo<string[]>(() => {
		const ov = overlay();
		if (ov) return ov.pinned;
		return serverPinned();
	});

	const displayOrder = createMemo<string[]>(() => {
		// Spec convention: newest pinned at the end. Reverse for UI.
		return [...pinnedIds()].reverse();
	});

	const pinnedSet = createMemo(() => new Set(pinnedIds()));

	const room = createMemo<Room | null>(() => {
		roomAvailableTick();
		const rid = roomId();
		if (!rid) return null;
		return client.getRoom(rid) ?? null;
	});

	const canPin = createMemo<boolean>(() => {
		stateTick();
		roomAvailableTick();
		const rid = roomId();
		if (!rid) return false;
		const room = client.getRoom(rid);
		const uid = client.getUserId();
		if (!room || !uid) return false;
		try {
			return room.currentState.maySendStateEvent(PINNED_TYPE, uid);
		} catch {
			return false;
		}
	});

	// Subscribe to client-level RoomStateEvent.Events for this room
	// (mirrors the useImagePacks pattern). Bumps serverTick so the
	// reactive readers re-evaluate. Overlay clearing rules:
	//  - If the server's pinned content matches the overlay, clear it
	//    (our write has been confirmed).
	//  - If they differ and no optimistic writes are in flight, clear
	//    it — the server is authoritative (concurrent edit from another
	//    client, conflict resolution, etc.).
	//  - If they differ and writes ARE in flight, keep the overlay so
	//    the UI doesn't flicker back to a server state that's about to
	//    be superseded by our pending write.
	const onRoomState = (event: MatrixEvent): void => {
		if (event.getType() !== PINNED_TYPE) return;
		if (event.getRoomId() !== roomId()) return;
		setServerTick((n) => n + 1);
		const ov = overlay();
		if (!ov) return;
		const content = event.getContent?.() as { pinned?: unknown } | undefined;
		const serverPins = Array.isArray(content?.pinned)
			? content.pinned.filter((id): id is string => typeof id === "string")
			: [];
		if (arraysEqual(serverPins, ov.pinned) || inFlightWrites === 0) {
			setOverlay(null);
		}
	};
	client.on(RoomStateEvent.Events, onRoomState);
	onCleanup(() => {
		client.off(RoomStateEvent.Events, onRoomState);
	});

	// Subscribe to RoomStateEvent.Update on the active Room to re-derive
	// canPin when power levels or join rules change. Re-subscribed on
	// room change AND when roomAvailableTick bumps (so a deep-link mount
	// that missed the Room initially picks it up once /sync delivers it).
	createEffect(() => {
		const rid = roomId();
		roomAvailableTick();
		if (!rid) return;
		const room = client.getRoom(rid);
		if (!room) return;
		const onStateUpdate = (): void => {
			setStateTick((n) => n + 1);
		};
		room.on(RoomStateEvent.Update, onStateUpdate);
		onCleanup(() => {
			room.removeListener(RoomStateEvent.Update, onStateUpdate);
		});
	});

	// Watch for our Room becoming available after mount (deep-link
	// before initial sync). Bump roomAvailableTick so dependent memos
	// (canPin, serverPinned) and the state-update subscription re-run.
	const onClientRoom = (room: Room): void => {
		if (room.roomId !== roomId()) return;
		setRoomAvailableTick((n) => n + 1);
	};
	client.on(ClientEvent.Room, onClientRoom);
	onCleanup(() => {
		client.off(ClientEvent.Room, onClientRoom);
	});

	// Reset overlay + error on room change so cross-room state doesn't
	// leak. The hook itself is re-created per per-room subtree (Layout
	// uses <Show keyed>), but defend in depth. Bumping opGen also
	// invalidates any in-flight sendStateEvent so its late failure
	// can't set lastError in the new room.
	createEffect((prev: string | undefined) => {
		const rid = roomId();
		if (prev !== undefined && prev !== rid) {
			opGen++;
			setOverlay(null);
			setLastError(null);
			setPending(false);
		}
		return rid;
	}, undefined);

	async function applyOptimistic(nextPinned: string[]): Promise<void> {
		const rid = roomId();
		if (!rid) return;
		const gen = ++opGen;
		setOverlay({ pinned: nextPinned, gen });
		setPending(true);
		setLastError(null);
		inFlightWrites++;
		const myWrite = writeChain.then(async () => {
			try {
				await client.sendStateEvent(
					rid,
					PINNED_TYPE,
					{ pinned: nextPinned },
					"",
				);
				// On success: do nothing. The overlay is cleared by the
				// incoming RoomStateEvent.Events echo. Until then the overlay
				// keeps the UI consistent.
			} catch (err) {
				// Only roll back if this is still the latest op. A newer op
				// (or a server-side state event) has already superseded this
				// one — its overlay or lack thereof reflects current truth.
				if (opGen === gen) {
					setOverlay(null);
					const msg =
						err instanceof Error ? err.message : "Failed to update pins";
					setLastError(msg);
				}
			} finally {
				inFlightWrites--;
				if (opGen === gen) setPending(false);
			}
		});
		writeChain = myWrite.catch(() => undefined);
		return myWrite;
	}

	async function pin(eventId: string): Promise<void> {
		const current = pinnedIds();
		if (current.includes(eventId)) return;
		await applyOptimistic([...current, eventId]);
	}

	async function unpin(eventId: string): Promise<void> {
		const current = pinnedIds();
		if (!current.includes(eventId)) return;
		await applyOptimistic(current.filter((id) => id !== eventId));
	}

	return {
		pinnedIds,
		displayOrder,
		isPinned: (id) => pinnedSet().has(id),
		canPin,
		room,
		pin,
		unpin,
		pending,
		lastError,
		clearError: () => setLastError(null),
	};
}
