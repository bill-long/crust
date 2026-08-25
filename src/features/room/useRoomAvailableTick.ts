import { ClientEvent, type MatrixClient, type Room } from "matrix-js-sdk";
import { type Accessor, createSignal, onCleanup } from "solid-js";

/**
 * Reactive tick that bumps when the Room object for `roomId` lands in
 * the client store after mount - deep-link before initial sync, or room
 * creation navigating before storeRoom runs (during sync the SDK emits
 * RoomState.events BEFORE storeRoom). Read it in any memo that calls
 * `client.getRoom(roomId)` so a null Room can't latch until an
 * unrelated event happens to re-run the memo.
 *
 * Must be called during component setup - registers an `onCleanup`.
 */
export function useRoomAvailableTick(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
): Accessor<number> {
	const [tick, setTick] = createSignal(0);
	const onClientRoom = (room: Room): void => {
		if (room.roomId !== roomId()) return;
		setTick((n) => n + 1);
	};
	client.on(ClientEvent.Room, onClientRoom);
	onCleanup(() => {
		client.off(ClientEvent.Room, onClientRoom);
	});
	return tick;
}
