import { useNavigate } from "@solidjs/router";
import {
	type MatrixClient,
	type MatrixEvent,
	MatrixEventEvent,
	type Room,
	RoomEvent,
} from "matrix-js-sdk";
import { onCleanup } from "solid-js";
import type { SummariesStore } from "../../client/summaries";
import { userSettings } from "../../stores/settings";
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
): void {
	// No-op in non-browser runtimes (SSR, tests, prerender)
	if (typeof window === "undefined" || typeof document === "undefined") return;

	primeAudioContext();

	const navigate = useNavigate();

	// Encrypted events pending decryption before notification decision
	const pendingDecryption = new Set<string>();

	// Track active notifications for cleanup on unmount
	const activeNotifications = new Set<Notification>();

	function isAppFocused(): boolean {
		return !document.hidden && document.hasFocus();
	}

	function isNotifiableMessage(event: MatrixEvent): boolean {
		const type = event.getType();
		if (
			type !== "m.room.message" &&
			type !== "m.room.encrypted" &&
			type !== "m.sticker"
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
			return `${sender}: Encrypted message`;
		}

		const content = event.getContent();
		const msgtype = content.msgtype as string | undefined;

		if (event.getType() === "m.sticker") {
			return `${sender} sent a sticker`;
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

	function showNotification(event: MatrixEvent, room: Room): void {
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
		} catch {
			// Browser blocked or Notification API unavailable
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
			showNotification(event, room);
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

	onCleanup(() => {
		client.removeListener(RoomEvent.Timeline, onTimeline);
		client.removeListener(MatrixEventEvent.Decrypted, onDecrypted);
		pendingDecryption.clear();
		for (const notif of activeNotifications) {
			notif.close();
		}
		activeNotifications.clear();
	});
}
