import type {
	EventTimeline,
	MatrixClient,
	MatrixEvent,
	Room,
} from "matrix-js-sdk";
import {
	MatrixEventEvent,
	RoomEvent,
	THREAD_RELATION_TYPE,
} from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncState } from "../../client/client";
import type { SummariesStore } from "../../client/summaries";
import { NOTIFY_CHANNEL_NAME } from "../../lib/notifyChannel";

const mocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	playNotificationSound: vi.fn(),
	primeAudioContext: vi.fn(),
	settings: {
		desktopNotifications: true,
		notificationSound: true,
	},
}));

vi.mock("@solidjs/router", () => ({
	useNavigate: () => mocks.navigate,
}));

vi.mock("../../stores/settings", () => ({
	userSettings: () => mocks.settings,
}));

vi.mock("./notificationSound", () => ({
	playNotificationSound: mocks.playNotificationSound,
	primeAudioContext: mocks.primeAudioContext,
}));

import { useNotifications } from "./useNotifications";

const ROOM_ID = "!room:example.com";
const ME = "@me:example.com";
const SENDER = "@sender:example.com";

interface EventState {
	eventId?: string;
	roomId?: string;
	sender?: string;
	type: string;
	content: Record<string, unknown>;
	decryptionFailure: boolean;
}

class FakeNotification {
	static permission: NotificationPermission = "granted";
	static instances: FakeNotification[] = [];

	onclick: (() => void) | null = null;
	onclose: (() => void) | null = null;
	readonly close = vi.fn(() => this.onclose?.());

	constructor(
		readonly title: string,
		readonly options?: NotificationOptions,
	) {
		FakeNotification.instances.push(this);
	}
}

class FakeBroadcastChannel {
	static instances: FakeBroadcastChannel[] = [];

	onmessage: ((event: MessageEvent) => void) | null = null;
	readonly postMessage = vi.fn();
	readonly close = vi.fn();

	constructor(readonly name: string) {
		FakeBroadcastChannel.instances.push(this);
	}

	emit(data: unknown): void {
		this.onmessage?.({ data } as MessageEvent);
	}
}

beforeEach(() => {
	mocks.navigate.mockReset();
	mocks.playNotificationSound.mockReset();
	mocks.primeAudioContext.mockReset();
	mocks.settings.desktopNotifications = true;
	mocks.settings.notificationSound = true;
	FakeNotification.permission = "granted";
	FakeNotification.instances = [];
	FakeBroadcastChannel.instances = [];
	vi.stubGlobal("Notification", FakeNotification);
	vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
	vi.spyOn(document, "hasFocus").mockReturnValue(false);
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	vi.spyOn(window, "focus").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function makeEvent(options: Partial<EventState> = {}) {
	const state: EventState = {
		eventId: "$event",
		roomId: ROOM_ID,
		sender: SENDER,
		type: "m.room.message",
		content: { msgtype: "m.text", body: "hello" },
		decryptionFailure: false,
		...options,
	};
	const event = {
		getId: () => state.eventId,
		getRoomId: () => state.roomId,
		getSender: () => state.sender,
		getType: () => state.type,
		getContent: () => state.content,
		isDecryptionFailure: () => state.decryptionFailure,
		isRelation: (relationType?: string) => {
			const relation = state.content["m.relates_to"] as
				| { rel_type?: string; event_id?: string }
				| undefined;
			return !!(
				relation?.rel_type &&
				relation.event_id &&
				(!relationType || relation.rel_type === relationType)
			);
		},
		get threadRootId(): string | undefined {
			const relation = state.content["m.relates_to"] as
				| { rel_type?: string; event_id?: string }
				| undefined;
			return relation?.rel_type === THREAD_RELATION_TYPE.name
				? relation.event_id
				: undefined;
		},
	} as unknown as MatrixEvent;
	return { event, state };
}

function makeRoom(options: { roomId?: string; name?: string | null } = {}) {
	return {
		roomId: options.roomId ?? ROOM_ID,
		name: options.name ?? "Test room",
		getMember: (userId: string) =>
			userId === SENDER ? { name: "Sender" } : null,
	} as unknown as Room;
}

function threadTimeline(): EventTimeline {
	return {
		getTimelineSet: () => ({ thread: {} }),
	} as unknown as EventTimeline;
}

function createClient(rooms = new Map([[ROOM_ID, makeRoom()]])) {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const getPushActionsForEvent = vi.fn(
		(): ReturnType<MatrixClient["getPushActionsForEvent"]> => ({
			notify: true,
			tweaks: { sound: "default", highlight: false },
		}),
	);
	const client = {
		getUserId: () => ME,
		getRoom: (roomId: string) => rooms.get(roomId) ?? null,
		getPushActionsForEvent,
		on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
			let set = listeners.get(name);
			if (!set) {
				set = new Set();
				listeners.set(name, set);
			}
			set.add(listener);
		}),
		removeListener: vi.fn(
			(name: string, listener: (...args: unknown[]) => void) => {
				listeners.get(name)?.delete(listener);
			},
		),
	} as unknown as MatrixClient;
	return {
		client,
		getPushActionsForEvent,
		emit(name: string, ...args: unknown[]) {
			for (const listener of listeners.get(name) ?? []) listener(...args);
		},
		listenerCount(name: string): number {
			return listeners.get(name)?.size ?? 0;
		},
	};
}

function mount(
	options: {
		client?: ReturnType<typeof createClient>;
		activeRoomId?: () => string | undefined;
		syncState?: () => AppSyncState;
		isDirect?: boolean;
	} = {},
) {
	const client = options.client ?? createClient();
	const summaries = {
		[ROOM_ID]: { isDirect: options.isDirect ?? false },
	} as unknown as SummariesStore;
	const root = createRoot((dispose) => {
		useNotifications(
			client.client,
			summaries,
			options.activeRoomId ?? (() => undefined),
			options.syncState ?? (() => "live"),
		);
		return { dispose };
	});
	return { ...root, ...client };
}

function emitLive(
	handle: ReturnType<typeof mount>,
	event: MatrixEvent,
	room: Room | undefined = makeRoom(),
	timeline?: EventTimeline,
): void {
	handle.emit(RoomEvent.Timeline, event, room, false, false, {
		liveEvent: true,
		timeline,
	});
}

describe("useNotifications event handling", () => {
	it("primes audio, subscribes, and cleans up listeners and browser resources", () => {
		const handle = mount();
		expect(mocks.primeAudioContext).toHaveBeenCalledTimes(1);
		expect(handle.listenerCount(RoomEvent.Timeline)).toBe(1);
		expect(handle.listenerCount(MatrixEventEvent.Decrypted)).toBe(1);
		expect(FakeBroadcastChannel.instances[0]?.name).toBe(NOTIFY_CHANNEL_NAME);

		emitLive(handle, makeEvent().event);
		const notification = FakeNotification.instances[0];
		expect(notification).toBeDefined();

		handle.dispose();
		expect(handle.listenerCount(RoomEvent.Timeline)).toBe(0);
		expect(handle.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
		expect(FakeBroadcastChannel.instances[0]?.close).toHaveBeenCalledTimes(1);
		expect(notification?.close).toHaveBeenCalledTimes(1);
	});

	it("ignores non-live, missing-room, own, active-room, and non-notify events", () => {
		let activeRoom: string | undefined;
		const handle = mount({ activeRoomId: () => activeRoom });
		const incoming = makeEvent().event;

		handle.emit(RoomEvent.Timeline, incoming, makeRoom(), false, false, {
			liveEvent: false,
		});
		handle.emit(RoomEvent.Timeline, incoming, undefined, false, false, {
			liveEvent: true,
		});
		emitLive(handle, makeEvent({ sender: ME }).event);
		activeRoom = ROOM_ID;
		emitLive(handle, incoming);
		activeRoom = undefined;
		handle.getPushActionsForEvent.mockReturnValueOnce({
			notify: false,
			tweaks: {},
		});
		emitLive(handle, makeEvent({ eventId: "$silent" }).event);

		expect(mocks.playNotificationSound).not.toHaveBeenCalled();
		expect(FakeNotification.instances).toHaveLength(0);
		handle.dispose();
	});

	it("rejects event shapes that the timeline would not render", () => {
		const handle = mount();
		const invalidPoll = {
			"m.poll.start": {
				question: { "m.text": "Question" },
				answers: [],
			},
		};
		const invalidEvents = [
			makeEvent({ eventId: "$state", type: "m.room.member" }).event,
			makeEvent({ eventId: "$redacted", content: {} }).event,
			makeEvent({
				eventId: "$edit",
				content: {
					msgtype: "m.text",
					body: "edited",
					"m.relates_to": { rel_type: "m.replace", event_id: "$original" },
				},
			}).event,
			makeEvent({
				eventId: "$poll",
				type: "m.poll.start",
				content: invalidPoll,
			}).event,
		];

		for (const event of invalidEvents) emitLive(handle, event);
		expect(handle.getPushActionsForEvent).not.toHaveBeenCalled();
		expect(mocks.playNotificationSound).not.toHaveBeenCalled();
		handle.dispose();
	});

	it("keeps bare notify events silent and popup-free", () => {
		const handle = mount();
		handle.getPushActionsForEvent.mockReturnValue({ notify: true, tweaks: {} });

		emitLive(handle, makeEvent().event);

		expect(mocks.playNotificationSound).not.toHaveBeenCalled();
		expect(FakeNotification.instances).toHaveLength(0);
		handle.dispose();
	});

	it("plays sound while focused but suppresses the desktop popup", () => {
		vi.mocked(document.hasFocus).mockReturnValue(true);
		const handle = mount();

		emitLive(handle, makeEvent().event);

		expect(mocks.playNotificationSound).toHaveBeenCalledTimes(1);
		expect(FakeNotification.instances).toHaveLength(0);
		handle.dispose();
	});

	it("creates a desktop notification and deduplicates repeated event emissions", () => {
		const room = makeRoom({ name: "\n" });
		const handle = mount({ client: createClient(new Map([[ROOM_ID, room]])) });
		const event = makeEvent().event;

		emitLive(handle, event, room);
		emitLive(handle, event, room);

		expect(FakeNotification.instances).toHaveLength(1);
		expect(FakeNotification.instances[0]).toMatchObject({
			title: "Room",
			options: {
				body: "Sender: hello",
				tag: ROOM_ID,
			},
		});
		expect(mocks.playNotificationSound).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("keeps sound independent of desktop setting and notification permission", () => {
		mocks.settings.desktopNotifications = false;
		FakeNotification.permission = "denied";
		const handle = mount();

		emitLive(handle, makeEvent().event);

		expect(mocks.playNotificationSound).toHaveBeenCalledTimes(1);
		expect(FakeNotification.instances).toHaveLength(0);
		handle.dispose();
	});

	it("deep-links a clicked direct-message thread notification", () => {
		const handle = mount({ isDirect: true });
		const event = makeEvent({
			content: {
				msgtype: "m.text",
				body: "thread reply",
				"m.relates_to": {
					rel_type: THREAD_RELATION_TYPE.name,
					event_id: "$root",
				},
			},
		}).event;

		emitLive(handle, event, makeRoom(), threadTimeline());
		FakeNotification.instances[0]?.onclick?.();

		expect(window.focus).toHaveBeenCalledTimes(1);
		expect(mocks.navigate).toHaveBeenCalledWith(
			`/dm/${encodeURIComponent(ROOM_ID)}?thread=${encodeURIComponent("$root")}`,
		);
		expect(FakeNotification.instances[0]?.close).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("drops non-reply events re-emitted by a thread timeline", () => {
		const handle = mount();
		emitLive(handle, makeEvent().event, makeRoom(), threadTimeline());

		expect(handle.getPushActionsForEvent).not.toHaveBeenCalled();
		expect(mocks.playNotificationSound).not.toHaveBeenCalled();
		handle.dispose();
	});

	it("defers encrypted events until decryption succeeds", () => {
		const handle = mount();
		const encrypted = makeEvent({
			type: "m.room.encrypted",
			content: {},
		});

		emitLive(handle, encrypted.event);
		expect(handle.getPushActionsForEvent).not.toHaveBeenCalled();

		encrypted.state.type = "m.room.message";
		encrypted.state.content = { msgtype: "m.text", body: "decrypted" };
		handle.emit(MatrixEventEvent.Decrypted, encrypted.event);
		expect(handle.getPushActionsForEvent).toHaveBeenCalledTimes(1);
		expect(mocks.playNotificationSound).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("processes an encrypted event that has already failed decryption", () => {
		const handle = mount();
		const event = makeEvent({
			type: "m.room.encrypted",
			content: {},
			decryptionFailure: true,
		}).event;

		emitLive(handle, event);

		expect(handle.getPushActionsForEvent).toHaveBeenCalledTimes(1);
		expect(mocks.playNotificationSound).toHaveBeenCalledTimes(1);
		handle.dispose();
	});
});

describe("useNotifications background-push coordination", () => {
	it("ignores malformed pings and confirms a live focused client", () => {
		vi.mocked(document.hasFocus).mockReturnValue(true);
		const handle = mount();
		const channel = FakeBroadcastChannel.instances[0];

		channel?.emit(null);
		channel?.emit({ type: "other", nonce: "n" });
		channel?.emit({ type: "ping", nonce: 42 });
		expect(channel?.postMessage).not.toHaveBeenCalled();

		channel?.emit({ type: "ping", nonce: "n", eventId: "$unknown" });
		expect(channel?.postMessage).toHaveBeenCalledWith({
			type: "pong",
			nonce: "n",
			canNotify: true,
		});
		handle.dispose();
	});

	it("confirms an unfocused event only after the app surfaced its popup", () => {
		const handle = mount();
		const channel = FakeBroadcastChannel.instances[0];

		channel?.emit({ type: "ping", nonce: "before", eventId: "$event" });
		expect(channel?.postMessage).toHaveBeenLastCalledWith({
			type: "pong",
			nonce: "before",
			canNotify: false,
		});

		emitLive(handle, makeEvent().event);
		channel?.emit({ type: "ping", nonce: "after", eventId: "$event" });
		expect(channel?.postMessage).toHaveBeenLastCalledWith({
			type: "pong",
			nonce: "after",
			canNotify: true,
		});
		handle.dispose();
	});

	it("never confirms before live sync and tolerates a failed reply", () => {
		const handle = mount({ syncState: () => "initial" });
		const channel = FakeBroadcastChannel.instances[0];
		channel?.postMessage.mockImplementation(() => {
			throw new Error("restricted");
		});

		expect(() =>
			channel?.emit({ type: "ping", nonce: "n", eventId: "$event" }),
		).not.toThrow();
		expect(channel?.postMessage).toHaveBeenCalledWith({
			type: "pong",
			nonce: "n",
			canNotify: false,
		});
		handle.dispose();
	});
});
