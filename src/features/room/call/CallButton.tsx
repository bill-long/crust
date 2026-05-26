import { ClientEvent, type Room, RoomStateEvent } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";

/**
 * State event type that matrix-js-sdk + Element Call currently write for
 * MatrixRTC memberships (legacy MSC3401 form). We gate the call button on
 * the user's ability to send this specific event type — checking the stable
 * `m.call.member` instead would over-restrict against Conduwuity, which
 * doesn't power-level it.
 */
const CALL_MEMBER_EVENT_TYPE = "org.matrix.msc3401.call.member";

interface CallButtonProps {
	roomId: string;
	/** Whether a call is currently in progress in this room. */
	callActive: () => boolean;
	/** Operator Element Call URL; the button hides when this is empty. */
	elementCallUrl: string;
	onStart: () => void;
}

/**
 * Header button to start or join a MatrixRTC call. Hidden when the operator
 * hasn't deployed Element Call (no `config.elementCall.url`) or when the user
 * lacks the power level to send the call-member state event.
 */
export const CallButton: Component<CallButtonProps> = (props) => {
	const { client } = useClient();

	// Bump on RoomStateEvent.Update so canStartCall recomputes when power
	// levels or membership change. Same pattern as Layout.tsx canInviteHere.
	const [bump, setBump] = createSignal(0);
	// Bump when the Room object first appears (deep-link before initial
	// sync completes). Without this the effect below sees room === null
	// at mount time and never resubscribes once sync delivers the room.
	const [roomAvailableTick, setRoomAvailableTick] = createSignal(0);

	const onClientRoom = (room: Room): void => {
		if (room.roomId !== props.roomId) return;
		setRoomAvailableTick((n) => n + 1);
	};
	client.on(ClientEvent.Room, onClientRoom);
	onCleanup(() => {
		client.off(ClientEvent.Room, onClientRoom);
	});

	createEffect(() => {
		// Track both signals so we resubscribe after the room appears.
		roomAvailableTick();
		const room = client.getRoom(props.roomId);
		if (!room) return;
		const onUpdate = (): void => {
			setBump((n) => n + 1);
		};
		room.on(RoomStateEvent.Update, onUpdate);
		onCleanup(() => {
			room.removeListener(RoomStateEvent.Update, onUpdate);
		});
	});

	const canStartCall = createMemo((): boolean => {
		bump();
		roomAvailableTick();
		const room = client.getRoom(props.roomId);
		const uid = client.getUserId();
		if (!room || !uid) return false;
		try {
			return room.currentState.maySendStateEvent(CALL_MEMBER_EVENT_TYPE, uid);
		} catch {
			return false;
		}
	});

	const visible = (): boolean =>
		props.elementCallUrl.trim().length > 0 && canStartCall();

	return (
		<Show when={visible()}>
			<button
				type="button"
				onClick={() => props.onStart()}
				class="relative inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
				title={props.callActive() ? "Join call" : "Start a call"}
				aria-label={props.callActive() ? "Join call" : "Start a call"}
			>
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M23 7l-7 5 7 5V7z" />
					<rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
				</svg>
				<Show when={props.callActive()}>
					<span
						aria-hidden="true"
						class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-success ring-2 ring-surface-1"
					/>
				</Show>
			</button>
		</Show>
	);
};
