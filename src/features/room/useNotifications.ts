import { useNavigate } from "@solidjs/router";
import {
	type MatrixClient,
	type MatrixEvent,
	MatrixEventEvent,
	type Room,
	RoomEvent,
} from "matrix-js-sdk";
import { onCleanup } from "solid-js";
import type { AppSyncState } from "../../client/client";
import type { SummariesStore } from "../../client/summaries";
import { isPollStartType, pollPreviewText } from "../../lib/pollCopy";
import { userSettings } from "../../stores/settings";
import {
	type CanNotifyInput,
	computeCanNotify,
	createSurfacedEventTracker,
	NOTIFY_CHANNEL_NAME,
	type NotifyPing,
} from "../notifications/notifyChannel";
import { playNotificationSound, primeAudioContext } from "./notificationSound";

/**
 * Notification hook following the Discord model, driven by Matrix
 * push rules:
 *
 * - **Push rules** decide per-event whether to alert.  Events with a
 *   `sound` or `highlight` tweak trigger desktop notifications (when
 *   unfocused) and/or sound.  Bare `notify` (ordinary group messages)
 *   contributes to unread counts but does not pop up or chime.
 * - **Sound** plays for qualifying events in rooms the user is NOT
 *   currently viewing, even when the app is focused.  Independent of
 *   the desktop-notification toggle.
 * - **Desktop notifications** appear only when the app is NOT focused.
 * - Global `desktopNotifications` / `notificationSound` settings act
 *   as master kill switches.
 *
 * Must be called within the Router and ClientProvider context (e.g. Layout).
 */
export function useNotifications(
	client: MatrixClient,
	summaries: SummariesStore,
	activeRoomId: () => string | undefined,
	syncState: () => AppSyncState,
): void {
	// No-op in non-browser runtimes (SSR, tests, prerender)
	if (typeof window === "undefined" || typeof document === "undefined") return;

	primeAudioContext();

	const navigate = useNavigate();

	// Encrypted events pending decryption before notification decision
	const pendingDecryption = new Set<string>();

	// Track active notifications for cleanup on unmount
	const activeNotifications = new Set<Notification>();

	// Per-event dedupe with the background-push service worker (issue #242):
	// event_ids this client has actually surfaced in-app (popped a desktop
	// notification for). The SW pings with the pushed event_id and suppresses
	// its own background notification only when a client confirms it surfaced
	// that specific event. Bounded so a long-lived session can't grow without
	// limit.
	const surfacedEvents = createSurfacedEventTracker();

	function isAppFocused(): boolean {
		return !document.hidden && document.hasFocus();
	}

	function isNotifiableMessage(event: MatrixEvent): boolean {
		const type = event.getType();
		if (
			type !== "m.room.message" &&
			type !== "m.room.encrypted" &&
			type !== "m.sticker" &&
			!isPollStartType(type)
		) {
			return false;
		}
		if (type === "m.room.message" && !event.getContent()?.msgtype) return false;
		const relType = event.getContent()?.["m.relates_to"]?.rel_type;
		if (relType === "m.replace") return false;
		return true;
	}

	function shouldShowDesktopNotification(): boolean {
		const s = userSettings();
		if (!s.desktopNotifications) return false;
		if (!("Notification" in window)) return false;
		if (Notification.permission !== "granted") return false;
		if (isAppFocused()) return false;
		return true;
	}

	function buildBody(event: MatrixEvent, room: Room): string {
		const senderId = event.getSender();
		const memberName = senderId
			? room.getMember(senderId)?.name?.trim()
			: undefined;
		const sender = memberName || senderId || "Someone";

		if (event.isDecryptionFailure()) {
			// Lock indicator matches the background-push copy in pushCopy.ts for
			// a consistent "can't show encrypted content" message across paths.
			return `${sender}: 🔒 Encrypted message`;
		}

		const content = event.getContent();
		const msgtype = content.msgtype as string | undefined;

		if (event.getType() === "m.sticker") {
			return `${sender} sent a sticker`;
		}

		// Polls have no msgtype; keyed on event type like stickers. Matches
		// the room-list preview and background-push copy ("Poll: <question>").
		if (isPollStartType(event.getType())) {
			return `${sender}: ${pollPreviewText(content) ?? "Poll"}`;
		}

		switch (msgtype) {
			case "m.image":
				return `${sender} sent an image`;
			case "m.file":
				return `${sender} sent a file`;
			case "m.audio":
				return `${sender} sent an audio file`;
			case "m.video":
				return `${sender} sent a video`;
			default: {
				const body =
					typeof content.body === "string" ? content.body.slice(0, 200) : null;
				return `${sender}: ${body || "New message"}`;
			}
		}
	}

	function showNotification(event: MatrixEvent, room: Room): boolean {
		try {
			const notif = new Notification(room.name?.trim() || "Room", {
				body: buildBody(event, room),
				tag: room.roomId,
			});

			activeNotifications.add(notif);
			notif.onclose = () => activeNotifications.delete(notif);

			notif.onclick = () => {
				window.focus();
				const isDm = summaries[room.roomId]?.isDirect;
				const encoded = encodeURIComponent(room.roomId);
				navigate(isDm ? `/dm/${encoded}` : `/home/${encoded}`);
				notif.close();
			};
			return true;
		} catch {
			// Browser blocked or Notification API unavailable
			return false;
		}
	}

	function processEvent(event: MatrixEvent, room: Room): void {
		if (!isNotifiableMessage(event)) return;

		const currentUserId = client.getUserId();
		if (!currentUserId || event.getSender() === currentUserId) return;
		if (room.roomId === activeRoomId()) return;

		// Push rules decide whether this event should alert
		const actions = client.getPushActionsForEvent(event, true);
		if (!actions?.notify) return;

		// "Loud" events have sound or highlight tweaks.
		// Bare notify (no tweaks) = badge only, no popup or chime.
		const hasSound = !!actions.tweaks?.sound;
		const hasHighlight = actions.tweaks?.highlight === true;

		if ((hasSound || hasHighlight) && shouldShowDesktopNotification()) {
			// Record the event as surfaced only when the notification was
			// actually created, so the SW's per-event dedupe doesn't suppress a
			// background notification for an event we failed to pop.
			const eventId = event.getId();
			if (showNotification(event, room) && eventId) {
				surfacedEvents.record(eventId);
			}
		}
		if (hasSound && userSettings().notificationSound) {
			playNotificationSound();
		}
	}

	const onTimeline = (
		event: MatrixEvent,
		room: Room | undefined,
		_toStart: boolean | undefined,
		_removed: boolean | undefined,
		data: { liveEvent?: boolean },
	): void => {
		if (!room || !data.liveEvent) return;

		// Encrypted event pending decryption — defer and re-evaluate after
		if (
			event.getType() === "m.room.encrypted" &&
			!event.isDecryptionFailure() &&
			!event.getContent().msgtype
		) {
			const currentUserId = client.getUserId();
			if (!currentUserId || event.getSender() === currentUserId) return;
			if (room.roomId === activeRoomId()) return;

			const s = userSettings();
			if (!s.desktopNotifications && !s.notificationSound) return;

			const eventId = event.getId();
			if (eventId) pendingDecryption.add(eventId);
			return;
		}

		processEvent(event, room);
	};

	const onDecrypted = (event: MatrixEvent): void => {
		const eventId = event.getId();
		if (!eventId || !pendingDecryption.has(eventId)) return;
		pendingDecryption.delete(eventId);

		const roomId = event.getRoomId();
		const room = roomId ? client.getRoom(roomId) : null;
		if (!room) return;

		processEvent(event, room);
	};

	client.on(RoomEvent.Timeline, onTimeline);
	client.on(MatrixEventEvent.Decrypted, onDecrypted);

	// Background-push coordination: the service worker broadcasts a `ping`
	// before showing a background notification. Reply whether this client will
	// surface the event in-app, so the SW suppresses its own notification only
	// then — closing the gap where an open-but-hidden tab with desktop
	// notifications off would otherwise drop the alert silently. A client can
	// surface the event when it is "live" (initial sync complete, processing
	// live timeline events) and either focused (the user sees it live) or it
	// popped a desktop notification for the event. We gate on the app's "live"
	// syncState
	// rather than the SDK's raw SyncState.Syncing because Syncing can fire
	// during initial sync before the first Prepared, when no live events flow
	// yet — replying canNotify then would re-open the silent-drop gap at
	// startup. See src/client/client.tsx onSync and src/sw.ts handlePush.
	//
	// This coordinates per-event (issue #242): the ping carries the pushed
	// event_id, and a client confirms only when it will surface *that* event —
	// it is focused (the user sees it live) or it actually popped a desktop
	// notification for the event. A bare-notify event (no sound/highlight tweak)
	// while unfocused is never popped in-app, so the client does not confirm and
	// the SW still shows its background notification. Loud events the in-app
	// path pops are recorded in the surfaced-event tracker; a same-tag (roomId)
	// notification means even a race (push handled before the live event) just
	// replaces rather than duplicates.
	let notifyChannel: BroadcastChannel | undefined;
	if ("BroadcastChannel" in window) {
		// Fail-open: a restricted context can throw on construction. If it does,
		// skip channel wiring (the SW falls back to showing the notification
		// itself) rather than letting the error abort hook setup in Layout.
		try {
			notifyChannel = new BroadcastChannel(NOTIFY_CHANNEL_NAME);
		} catch {
			notifyChannel = undefined;
		}
	}
	if (notifyChannel) {
		notifyChannel.onmessage = (e: MessageEvent) => {
			const data = e.data as NotifyPing | null;
			if (data?.type !== "ping" || typeof data.nonce !== "string") return;
			const hasNotificationApi = "Notification" in window;
			const s = userSettings();
			const input: CanNotifyInput = {
				live: syncState() === "live",
				focused: isAppFocused(),
				desktopNotificationsEnabled: s.desktopNotifications,
				notificationPermissionGranted:
					hasNotificationApi && Notification.permission === "granted",
				eventSurfacedInApp:
					typeof data.eventId === "string" && surfacedEvents.has(data.eventId),
			};
			const canNotify = computeCanNotify(input);
			try {
				notifyChannel?.postMessage({
					type: "pong",
					nonce: data.nonce,
					canNotify,
				});
			} catch {
				// Fail-open: if the reply can't be sent (restricted context), the
				// SW times out waiting and shows the notification itself.
			}
		};
	}

	onCleanup(() => {
		client.removeListener(RoomEvent.Timeline, onTimeline);
		client.removeListener(MatrixEventEvent.Decrypted, onDecrypted);
		try {
			notifyChannel?.close();
		} catch {
			// best-effort cleanup; nothing actionable if close() throws
		}
		pendingDecryption.clear();
		surfacedEvents.clear();
		for (const notif of activeNotifications) {
			notif.close();
		}
		activeNotifications.clear();
	});
}
