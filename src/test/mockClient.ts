/**
 * Lightweight mock for matrix-js-sdk MatrixClient.
 * Only stubs the methods used by useTimeline and TimelineView.
 * Extend as needed for other test files.
 */

import { vi } from "vitest";

/** Minimal MatrixEvent-like object for testing. */
export interface MockEvent {
	eventId: string;
	roomId: string;
	sender: string;
	type: string;
	content: Record<string, unknown>;
	ts: number;
	encrypted?: boolean;
	decryptionFailure?: boolean;
	replacingEventId?: string;
}

function createMatrixEvent(evt: MockEvent) {
	return {
		getId: () => evt.eventId,
		getRoomId: () => evt.roomId,
		getSender: () => evt.sender,
		getType: () => evt.type,
		getContent: () => evt.content,
		getTs: () => evt.ts,
		isEncrypted: () => evt.encrypted ?? false,
		isDecryptionFailure: () => evt.decryptionFailure ?? false,
		replacingEventId: () => evt.replacingEventId ?? null,
		event: { redacts: undefined },
	};
}

export function createMockRoom(
	roomId: string,
	events: MockEvent[] = [],
	members: {
		userId: string;
		name: string;
		typing?: boolean;
		membership?: string;
		powerLevel?: number;
		avatarUrl?: string;
	}[] = [],
) {
	const matrixEvents = events.map(createMatrixEvent);
	// Mutable member state for typing simulation
	const memberState = members.map((m) => ({
		userId: m.userId,
		name: m.name,
		roomId,
		typing: m.typing ?? false,
		membership: m.membership ?? "join",
		powerLevel: m.powerLevel ?? 0,
		getMxcAvatarUrl: () => m.avatarUrl ?? undefined,
	}));
	// Configurable read receipt positions per user
	const readUpTo = new Map<string, string | null>();

	const timeline = {
		getEvents: () => matrixEvents,
		getPaginationToken: () => null as string | null,
	};

	return {
		roomId,
		getLiveTimeline: () => timeline,
		getUnfilteredTimelineSet: () => ({
			relations: {
				getChildEventsForEvent: () => null,
			},
		}),
		getEventReadUpTo: (userId: string, _ignoreSynthesized?: boolean) =>
			readUpTo.get(userId) ?? null,
		getMember: (userId: string) => {
			const m = memberState.find((m) => m.userId === userId);
			return m ?? null;
		},
		getJoinedMembers: () => memberState.filter((m) => m.membership === "join"),
		getMembers: () => [...memberState],

		// Test helpers
		__setReadUpTo: (userId: string, eventId: string | null) => {
			readUpTo.set(userId, eventId);
		},
		__setTyping: (userId: string, typing: boolean) => {
			const m = memberState.find((m) => m.userId === userId);
			if (m) m.typing = typing;
		},
	};
}

export function createMockClient(
	rooms: Map<string, ReturnType<typeof createMockRoom>> = new Map(),
) {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	const client = {
		getUserId: () => "@test:example.com",
		getDeviceId: () => "TESTDEVICE",
		getRoom: (roomId: string) => rooms.get(roomId) ?? null,
		getVisibleRooms: () => Array.from(rooms.values()),
		mxcUrlToHttp: (
			mxcUrl: string,
			_w?: number,
			_h?: number,
			_method?: string,
		) =>
			mxcUrl.replace(
				"mxc://",
				"https://example.com/_matrix/media/v3/download/",
			),
		sendMessage: vi.fn().mockResolvedValue({ event_id: "$sent" }),
		sendEvent: vi.fn().mockResolvedValue({ event_id: "$sent" }),
		sendTyping: vi.fn().mockResolvedValue(undefined),
		sendReadReceipt: vi.fn().mockResolvedValue(undefined),
		redactEvent: vi.fn().mockResolvedValue(undefined),
		paginateEventTimeline: vi.fn().mockResolvedValue(false),
		getAccountData: () => null,
		getHomeserverUrl: () => "https://example.com",
		on: (event: string, handler: (...args: unknown[]) => void) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
			return client;
		},
		off: (event: string, handler: (...args: unknown[]) => void) => {
			listeners.get(event)?.delete(handler);
			return client;
		},
		removeListener: (event: string, handler: (...args: unknown[]) => void) => {
			listeners.get(event)?.delete(handler);
			return client;
		},

		// Test helper: emit an event to registered listeners
		__emit: (event: string, ...args: unknown[]) => {
			const handlers = listeners.get(event);
			if (handlers) {
				for (const handler of handlers) handler(...args);
			}
		},

		// Test helper: update the rooms map
		__setRooms: (newRooms: Map<string, ReturnType<typeof createMockRoom>>) => {
			rooms = newRooms;
			// Update getRoom/getVisibleRooms closures
			client.getRoom = (roomId: string) => rooms.get(roomId) ?? null;
			client.getVisibleRooms = () => Array.from(rooms.values());
		},
	};

	return client;
}

/** Helper: create a simple text message event */
export function textMessage(
	roomId: string,
	eventId: string,
	sender: string,
	body: string,
	ts = Date.now(),
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: "m.room.message",
		content: { msgtype: "m.text", body },
		ts,
	};
}

/** Helper: create an encrypted event */
export function encryptedMessage(
	roomId: string,
	eventId: string,
	sender: string,
	ts = Date.now(),
	decryptionFailure = false,
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: decryptionFailure ? "m.room.encrypted" : "m.room.message",
		content: decryptionFailure
			? {}
			: { msgtype: "m.text", body: "decrypted text" },
		ts,
		encrypted: true,
		decryptionFailure,
	};
}
