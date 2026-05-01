import {
	ClientEvent,
	type MatrixClient,
	type MatrixEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import type { AccountDataEvents } from "matrix-js-sdk/lib/@types/event";
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import type {
	EmoteRoomsContent,
	ImagePack,
	ImagePackContent,
	ResolvedEmote,
} from "./types";

type AnyAccountDataKey = keyof AccountDataEvents;

const USER_EMOTES_TYPE =
	"im.ponies.user_emotes" as unknown as AnyAccountDataKey;
const EMOTE_ROOMS_TYPE =
	"im.ponies.emote_rooms" as unknown as AnyAccountDataKey;
const ROOM_EMOTES_TYPE = "im.ponies.room_emotes";

function resolvePackImages(
	client: MatrixClient,
	packId: string,
	packName: string,
	content: ImagePackContent,
): ResolvedEmote[] {
	const images = content.images;
	if (!images || typeof images !== "object") return [];

	const result: ResolvedEmote[] = [];
	const entries = Object.entries(images);
	for (const [shortcode, img] of entries) {
		if (!img || typeof img.url !== "string") continue;
		// Only include emoticons (not stickers-only)
		if (img.usage && img.usage.length > 0 && !img.usage.includes("emoticon")) {
			continue;
		}
		const httpUrl = client.mxcUrlToHttp(img.url, 64, 64, "scale");
		if (!httpUrl) continue;

		result.push({
			shortcode,
			mxcUrl: img.url,
			httpUrl,
			body: typeof img.body === "string" ? img.body : `:${shortcode}:`,
			packId,
			packName,
		});
	}
	return result;
}

/**
 * Reactive hook that reads MSC2545 image packs from:
 * 1. User's personal emotes (im.ponies.user_emotes account data)
 * 2. Emote rooms (im.ponies.emote_rooms → im.ponies.room_emotes state)
 * 3. Current room's emotes (im.ponies.room_emotes state, all state keys)
 *
 * Returns a memo of ImagePack[]. Re-evaluates when account data, room state,
 * or the current room changes.
 */
export function useImagePacks(
	client: MatrixClient,
	roomId: () => string,
): () => ImagePack[] {
	// Tick signals to trigger re-evaluation on SDK events
	const [accountDataTick, setAccountDataTick] = createSignal(0);
	const [roomStateTick, setRoomStateTick] = createSignal(0);

	function onAccountData(event: MatrixEvent): void {
		const type = event.getType();
		if (type === USER_EMOTES_TYPE || type === EMOTE_ROOMS_TYPE) {
			setAccountDataTick((n) => n + 1);
		}
	}

	function onRoomState(event: MatrixEvent): void {
		if (event.getType() === ROOM_EMOTES_TYPE) {
			setRoomStateTick((n) => n + 1);
		}
	}

	client.on(ClientEvent.AccountData, onAccountData);
	client.on(RoomStateEvent.Events, onRoomState);

	onCleanup(() => {
		client.off(ClientEvent.AccountData, onAccountData);
		client.off(RoomStateEvent.Events, onRoomState);
	});

	// Reset room state tick when room changes
	createEffect(
		on(roomId, () => {
			setRoomStateTick((n) => n + 1);
		}),
	);

	const packs = createMemo(() => {
		// Track reactivity
		accountDataTick();
		roomStateTick();
		const rid = roomId();

		const result: ImagePack[] = [];
		const seenShortcodes = new Set<string>();

		// 1. User personal emotes
		const userEmotesEvent = client.getAccountData(USER_EMOTES_TYPE);
		if (userEmotesEvent) {
			const content = userEmotesEvent.getContent() as ImagePackContent;
			const emotes = resolvePackImages(client, "user", "My Emojis", content);
			if (emotes.length > 0) {
				for (const e of emotes) seenShortcodes.add(e.shortcode);
				result.push({
					id: "user",
					displayName: content.pack?.display_name?.trim() || "My Emojis",
					avatarUrl: content.pack?.avatar_url
						? (client.mxcUrlToHttp(content.pack.avatar_url, 32, 32, "crop") ??
							null)
						: null,
					emotes,
				});
			}
		}

		// 2. Current room's emotes (all state keys)
		const currentRoom = client.getRoom(rid);
		if (currentRoom) {
			const stateEvents =
				currentRoom.currentState.getStateEvents(ROOM_EMOTES_TYPE);
			if (stateEvents) {
				for (const ev of stateEvents) {
					const content = ev.getContent() as ImagePackContent;
					const stateKey = ev.getStateKey() ?? "";
					const packId = `room:${rid}:${stateKey}`;
					const packName =
						content.pack?.display_name?.trim() ||
						currentRoom.name?.trim() ||
						"Room Emoji";
					const emotes = resolvePackImages(
						client,
						packId,
						packName,
						content,
					).filter((e) => !seenShortcodes.has(e.shortcode));
					if (emotes.length > 0) {
						for (const e of emotes) seenShortcodes.add(e.shortcode);
						result.push({
							id: packId,
							displayName: packName,
							avatarUrl: content.pack?.avatar_url
								? (client.mxcUrlToHttp(
										content.pack.avatar_url,
										32,
										32,
										"crop",
									) ?? null)
								: null,
							emotes,
						});
					}
				}
			}
		}

		// 3. Emote rooms
		const emoteRoomsEvent = client.getAccountData(EMOTE_ROOMS_TYPE);
		if (emoteRoomsEvent) {
			const emoteRoomsContent =
				emoteRoomsEvent.getContent() as EmoteRoomsContent;
			const rooms = emoteRoomsContent.rooms;
			if (rooms && typeof rooms === "object") {
				for (const [emoteRoomId, stateKeys] of Object.entries(rooms)) {
					// Skip current room — already handled above
					if (emoteRoomId === rid) continue;
					const emoteRoom = client.getRoom(emoteRoomId);
					if (!emoteRoom) continue;

					const keys =
						stateKeys && typeof stateKeys === "object"
							? Object.keys(stateKeys)
							: [""];

					for (const sk of keys) {
						const stateEvent = emoteRoom.currentState.getStateEvents(
							ROOM_EMOTES_TYPE,
							sk,
						);
						if (!stateEvent) continue;

						const content = stateEvent.getContent() as ImagePackContent;
						const packId = `emote-room:${emoteRoomId}:${sk}`;
						const packName =
							content.pack?.display_name?.trim() ||
							emoteRoom.name?.trim() ||
							"Emoji Pack";
						const emotes = resolvePackImages(
							client,
							packId,
							packName,
							content,
						).filter((e) => !seenShortcodes.has(e.shortcode));
						if (emotes.length > 0) {
							for (const e of emotes) seenShortcodes.add(e.shortcode);
							result.push({
								id: packId,
								displayName: packName,
								avatarUrl: content.pack?.avatar_url
									? (client.mxcUrlToHttp(
											content.pack.avatar_url,
											32,
											32,
											"crop",
										) ?? null)
									: null,
								emotes,
							});
						}
					}
				}
			}
		}

		return result;
	});

	return packs;
}

/**
 * Build a flat lookup map from MXC URL → ResolvedEmote for fast reaction
 * key resolution.
 */
export function buildEmoteLookup(
	packs: ImagePack[],
): Map<string, ResolvedEmote> {
	const map = new Map<string, ResolvedEmote>();
	for (const pack of packs) {
		for (const emote of pack.emotes) {
			if (!map.has(emote.mxcUrl)) {
				map.set(emote.mxcUrl, emote);
			}
		}
	}
	return map;
}

/**
 * Build a lookup map from shortcode → ResolvedEmote for inline rendering.
 */
export function buildShortcodeLookup(
	packs: ImagePack[],
): Map<string, ResolvedEmote> {
	const map = new Map<string, ResolvedEmote>();
	for (const pack of packs) {
		for (const emote of pack.emotes) {
			if (!map.has(emote.shortcode)) {
				map.set(emote.shortcode, emote);
			}
		}
	}
	return map;
}
