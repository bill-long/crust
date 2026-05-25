import {
	type MatrixClient,
	type MatrixEvent,
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

	client.on(RoomStateEvent.Events, onRoomState);
	onCleanup(() => {
		client.off(RoomStateEvent.Events, onRoomState);
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
