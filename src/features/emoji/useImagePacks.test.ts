import { ClientEvent, type MatrixClient, RoomStateEvent } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../test/mockClient";
import { useImagePacks } from "./useImagePacks";

const USER_EMOTES_TYPE = "im.ponies.user_emotes";
const EMOTE_ROOMS_TYPE = "im.ponies.emote_rooms";
const ROOM_EMOTES_TYPE = "im.ponies.room_emotes";

/** Run a test inside createRoot with proper error propagation. */
function withRoot(fn: (dispose: () => void) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			let disposed = false;
			const safeDispose = () => {
				if (!disposed) {
					disposed = true;
					dispose();
				}
			};
			try {
				await fn(safeDispose);
				safeDispose();
				resolve();
			} catch (e) {
				safeDispose();
				reject(e);
			}
		});
	});
}

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("useImagePacks", () => {
	it("returns empty array when no account data or room state exists", async () => {
		const room = createMockRoom("!room:x");
		const client = createMockClient(new Map([["!room:x", room]]));

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();
			expect(packs()).toEqual([]);
		});
	});

	it("loads user personal emotes from account data", async () => {
		const room = createMockRoom("!room:x");
		const client = createMockClient(new Map([["!room:x", room]]));
		client.__setAccountData(USER_EMOTES_TYPE, {
			pack: { display_name: "My Custom Emoji" },
			images: {
				wave: { url: "mxc://example.com/wave" },
				smile: { url: "mxc://example.com/smile", body: "smiley" },
			},
		});

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].id).toBe("user");
			expect(packs()[0].displayName).toBe("My Custom Emoji");
			expect(packs()[0].emotes).toHaveLength(2);
			expect(packs()[0].emotes[0].shortcode).toBe("wave");
			expect(packs()[0].emotes[0].mxcUrl).toBe("mxc://example.com/wave");
			expect(packs()[0].emotes[0].body).toBe(":wave:");
			expect(packs()[0].emotes[1].shortcode).toBe("smile");
			expect(packs()[0].emotes[1].body).toBe("smiley");
		});
	});

	it("loads room emotes from current room state", async () => {
		const room = createMockRoom("!room:x", [], [], {
			name: "Test Room",
		});
		room.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			pack: { display_name: "Room Pack" },
			images: {
				roomoji: { url: "mxc://example.com/roomoji" },
			},
		});
		const client = createMockClient(new Map([["!room:x", room]]));

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].id).toBe("room:!room:x:");
			expect(packs()[0].displayName).toBe("Room Pack");
			expect(packs()[0].emotes).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("roomoji");
		});
	});

	it("loads emotes from emote rooms", async () => {
		const currentRoom = createMockRoom("!room:x");
		const emoteRoom = createMockRoom("!emotes:x", [], [], {
			name: "Emoji Lounge",
		});
		emoteRoom.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			pack: { display_name: "Lounge Pack" },
			images: {
				cool: { url: "mxc://example.com/cool" },
			},
		});
		const client = createMockClient(
			new Map([
				["!room:x", currentRoom],
				["!emotes:x", emoteRoom],
			]),
		);
		client.__setAccountData(EMOTE_ROOMS_TYPE, {
			rooms: { "!emotes:x": {} },
		});

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].id).toBe("emote-room:!emotes:x:");
			expect(packs()[0].displayName).toBe("Lounge Pack");
			expect(packs()[0].emotes).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("cool");
		});
	});

	it("uses default state key '' for emote rooms with empty object", async () => {
		const currentRoom = createMockRoom("!room:x");
		const emoteRoom = createMockRoom("!emotes:x");
		emoteRoom.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			images: { emoji: { url: "mxc://example.com/emoji" } },
		});
		const client = createMockClient(
			new Map([
				["!room:x", currentRoom],
				["!emotes:x", emoteRoom],
			]),
		);
		// Empty object {} means default state key ""
		client.__setAccountData(EMOTE_ROOMS_TYPE, {
			rooms: { "!emotes:x": {} },
		});

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("emoji");
		});
	});

	it("skips current room when also listed in emote rooms", async () => {
		const room = createMockRoom("!room:x");
		room.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			images: { emoji: { url: "mxc://example.com/emoji" } },
		});
		const client = createMockClient(new Map([["!room:x", room]]));
		// Current room also referenced in emote_rooms — should not duplicate
		client.__setAccountData(EMOTE_ROOMS_TYPE, {
			rooms: { "!room:x": {} },
		});

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();

			// Only one pack (room), not duplicated via emote rooms
			expect(packs()).toHaveLength(1);
			expect(packs()[0].id).toBe("room:!room:x:");
		});
	});

	it("deduplicates shortcodes — user emotes shadow room emotes", async () => {
		const room = createMockRoom("!room:x");
		room.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			images: {
				wave: { url: "mxc://example.com/room-wave" },
				unique: { url: "mxc://example.com/unique" },
			},
		});
		const client = createMockClient(new Map([["!room:x", room]]));
		client.__setAccountData(USER_EMOTES_TYPE, {
			images: {
				wave: { url: "mxc://example.com/user-wave" },
			},
		});

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();

			expect(packs()).toHaveLength(2);
			// User pack has :wave:
			expect(packs()[0].emotes).toHaveLength(1);
			expect(packs()[0].emotes[0].mxcUrl).toBe("mxc://example.com/user-wave");
			// Room pack only has :unique: (wave was deduped)
			expect(packs()[1].emotes).toHaveLength(1);
			expect(packs()[1].emotes[0].shortcode).toBe("unique");
		});
	});

	it("filters out non-mxc URLs and sticker-only images", async () => {
		const room = createMockRoom("!room:x");
		const client = createMockClient(new Map([["!room:x", room]]));
		client.__setAccountData(USER_EMOTES_TYPE, {
			images: {
				valid: { url: "mxc://example.com/valid" },
				httpUrl: { url: "https://evil.com/tracking.gif" },
				stickerOnly: {
					url: "mxc://example.com/sticker",
					usage: ["sticker"],
				},
				emoticonOk: {
					url: "mxc://example.com/emoticon",
					usage: ["emoticon"],
				},
			},
		});

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();

			expect(packs()).toHaveLength(1);
			const shortcodes = packs()[0].emotes.map((e) => e.shortcode);
			expect(shortcodes).toContain("valid");
			expect(shortcodes).toContain("emoticonOk");
			expect(shortcodes).not.toContain("httpUrl");
			expect(shortcodes).not.toContain("stickerOnly");
		});
	});

	it("recomputes when account data event fires", async () => {
		const room = createMockRoom("!room:x");
		const client = createMockClient(new Map([["!room:x", room]]));

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();
			expect(packs()).toHaveLength(0);

			// Add user emotes and fire account data event
			client.__setAccountData(USER_EMOTES_TYPE, {
				images: { wave: { url: "mxc://example.com/wave" } },
			});
			client.__emit(ClientEvent.AccountData, {
				getType: () => USER_EMOTES_TYPE,
			});
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("wave");
		});
	});

	it("recomputes when room state event fires for current room", async () => {
		const room = createMockRoom("!room:x");
		const client = createMockClient(new Map([["!room:x", room]]));

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();
			expect(packs()).toHaveLength(0);

			// Add room emotes and fire state event
			room.__setStateEvent(ROOM_EMOTES_TYPE, "", {
				images: { star: { url: "mxc://example.com/star" } },
			});
			client.__emit(RoomStateEvent.Events, {
				getType: () => ROOM_EMOTES_TYPE,
				getRoomId: () => "!room:x",
			});
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("star");
		});
	});

	it("recomputes when room state event fires for emote room", async () => {
		const currentRoom = createMockRoom("!room:x");
		const emoteRoom = createMockRoom("!emotes:x");
		const client = createMockClient(
			new Map([
				["!room:x", currentRoom],
				["!emotes:x", emoteRoom],
			]),
		);
		client.__setAccountData(EMOTE_ROOMS_TYPE, {
			rooms: { "!emotes:x": {} },
		});

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();
			expect(packs()).toHaveLength(0);

			// Add emotes to the emote room and fire state event
			emoteRoom.__setStateEvent(ROOM_EMOTES_TYPE, "", {
				images: { fire: { url: "mxc://example.com/fire" } },
			});
			client.__emit(RoomStateEvent.Events, {
				getType: () => ROOM_EMOTES_TYPE,
				getRoomId: () => "!emotes:x",
			});
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("fire");
		});
	});

	it("ignores room state events for unrelated rooms", async () => {
		const room = createMockRoom("!room:x");
		room.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			images: { star: { url: "mxc://example.com/star" } },
		});
		const client = createMockClient(new Map([["!room:x", room]]));

		await withRoot(async () => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();
			expect(packs()).toHaveLength(1);

			// Capture current reference to detect recomputation
			const packsBefore = packs();

			// Fire state event for unrelated room (not current, not emote room)
			client.__emit(RoomStateEvent.Events, {
				getType: () => ROOM_EMOTES_TYPE,
				getRoomId: () => "!unrelated:x",
			});
			await flushPromises();

			// Packs should be the exact same reference (memo not invalidated)
			expect(packs()).toBe(packsBefore);
		});
	});

	it("recomputes when roomId signal changes", async () => {
		const roomA = createMockRoom("!a:x", [], [], { name: "Room A" });
		roomA.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			images: { emojiA: { url: "mxc://example.com/a" } },
		});
		const roomB = createMockRoom("!b:x", [], [], { name: "Room B" });
		roomB.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			images: { emojiB: { url: "mxc://example.com/b" } },
		});
		const client = createMockClient(
			new Map([
				["!a:x", roomA],
				["!b:x", roomB],
			]),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!a:x");
			const packs = useImagePacks(client as unknown as MatrixClient, roomId);
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("emojiA");

			setRoomId("!b:x");
			await flushPromises();

			expect(packs()).toHaveLength(1);
			expect(packs()[0].emotes[0].shortcode).toBe("emojiB");
		});
	});

	it("removes listeners on cleanup", async () => {
		const room = createMockRoom("!room:x");
		room.__setStateEvent(ROOM_EMOTES_TYPE, "", {
			images: { star: { url: "mxc://example.com/star" } },
		});
		const client = createMockClient(new Map([["!room:x", room]]));

		await withRoot(async (dispose) => {
			const packs = useImagePacks(
				client as unknown as MatrixClient,
				() => "!room:x",
			);
			await flushPromises();
			expect(packs()).toHaveLength(1);

			// Dispose the reactive root (triggers onCleanup)
			dispose();

			// After dispose, events should not cause recomputation
			room.__setStateEvent(ROOM_EMOTES_TYPE, "", {
				images: {
					star: { url: "mxc://example.com/star" },
					added: { url: "mxc://example.com/added" },
				},
			});
			client.__emit(RoomStateEvent.Events, {
				getType: () => ROOM_EMOTES_TYPE,
				getRoomId: () => "!room:x",
			});
			await flushPromises();

			// Packs should still have the old value (1 emote, not 2)
			expect(packs()[0].emotes).toHaveLength(1);
		});
	});
});
