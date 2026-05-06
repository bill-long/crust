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

/**
 * Desktop notification delivery hook. Listens for new messages and
 * shows browser notifications when the app is not focused, respecting
 * the user's notification category preferences.
 *
 * Must be called within the Router and ClientProvider context (e.g. Layout).
 */
export function useDesktopNotifications(
	client: MatrixClient,
	summaries: SummariesStore,
): void {
	// No-op in non-browser runtimes (SSR, tests, prerender)
	if (typeof window === "undefined" || typeof document === "undefined") return;

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
		// Skip redacted messages (no msgtype) and edits
		if (type === "m.room.message" && !event.getContent()?.msgtype) return false;
		const relType = event.getContent()?.["m.relates_to"]?.rel_type;
		if (relType === "m.replace") return false;
		return true;
	}

	function shouldNotify(event: MatrixEvent, room: Room): boolean {
		const s = userSettings();
		if (!s.desktopNotifications) return false;
		if (!("Notification" in window)) return false;
		if (Notification.permission !== "granted") return false;
		if (isAppFocused()) return false;
		const currentUserId = client.getUserId();
		if (!currentUserId || event.getSender() === currentUserId) return false;

		// Category filtering
		if (s.notifyAllMessages) return true;

		if (s.notifyDirectMessages && summaries[room.roomId]?.isDirect) {
			return true;
		}

		if (s.notifyMentions) {
			// Force recalculation so post-decryption content is evaluated
			const actions = client.getPushActionsForEvent(event, true);
			if (actions?.tweaks?.highlight === true) return true;
		}

		return false;
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
		if (shouldNotify(event, room)) {
			showNotification(event, room);
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

		// Encrypted event still pending decryption — defer decision only
		// when non-content guards pass (prevents notifying for events that
		// arrived while the app was focused)
		if (
			event.getType() === "m.room.encrypted" &&
			!event.isDecryptionFailure() &&
			!event.getContent().msgtype
		) {
			const s = userSettings();
			if (!s.desktopNotifications) return;
			if (!("Notification" in window)) return;
			if (Notification.permission !== "granted") return;
			if (isAppFocused()) return;
			const currentUserId = client.getUserId();
			if (!currentUserId || event.getSender() === currentUserId) return;

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
