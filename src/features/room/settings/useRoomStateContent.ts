import {
	ClientEvent,
	type MatrixClient,
	type MatrixEvent,
	type Room,
	RoomStateEvent,
} from "matrix-js-sdk";
import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";

/**
 * Reactive accessor for one specific room-state event's content.
 *
 * Subscribes to `client.on(RoomStateEvent.Events, ...)` (per stored
 * convention — listen on the MatrixClient, not on `room.on(...)`) and
 * bumps a tick whenever a matching `roomId + type + stateKey` event
 * arrives. Reads the current content from
 * `room.currentState.getStateEvents(type, stateKey)?.getContent()`.
 *
 * Returns `null` when the room hasn't loaded yet or the state event
 * isn't set.
 */
export function useRoomStateContent<T = Record<string, unknown>>(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
	type: string,
	stateKey = "",
): Accessor<T | null> {
	const [tick, setTick] = createSignal(0);

	const onRoomState = (event: MatrixEvent): void => {
		if (event.getType() !== type) return;
		if (event.getRoomId() !== roomId()) return;
		const evStateKey = event.getStateKey?.() ?? "";
		if (evStateKey !== stateKey) return;
		setTick((n) => n + 1);
	};

	// Recovery for a Room that isn't in the store yet at mount (deep-link
	// before initial sync, or room creation navigating before the Room
	// lands). During sync the SDK emits RoomState.events BEFORE storeRoom,
	// so without this the memo could read `getRoom(rid) === null` on the
	// last tick and latch null until an unrelated state change. Mirrors
	// usePinnedEvents' ClientEvent.Room subscription.
	const onClientRoom = (room: Room): void => {
		if (room.roomId !== roomId()) return;
		setTick((n) => n + 1);
	};

	client.on(RoomStateEvent.Events, onRoomState);
	client.on(ClientEvent.Room, onClientRoom);
	onCleanup(() => {
		client.off(RoomStateEvent.Events, onRoomState);
		client.off(ClientEvent.Room, onClientRoom);
	});

	return createMemo<T | null>(() => {
		tick();
		const rid = roomId();
		if (!rid) return null;
		const room = client.getRoom(rid);
		if (!room) return null;
		const ev = room.currentState.getStateEvents(type, stateKey);
		if (!ev) return null;
		// getStateEvents(type, stateKey) returns a single MatrixEvent
		// (not an array) when stateKey is provided.
		const single = ev as unknown as MatrixEvent;
		const content = single.getContent?.();
		return (content as T) ?? null;
	});
}
