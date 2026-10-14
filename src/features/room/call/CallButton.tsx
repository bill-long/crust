import { RoomStateEvent } from "matrix-js-sdk";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import {
	type Component,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { useConfig } from "../../../app/ConfigProvider";
import { useClient } from "../../../client/client";
import { activeCallRoomId } from "../../../stores/activeCall";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { useRoomAvailableTick } from "../useRoomAvailableTick";
import { currentCallSession } from "./rtc/callSessionStore";
import { discoverLivekitFoci } from "./rtc/discoverFoci";
import {
	canPublishMembership,
	selectRtcTransport,
	supportsRtcMembership,
} from "./rtc/rtcProtocol";
import { switchCall } from "./rtc/switchCall";

interface CallButtonProps {
	roomId: string;
	/** Whether a call is currently in progress in this room. */
	callActive: () => boolean;
	onStart: () => void;
}

/**
 * Header button to start or join a MatrixRTC call. Hidden when the user
 * lacks the power level to send the call-member state event.
 *
 * Cross-room behavior (Phase 7B PR B-2c of #122): when another room
 * has an active call, clicking this button opens a "Switch calls?"
 * confirmation dialog instead of being silently refused. Confirming
 * the dialog leaves the current call (via the controller's awaitable
 * single-flight `requestLeave`) and flips `activeCallRoomId` to this
 * room. If the leave fails, the original call is preserved and the
 * controller surfaces the error inside its own leave-error dialog.
 */
export const CallButton: Component<CallButtonProps> = (props) => {
	const { client, summaries, syncState } = useClient();
	const config = useConfig();
	let discoveryAbort: AbortController | undefined;
	onCleanup(() => discoveryAbort?.abort());
	const [transportOptions, { refetch }] = createResource(
		() => props.roomId,
		async (roomId) => {
			discoveryAbort?.abort();
			const controller = new AbortController();
			discoveryAbort = controller;
			const [sticky, foci] = await Promise.all([
				supportsRtcMembership(client),
				discoverLivekitFoci(client, config.elementCall.url, roomId, {
					signal: controller.signal,
				}),
			]);
			return { sticky, foci };
		},
	);

	createEffect(
		on(
			syncState,
			(current, previous) => {
				if (
					current === "live" &&
					previous !== "live" &&
					(transportOptions.latest?.foci.length === 0 ||
						transportOptions.latest?.sticky === null) &&
					!transportOptions.loading
				)
					void refetch();
			},
			{ defer: true },
		),
	);

	// Bump on RoomStateEvent.Update so canStartCall recomputes when power
	// levels or membership change. Same pattern as Layout.tsx canInviteHere.
	const [bump, setBump] = createSignal(0);
	// Bump when the Room object first appears (deep-link before initial
	// sync completes). Without this the effect below sees room === null
	// at mount time and never resubscribes once sync delivers the room.
	const roomAvailableTick = useRoomAvailableTick(client, () => props.roomId);

	createEffect(() => {
		// Track both signals so we resubscribe after the room appears.
		roomAvailableTick();
		const room = client.getRoom(props.roomId);
		if (!room) return;
		const onUpdate = (): void => {
			setBump((n) => n + 1);
		};
		room.on(RoomStateEvent.Update, onUpdate);
		const session = client.matrixRTC?.getRoomSession(room);
		session?.on(MatrixRTCSessionEvent.MembershipsChanged, onUpdate);
		onCleanup(() => {
			room.removeListener(RoomStateEvent.Update, onUpdate);
			session?.off(MatrixRTCSessionEvent.MembershipsChanged, onUpdate);
		});
	});

	const canStartCall = createMemo((): boolean => {
		bump();
		roomAvailableTick();
		const available = transportOptions();
		const room = client.getRoom(props.roomId);
		if (!available || !room) return false;
		return (
			selectRtcTransport(
				client,
				props.roomId,
				available.foci,
				available.sticky,
				client.matrixRTC?.getRoomSession(room).memberships ?? [],
				summaries,
			) !== null
		);
	});

	const canRetryDiscovery = createMemo(() => {
		bump();
		roomAvailableTick();
		return (
			(transportOptions()?.foci.length === 0 ||
				transportOptions()?.sticky === null) &&
			(canPublishMembership(client, props.roomId, false, summaries) ||
				canPublishMembership(client, props.roomId, true, summaries))
		);
	});
	const visible = (): boolean => canStartCall() || canRetryDiscovery();

	// True when the user is in another room's call. With B-2c the
	// button stays enabled — clicking opens a "Switch calls?" confirm
	// dialog rather than being silently refused.
	const otherCallActive = (): boolean => {
		const active = activeCallRoomId();
		return active !== null && active !== props.roomId;
	};

	const otherCallRoomName = (): string => {
		const active = activeCallRoomId();
		if (!active) return "another room";
		return summaries[active]?.name?.trim() || "another room";
	};

	const thisRoomName = (): string =>
		summaries[props.roomId]?.name?.trim() || "this room";

	const buttonLabel = (): string => {
		if (!canStartCall() && canRetryDiscovery()) return "Retry call discovery";
		if (otherCallActive()) return "Switch to call in this room";
		return props.callActive() ? "Join call" : "Start a call";
	};

	const [switchOpen, setSwitchOpen] = createSignal(false);

	const handleClick = (): void => {
		if (!canStartCall() && canRetryDiscovery()) {
			if (!transportOptions.loading) void refetch();
			return;
		}
		if (otherCallActive()) {
			setSwitchOpen(true);
			return;
		}
		props.onStart();
	};

	const handleSwitchConfirm = async (): Promise<void> => {
		await switchCall(props.roomId);
		// Always close this dialog regardless of outcome:
		//  - ok: the new controller is mounting; nothing further here.
		//  - leaveFailed: the previous controller has already re-opened
		//    its own leave-error ConfirmDialog with the message inline;
		//    keeping our dialog open would stack two modals.
		//  - superseded: a later switchCall is in charge.
		setSwitchOpen(false);
	};

	return (
		<>
			<Show when={visible()}>
				<button
					type="button"
					onClick={handleClick}
					disabled={
						!canStartCall() && canRetryDiscovery() && transportOptions.loading
					}
					class="relative inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
					title={buttonLabel()}
					aria-label={buttonLabel()}
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
			<ConfirmDialog
				open={switchOpen}
				onClose={() => setSwitchOpen(false)}
				title="Switch calls?"
				body={
					<>
						You're currently in a call in{" "}
						<span class="font-semibold text-text-primary">
							{otherCallRoomName()}
						</span>
						. Leave that call and join{" "}
						<span class="font-semibold text-text-primary">
							{thisRoomName()}
						</span>
						?
						<Show when={currentCallSession()?.leaving()}>
							<p
								class="mt-3 rounded bg-surface-2 px-3 py-1.5 text-xs text-text-secondary"
								role="status"
							>
								Leaving the current call…
							</p>
						</Show>
					</>
				}
				confirmLabel="Switch"
				cancelLabel="Cancel"
				destructive
				onConfirm={handleSwitchConfirm}
			/>
		</>
	);
};
